import { parseRewardNetworks, solanaAddressSchema } from '@drf/shared/schemas'
import { describe, expect, it } from 'vitest'
import { historyWindowStart, indexPayouts, readIncomingTransfers } from './payouts.ts'

const HONEY_MINT = 'B55r1aQEJhL8xba9ncHHrY7w2tsykbtewac2uYUmgLyP'
const HNT_MINT = 'Da5nJidcBhY7Ae6qCJTkJ3yDeGJkMjhURA5Ny9QEDTne'
const HIVEMAPPER_DISTRIBUTOR = 'G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7'
const HELIUM_DISTRIBUTOR = 'GqzFuskZTGHjVWKFid1J45FfbWYWCikuHnjP1viPrUx'
const OPERATOR = '61G2U72VLHjSsAvTArQwb2Wg7vaVkVoEzPN8sdgxBLde'
const STRANGER = '9axh44i2g6U3q4KZxG9ieH4Z8Khx4N8npn4hWotr8zeZ'
const ANOTHER_SENDER = 'DAfMe2NyHFfCgsqa2PgrUaVHouLKmkY7FRdNirhXavLz'

const SIGNATURES = [
  'mHhyPe2Am14FUfW89ak1Hut2cALVwKTtK3iKxomPkpamC7B17HTknFAgoSwT7zpz3shFoXhugio8pjPb9eRS6Ca',
  '2WMyoJh7W6GFmv4dA8yiv62VXZSZKUcysyVVGAEp4pYgJsA4yK4mcT8w4QZmeGWExdX1EuNq9gGeMbSGmU6pUaZM',
  '3FSFdDkCqRXTJMTkC8NefDfhPLx3hMEh9M3JSx3YaAxnBQSNnPcLxYNVe6ALkk7DRt82QSVP9SAF8QY3C2bANmcp',
] as const

const networks = parseRewardNetworks([
  {
    id: 'hivemapper',
    displayName: 'Hivemapper',
    token: { mint: HONEY_MINT, symbol: 'HONEY', decimals: 9 },
    distributors: [HIVEMAPPER_DISTRIBUTOR],
    payoutCadence: 'weekly',
  },
  {
    id: 'helium',
    displayName: 'Helium',
    token: { mint: HNT_MINT, symbol: 'HNT', decimals: 8 },
    distributors: [HELIUM_DISTRIBUTOR],
    payoutCadence: 'daily',
  },
])

const wallet = solanaAddressSchema.parse(OPERATOR)
const NOW = new Date('2026-08-30T14:02:00.000Z')

const AUGUST = 1_787_961_600
const A_YEAR_AND_A_HALF_AGO = 1_740_614_400

type Balance = {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount: { amount: string }
}

const balance = (accountIndex: number, owner: string, mint: string, amount: string): Balance => ({
  accountIndex,
  mint,
  owner,
  uiTokenAmount: { amount },
})

type TransactionOptions = {
  slot?: number
  blockTime?: number | null
  pre?: Balance[]
  post?: Balance[]
  err?: unknown
}

const transaction = ({
  slot = 442_918_004,
  blockTime = AUGUST,
  pre = [
    balance(1, HIVEMAPPER_DISTRIBUTOR, HONEY_MINT, '9000'),
    balance(2, OPERATOR, HONEY_MINT, '10'),
  ],
  post = [
    balance(1, HIVEMAPPER_DISTRIBUTOR, HONEY_MINT, '5000'),
    balance(2, OPERATOR, HONEY_MINT, '4010'),
  ],
  err = null,
}: TransactionOptions = {}) => ({
  slot,
  blockTime,
  meta: { err, preTokenBalances: pre, postTokenBalances: post },
})

type SignatureInfo = { signature: string; slot: number; blockTime: number | null; err?: unknown }

const fakeRpc = (signatures: SignatureInfo[], transactions: Record<string, unknown>) => {
  const fetched: string[] = []

  return {
    fetched,
    rpc: {
      listSignatures: ({ before, limit }: { before: string | null; limit: number }) => {
        const start = before === null ? 0 : signatures.findIndex((s) => s.signature === before) + 1
        return Promise.resolve(signatures.slice(start, start + limit))
      },
      getTransaction: (signature: string) => {
        fetched.push(signature)
        return Promise.resolve(transactions[signature] ?? null)
      },
    },
  }
}

describe('historyWindowStart', () => {
  it('opens the window twelve months back', () => {
    expect(historyWindowStart(NOW).toISOString()).toBe('2025-08-30T14:02:00.000Z')
  })
})

