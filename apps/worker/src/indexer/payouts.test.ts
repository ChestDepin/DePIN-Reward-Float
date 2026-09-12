import { parseRewardNetworks, solanaAddressSchema } from '@drf/shared/schemas'
import { describe, expect, it } from 'vitest'
import { historyWindowStart, indexPayouts, readIncomingTransfers } from './payouts.ts'

const HONEY_MINT = 'B55r1aQEJhL8xba9ncHHrY7w2tsykbtewac2uYUmgLyP'
const HNT_MINT = 'Da5nJidcBhY7Ae6qCJTkJ3yDeGJkMjhURA5Ny9QEDTne'
const HIVEMAPPER_AUTHORITY = 'G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7'
const HELIUM_DISTRIBUTOR = 'GqzFuskZTGHjVWKFid1J45FfbWYWCikuHnjP1viPrUx'
const OPERATOR = '61G2U72VLHjSsAvTArQwb2Wg7vaVkVoEzPN8sdgxBLde'
const OPERATOR_TOKEN_ACCOUNT = '2RZMt9LwzUzSUNfprdLSUF33gS2Y3EJL3jqN6g6a9oP1'
const STRANGER = '9axh44i2g6U3q4KZxG9ieH4Z8Khx4N8npn4hWotr8zeZ'
const ANOTHER_SENDER = 'DAfMe2NyHFfCgsqa2PgrUaVHouLKmkY7FRdNirhXavLz'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const SIGNATURES = [
  'mHhyPe2Am14FUfW89ak1Hut2cALVwKTtK3iKxomPkpamC7B17HTknFAgoSwT7zpz3shFoXhugio8pjPb9eRS6Ca',
  '2WMyoJh7W6GFmv4dA8yiv62VXZSZKUcysyVVGAEp4pYgJsA4yK4mcT8w4QZmeGWExdX1EuNq9gGeMbSGmU6pUaZM',
  '3FSFdDkCqRXTJMTkC8NefDfhPLx3hMEh9M3JSx3YaAxnBQSNnPcLxYNVe6ALkk7DRt82QSVP9SAF8QY3C2bANmcp',
] as const

// Так платять насправді: Hivemapper карбує винагороду в мить виплати й
// відправника не має взагалі, Helium переказує її з акаунта розподільника.
const networks = parseRewardNetworks([
  {
    id: 'hivemapper',
    displayName: 'Hivemapper',
    token: { mint: HONEY_MINT, symbol: 'HONEY', decimals: 9 },
    payoutSources: [{ kind: 'mint', address: HIVEMAPPER_AUTHORITY }],
    payoutCadence: 'weekly',
  },
  {
    id: 'helium',
    displayName: 'Helium',
    token: { mint: HNT_MINT, symbol: 'HNT', decimals: 8 },
    payoutSources: [{ kind: 'transfer', address: HELIUM_DISTRIBUTOR }],
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

const mintTo = (authority: string, mint: string, amount: string) => ({
  program: 'spl-token',
  programId: TOKEN_PROGRAM,
  parsed: {
    type: 'mintTo',
    info: { account: OPERATOR_TOKEN_ACCOUNT, amount, mint, mintAuthority: authority },
  },
})

type TransactionOptions = {
  slot?: number
  blockTime?: number | null
  pre?: Balance[]
  post?: Balance[]
  err?: unknown
  instructions?: unknown[]
  inner?: unknown[]
}

const transaction = ({
  slot = 442_918_004,
  blockTime = AUGUST,
  pre = [],
  post = [],
  err = null,
  instructions = [],
  inner = [],
}: TransactionOptions = {}) => ({
  slot,
  blockTime,
  transaction: { message: { instructions } },
  meta: {
    err,
    preTokenBalances: pre,
    postTokenBalances: post,
    innerInstructions: inner.length === 0 ? [] : [{ index: 2, instructions: inner }],
  },
})

// Емісія: жодного акаунта з від'ємною дельтою в транзакції немає, джерело
// читається з інструкції. Саме ця форма не розпізнавалась до T023c.
const emission = (options: TransactionOptions = {}) =>
  transaction({
    pre: [balance(2, OPERATOR, HONEY_MINT, '10')],
    post: [balance(2, OPERATOR, HONEY_MINT, '4010')],
    inner: [mintTo(HIVEMAPPER_AUTHORITY, HONEY_MINT, '4000')],
    ...options,
  })

const transfer = (options: TransactionOptions = {}) =>
  transaction({
    pre: [balance(1, HELIUM_DISTRIBUTOR, HNT_MINT, '900'), balance(2, OPERATOR, HNT_MINT, '10')],
    post: [balance(1, HELIUM_DISTRIBUTOR, HNT_MINT, '400'), balance(2, OPERATOR, HNT_MINT, '510')],
    ...options,
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
  it('reads what the operator received in a transfer, in minimal units, and who sent it', () => {
    const transfers = readIncomingTransfers(transfer(), wallet, SIGNATURES[0])

    expect(transfers).toEqual([
      expect.objectContaining({
        signature: SIGNATURES[0],
        via: 'transfer',
        source: HELIUM_DISTRIBUTOR,
        destination: OPERATOR,
        mint: HNT_MINT,
        amount: 500n,
        slot: 442_918_004n,
      }),
    ])
  })

  it('reads a minted reward and names the mint authority as its source', () => {
    const transfers = readIncomingTransfers(emission(), wallet, SIGNATURES[0])

    expect(transfers).toEqual([
      expect.objectContaining({
        via: 'mint',
        source: HIVEMAPPER_AUTHORITY,
        destination: OPERATOR,
        mint: HONEY_MINT,
        amount: 4000n,
      }),
    ])
  })

  it('reads a reward minted by a top-level instruction, not only through a CPI', () => {
    const transfers = readIncomingTransfers(
      emission({ inner: [], instructions: [mintTo(HIVEMAPPER_AUTHORITY, HONEY_MINT, '4000')] }),
      wallet,
      SIGNATURES[0],
    )

    expect(transfers[0]?.source).toBe(HIVEMAPPER_AUTHORITY)
  })

  it('reads mintToChecked the same way', () => {
    const checked = {
      ...mintTo(HIVEMAPPER_AUTHORITY, HONEY_MINT, '4000'),
      parsed: {
        type: 'mintToChecked',
        info: {
          account: OPERATOR_TOKEN_ACCOUNT,
          mint: HONEY_MINT,
          mintAuthority: HIVEMAPPER_AUTHORITY,
        },
      },
    }

    expect(readIncomingTransfers(emission({ inner: [checked] }), wallet, SIGNATURES[0])[0]?.via)
      .toBe('mint')
  })

  // Виплата Hivemapper карбується двічі — водієві та фліт-менеджеру, — і в
  // транзакції це дві інструкції з тим самим авторитетом.
  it('takes two mints by one authority as a single arrival of the net amount', () => {
    const transfers = readIncomingTransfers(
      emission({
        inner: [
          mintTo(HIVEMAPPER_AUTHORITY, HONEY_MINT, '3000'),
          mintTo(HIVEMAPPER_AUTHORITY, HONEY_MINT, '1000'),
        ],
      }),
      wallet,
      SIGNATURES[0],
    )

    expect(transfers).toHaveLength(1)
    expect(transfers[0]?.amount).toBe(4000n)
  })

  it('reads nothing when two authorities mint the same token in one transaction', () => {
    const transfers = readIncomingTransfers(
      emission({
        inner: [
          mintTo(HIVEMAPPER_AUTHORITY, HONEY_MINT, '3000'),
          mintTo(ANOTHER_SENDER, HONEY_MINT, '1000'),
        ],
      }),
      wallet,
      SIGNATURES[0],
    )

    expect(transfers).toEqual([])
  })

  // Переказ і емісія в одній транзакції роблять джерело неоднозначним так само,
  // як двоє відправників: приписати надходження одному з них — здогадка.
  it('reads nothing when the token both arrives by transfer and is minted', () => {
    const transfers = readIncomingTransfers(
      emission({
        pre: [balance(1, ANOTHER_SENDER, HONEY_MINT, '900'), balance(2, OPERATOR, HONEY_MINT, '10')],
        post: [
          balance(1, ANOTHER_SENDER, HONEY_MINT, '400'),
          balance(2, OPERATOR, HONEY_MINT, '4510'),
        ],
      }),
      wallet,
      SIGNATURES[0],
    )

    expect(transfers).toEqual([])
  })

  it('ignores a mint of another token when reading what arrived', () => {
    const transfers = readIncomingTransfers(
      emission({
        inner: [
          mintTo(HIVEMAPPER_AUTHORITY, HONEY_MINT, '4000'),
          mintTo(ANOTHER_SENDER, HNT_MINT, '7'),
        ],
      }),
      wallet,
      SIGNATURES[0],
    )

    expect(transfers).toEqual([
      expect.objectContaining({ mint: HONEY_MINT, source: HIVEMAPPER_AUTHORITY }),
    ])
  })

  it('reads nothing from an arrival it cannot attribute to any source', () => {
    expect(readIncomingTransfers(emission({ inner: [] }), wallet, SIGNATURES[0])).toEqual([])
  })

  it('reads nothing from a mint whose authority the node did not report', () => {
    const anonymous = {
      program: 'spl-token',
      programId: TOKEN_PROGRAM,
      parsed: {
        type: 'mintTo',
        info: { account: OPERATOR_TOKEN_ACCOUNT, amount: '4000', mint: HONEY_MINT },
      },
    }

    expect(readIncomingTransfers(emission({ inner: [anonymous] }), wallet, SIGNATURES[0])).toEqual(
      [],
    )
  })

  it('counts a token account opened by this very transaction, which has no prior balance', () => {
    const transfers = readIncomingTransfers(
      transfer({
        pre: [balance(1, HELIUM_DISTRIBUTOR, HNT_MINT, '900')],
        post: [
          balance(1, HELIUM_DISTRIBUTOR, HNT_MINT, '400'),
          balance(2, OPERATOR, HNT_MINT, '500'),
        ],
      }),
      wallet,
      SIGNATURES[0],
    )

    expect(transfers[0]?.amount).toBe(500n)
  })

  it('reads nothing from a transaction that only takes the token away', () => {
    const transfers = readIncomingTransfers(
      transfer({
        pre: [balance(2, OPERATOR, HNT_MINT, '4000')],
        post: [balance(2, OPERATOR, HNT_MINT, '1000')],
      }),
      wallet,
      SIGNATURES[0],
    )

    expect(transfers).toEqual([])
  })

  it('reads nothing when two senders of the same token make the source ambiguous', () => {
    const transfers = readIncomingTransfers(
      transfer({
        pre: [
          balance(1, HELIUM_DISTRIBUTOR, HNT_MINT, '900'),
          balance(3, ANOTHER_SENDER, HNT_MINT, '900'),
          balance(2, OPERATOR, HNT_MINT, '0'),
        ],
        post: [
          balance(1, HELIUM_DISTRIBUTOR, HNT_MINT, '700'),
          balance(3, ANOTHER_SENDER, HNT_MINT, '700'),
          balance(2, OPERATOR, HNT_MINT, '400'),
        ],
      }),
      wallet,
      SIGNATURES[0],
    )

    expect(transfers).toEqual([])
  })

  it('reads nothing from a failed transaction', () => {
    expect(
      readIncomingTransfers(emission({ err: { InstructionError: [0, 'x'] } }), wallet, SIGNATURES[0]),
    ).toEqual([])
  })

  it('reads nothing from a transaction with no block time: it cannot be placed in a month', () => {
    expect(readIncomingTransfers(emission({ blockTime: null }), wallet, SIGNATURES[0])).toEqual([])
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
        [SIGNATURES[0]]: emission(),
        [SIGNATURES[1]]: transfer({ slot: 442_000_000, blockTime: AUGUST - 86_400 }),
      },
    )

    const payouts = await indexPayouts({ wallet, networks, rpc, now: NOW, pageSize: 1 })

    expect(payouts.map((payout) => payout.networkId)).toEqual(['hivemapper', 'helium'])
    expect(payouts[0]?.amount).toBe(4000n)
    expect(payouts[0]?.source).toBe(HIVEMAPPER_AUTHORITY)
    expect(payouts[1]?.source).toBe(HELIUM_DISTRIBUTOR)
  })

  it('ignores the same token minted by a stranger', async () => {
    const { rpc } = fakeRpc([{ signature: SIGNATURES[0], slot: 1, blockTime: AUGUST }], {
      [SIGNATURES[0]]: emission({ inner: [mintTo(STRANGER, HONEY_MINT, '4000')] }),
    })

    expect(await indexPayouts({ wallet, networks, rpc, now: NOW })).toEqual([])
  })

  it('ignores the same token sent by a stranger', async () => {
    const { rpc } = fakeRpc([{ signature: SIGNATURES[0], slot: 1, blockTime: AUGUST }], {
      [SIGNATURES[0]]: transfer({
        pre: [balance(1, STRANGER, HNT_MINT, '900'), balance(2, OPERATOR, HNT_MINT, '10')],
        post: [balance(1, STRANGER, HNT_MINT, '400'), balance(2, OPERATOR, HNT_MINT, '510')],
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
        [SIGNATURES[0]]: emission(),
        [SIGNATURES[1]]: emission({ blockTime: A_YEAR_AND_A_HALF_AGO }),
        [SIGNATURES[2]]: emission({ blockTime: A_YEAR_AND_A_HALF_AGO - 86_400 }),
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
      { [SIGNATURES[0]]: emission() },
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

  it('stops at the signature the previous pass ended on', async () => {
    const { rpc, fetched } = fakeRpc(
      [
        { signature: SIGNATURES[0], slot: 442_918_004, blockTime: AUGUST },
        { signature: SIGNATURES[1], slot: 442_000_000, blockTime: AUGUST - 86_400 },
      ],
      { [SIGNATURES[0]]: emission(), [SIGNATURES[1]]: emission() },
    )

    const payouts = await indexPayouts({
      wallet,
      networks,
      rpc,
      now: NOW,
      pageSize: 1,
      until: SIGNATURES[1],
    })

    expect(payouts).toHaveLength(1)
    expect(fetched).toEqual([SIGNATURES[0]])
  })
})