describe('readIncomingTransfers', () => {
  it('reads what the operator received, in minimal units, and who sent it', () => {
    const transfers = readIncomingTransfers(transaction(), wallet, SIGNATURES[0])

    expect(transfers).toEqual([
      expect.objectContaining({
        signature: SIGNATURES[0],
        source: HIVEMAPPER_DISTRIBUTOR,
        destination: OPERATOR,
        mint: HONEY_MINT,
        amount: 4000n,
        slot: 442_918_004n,
      }),
    ])
  })

  it('counts a token account opened by this very transaction, which has no prior balance', () => {
    const transfers = readIncomingTransfers(
      transaction({
        pre: [balance(1, HIVEMAPPER_DISTRIBUTOR, HONEY_MINT, '9000')],
        post: [
          balance(1, HIVEMAPPER_DISTRIBUTOR, HONEY_MINT, '5000'),
          balance(2, OPERATOR, HONEY_MINT, '4000'),
        ],
      }),
      wallet,
      SIGNATURES[0],
    )

    expect(transfers[0]?.amount).toBe(4000n)
  })

  it('reads nothing from a transaction that only takes the token away', () => {
    const transfers = readIncomingTransfers(
      transaction({
        pre: [balance(2, OPERATOR, HONEY_MINT, '4000')],
        post: [balance(2, OPERATOR, HONEY_MINT, '1000')],
      }),
      wallet,
      SIGNATURES[0],
    )

    expect(transfers).toEqual([])
  })

  it('reads nothing when two senders of the same token make the source ambiguous', () => {
    const transfers = readIncomingTransfers(
      transaction({
        pre: [
          balance(1, HIVEMAPPER_DISTRIBUTOR, HONEY_MINT, '9000'),
          balance(3, ANOTHER_SENDER, HONEY_MINT, '9000'),
          balance(2, OPERATOR, HONEY_MINT, '0'),
        ],
        post: [
          balance(1, HIVEMAPPER_DISTRIBUTOR, HONEY_MINT, '7000'),
          balance(3, ANOTHER_SENDER, HONEY_MINT, '7000'),
          balance(2, OPERATOR, HONEY_MINT, '4000'),
        ],
      }),
      wallet,
      SIGNATURES[0],
    )

    expect(transfers).toEqual([])
  })

  it('reads nothing from a failed transaction', () => {
    expect(
      readIncomingTransfers(
        transaction({ err: { InstructionError: [0, 'x'] } }),
        wallet,
        SIGNATURES[0],
      ),
    ).toEqual([])
  })

  it('reads nothing from a transaction with no block time: it cannot be placed in a month', () => {
    expect(readIncomingTransfers(transaction({ blockTime: null }), wallet, SIGNATURES[0])).toEqual(
      [],
    )
  })

  it('rejects a response that is not a transaction', () => {
    expect(() => readIncomingTransfers({ meta: 'nope' }, wallet, SIGNATURES[0])).toThrow()
  })
})

describe('indexPayouts', () => {
  it('walks the pages and returns the recognised payouts', async () => {
    const { rpc } = fakeRpc(
      [
        { signature: SIGNATURES[0], slot: 442_918_004, blockTime: AUGUST },
        { signature: SIGNATURES[1], slot: 442_000_000, blockTime: AUGUST - 86_400 },
      ],
      {
        [SIGNATURES[0]]: transaction(),
        [SIGNATURES[1]]: transaction({
          slot: 442_000_000,
          blockTime: AUGUST - 86_400,
          pre: [
            balance(1, HELIUM_DISTRIBUTOR, HNT_MINT, '900'),
            balance(2, OPERATOR, HNT_MINT, '0'),
          ],
          post: [
            balance(1, HELIUM_DISTRIBUTOR, HNT_MINT, '400'),
            balance(2, OPERATOR, HNT_MINT, '500'),
          ],
        }),
      },
    )

    const payouts = await indexPayouts({ wallet, networks, rpc, now: NOW, pageSize: 1 })

    expect(payouts.map((payout) => payout.networkId)).toEqual(['hivemapper', 'helium'])
    expect(payouts[0]?.amount).toBe(4000n)
    expect(payouts[1]?.distributor).toBe(HELIUM_DISTRIBUTOR)
  })

  it('ignores the same token sent by a stranger', async () => {
    const { rpc } = fakeRpc([{ signature: SIGNATURES[0], slot: 1, blockTime: AUGUST }], {
      [SIGNATURES[0]]: transaction({
        pre: [balance(1, STRANGER, HONEY_MINT, '9000'), balance(2, OPERATOR, HONEY_MINT, '0')],
        post: [balance(1, STRANGER, HONEY_MINT, '5000'), balance(2, OPERATOR, HONEY_MINT, '4000')],
      }),
    })

    expect(await indexPayouts({ wallet, networks, rpc, now: NOW })).toEqual([])
  })

  it('stops at the twelve-month boundary and does not read older transactions', async () => {
    const { rpc, fetched } = fakeRpc(
      [
        { signature: SIGNATURES[0], slot: 442_918_004, blockTime: AUGUST },
        { signature: SIGNATURES[1], slot: 300_000_000, blockTime: A_YEAR_AND_A_HALF_AGO },
        { signature: SIGNATURES[2], slot: 299_000_000, blockTime: A_YEAR_AND_A_HALF_AGO - 86_400 },
      ],
      {
        [SIGNATURES[0]]: transaction(),
        [SIGNATURES[1]]: transaction({ blockTime: A_YEAR_AND_A_HALF_AGO }),
        [SIGNATURES[2]]: transaction({ blockTime: A_YEAR_AND_A_HALF_AGO - 86_400 }),
      },
    )

    const payouts = await indexPayouts({ wallet, networks, rpc, now: NOW, pageSize: 1 })

    expect(payouts).toHaveLength(1)
    expect(fetched).toEqual([SIGNATURES[0]])
  })

  it('does not read a failed transaction at all', async () => {
    const { rpc, fetched } = fakeRpc(
      [
        {
          signature: SIGNATURES[0],
          slot: 1,
          blockTime: AUGUST,
          err: { InstructionError: [0, 'x'] },
        },
      ],
      { [SIGNATURES[0]]: transaction() },
    )

    expect(await indexPayouts({ wallet, networks, rpc, now: NOW })).toEqual([])
    expect(fetched).toEqual([])
  })

  it('skips a signature the node no longer has a transaction for', async () => {
    const { rpc } = fakeRpc([{ signature: SIGNATURES[0], slot: 1, blockTime: AUGUST }], {})

    expect(await indexPayouts({ wallet, networks, rpc, now: NOW })).toEqual([])
  })

  it('returns nothing for a wallet with no signatures', async () => {
    const { rpc } = fakeRpc([], {})

    expect(await indexPayouts({ wallet, networks, rpc, now: NOW })).toEqual([])
  })
})
