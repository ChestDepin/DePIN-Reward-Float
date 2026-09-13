import { parseRewardNetworks, solanaAddressSchema } from '@drf/shared/schemas'
import { describe, expect, it } from 'vitest'
import { historyWindowStart, indexPayouts, readIncomingTransfers } from './payouts.ts'

const HONEY_MINT = 'B55r1aQEJhL8xba9ncHHrY7w2tsykbtewac2uYUmgLyP'
const HNT_MINT = 'Da5nJidcBhY7Ae6qCJTkJ3yDeGJkMjhURA5Ny9QEDTne'
const HIVEMAPPER_AUTHORITY = 'G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7'
const HELIUM_DISTRIBUTOR = 'GqzFuskZTGHjVWKFid1J45FfbWYWCikuHnjP1viPrUx'
const OPERATOR = '61G2U72VLHjSsAvTArQwb2Wg7vaVkVoEzPN8sdgxBLde'
const OPERATOR_TOKEN_ACCOUNT = '2RZMt9LwzUzSUNfprdLSUF33gS2Y3EJL3jqN6g6a9oP1'
const OPERATOR_HNT_ACCOUNT = '4eMFVUTGYtrBYzKGm3jeX58GoKhno2SR3vuThCNrom4L'
const OPERATOR_SECOND_HONEY_ACCOUNT = 'JBifZzFnyHf3eZV5pwRAsbJf6M2ebijWVmbWWpczBC13'
const STRANGER = '9axh44i2g6U3q4KZxG9ieH4Z8Khx4N8npn4hWotr8zeZ'
const ANOTHER_SENDER = 'DAfMe2NyHFfCgsqa2PgrUaVHouLKmkY7FRdNirhXavLz'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const SIGNATURES = [
  'mHhyPe2Am14FUfW89ak1Hut2cALVwKTtK3iKxomPkpamC7B17HTknFAgoSwT7zpz3shFoXhugio8pjPb9eRS6Ca',
  '2WMyoJh7W6GFmv4dA8yiv62VXZSZKUcysyVVGAEp4pYgJsA4yK4mcT8w4QZmeGWExdX1EuNq9gGeMbSGmU6pUaZM',
  '3FSFdDkCqRXTJMTkC8NefDfhPLx3hMEh9M3JSx3YaAxnBQSNnPcLxYNVe6ALkk7DRt82QSVP9SAF8QY3C2bANmcp',
  '5ubkMKbUzXej87gJBkEQA1uX76Pe3JTSz7tTZVie6867iC8iMzsy82UUJbLk7QzMUhmdZW1yZhbuLTAUCSbL4m4D',
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

type FakeChain = {
  accounts: Record<string, string[]>
  signatures: Record<string, SignatureInfo[]>
  transactions: Record<string, unknown>
}

const fakeRpc = ({ accounts, signatures, transactions }: FakeChain) => {
  const fetched: string[] = []
  const listed: string[] = []
  const mintsAsked: string[] = []

  return {
    fetched,
    listed,
    mintsAsked,
    rpc: {
      listTokenAccounts: ({ owner, mint }: { owner: string; mint: string }) => {
        mintsAsked.push(mint)
        return Promise.resolve({
          value: (accounts[mint] ?? []).map((pubkey) => ({
            pubkey,
            account: { data: { parsed: { info: { mint, owner } } } },
          })),
        })
      },
      listSignatures: ({
        address,
        before,
        limit,
      }: {
        address: string
        before: string | null
        limit: number
      }) => {
        listed.push(address)
        const page = signatures[address] ?? []
        const start = before === null ? 0 : page.findIndex((s) => s.signature === before) + 1
        return Promise.resolve(page.slice(start, start + limit))
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

    expect(
      readIncomingTransfers(emission({ inner: [checked] }), wallet, SIGNATURES[0])[0]?.via,
    ).toBe('mint')
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
        pre: [
          balance(1, ANOTHER_SENDER, HONEY_MINT, '900'),
          balance(2, OPERATOR, HONEY_MINT, '10'),
        ],
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
      readIncomingTransfers(
        emission({ err: { InstructionError: [0, 'x'] } }),
        wallet,
        SIGNATURES[0],
      ),
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
  // Транзакція виплати Hivemapper не називає гаманця оператора взагалі — у
  // списку акаунтів лежить тільки його токен-акаунт. Пройти по гаманцю означає
  // не побачити такої виплати ніколи, і саме це ловить перевірка `listed`.
  it('lists signatures for the token accounts and never for the wallet itself', async () => {
    const { rpc, listed } = fakeRpc({
      accounts: { [HONEY_MINT]: [OPERATOR_TOKEN_ACCOUNT], [HNT_MINT]: [OPERATOR_HNT_ACCOUNT] },
      signatures: {
        [OPERATOR_TOKEN_ACCOUNT]: [
          { signature: SIGNATURES[0], slot: 442_918_004, blockTime: AUGUST },
        ],
      },
      transactions: { [SIGNATURES[0]]: emission() },
    })

    const { payouts } = await indexPayouts({ wallet, networks, rpc, now: NOW })

    expect(payouts).toHaveLength(1)
    expect(listed).toEqual([OPERATOR_TOKEN_ACCOUNT, OPERATOR_HNT_ACCOUNT])
    expect(listed).not.toContain(OPERATOR)
  })

  it('walks the pages and returns the recognised payouts', async () => {
    const { rpc } = fakeRpc({
      accounts: { [HONEY_MINT]: [OPERATOR_TOKEN_ACCOUNT], [HNT_MINT]: [OPERATOR_HNT_ACCOUNT] },
      signatures: {
        [OPERATOR_TOKEN_ACCOUNT]: [
          { signature: SIGNATURES[0], slot: 442_918_004, blockTime: AUGUST },
        ],
        [OPERATOR_HNT_ACCOUNT]: [
          { signature: SIGNATURES[1], slot: 442_000_000, blockTime: AUGUST - 86_400 },
        ],
      },
      transactions: {
        [SIGNATURES[0]]: emission(),
        [SIGNATURES[1]]: transfer({ slot: 442_000_000, blockTime: AUGUST - 86_400 }),
      },
    })

    const { payouts } = await indexPayouts({ wallet, networks, rpc, now: NOW, pageSize: 1 })

    expect(payouts.map((payout) => payout.networkId)).toEqual(['hivemapper', 'helium'])
    expect(payouts[0]?.amount).toBe(4000n)
    expect(payouts[0]?.source).toBe(HIVEMAPPER_AUTHORITY)
    expect(payouts[1]?.source).toBe(HELIUM_DISTRIBUTOR)
  })

  // Одного мінта на кількох токен-акаунтах вистачає, щоб та сама транзакція
  // потрапила у два списки. Прочитати її двічі означає порахувати виплату двічі
  // і завищити ліміт — помилка, яка не падає, а тихо додає грошей.
  it('reads a transaction once when two token accounts both list it', async () => {
    const { rpc, fetched } = fakeRpc({
      accounts: { [HONEY_MINT]: [OPERATOR_TOKEN_ACCOUNT, OPERATOR_SECOND_HONEY_ACCOUNT] },
      signatures: {
        [OPERATOR_TOKEN_ACCOUNT]: [
          { signature: SIGNATURES[0], slot: 442_918_004, blockTime: AUGUST },
        ],
        [OPERATOR_SECOND_HONEY_ACCOUNT]: [
          { signature: SIGNATURES[0], slot: 442_918_004, blockTime: AUGUST },
        ],
      },
      transactions: { [SIGNATURES[0]]: emission() },
    })

    const { payouts } = await indexPayouts({ wallet, networks, rpc, now: NOW })

    expect(fetched).toEqual([SIGNATURES[0]])
    expect(payouts).toHaveLength(1)
  })

  it('asks for the token accounts of every supported mint', async () => {
    const { rpc, mintsAsked } = fakeRpc({ accounts: {}, signatures: {}, transactions: {} })

    const { payouts } = await indexPayouts({ wallet, networks, rpc, now: NOW })

    expect(mintsAsked).toEqual([HONEY_MINT, HNT_MINT])
    expect(payouts).toEqual([])
  })

  it('returns nothing for an operator holding no token account at all', async () => {
    const { rpc, listed } = fakeRpc({ accounts: {}, signatures: {}, transactions: {} })

    const { payouts, cursors } = await indexPayouts({ wallet, networks, rpc, now: NOW })

    expect(payouts).toEqual([])
    expect(cursors).toEqual([])
    expect(listed).toEqual([])
  })

  it('ignores the same token minted by a stranger', async () => {
    const { rpc } = fakeRpc({
      accounts: { [HONEY_MINT]: [OPERATOR_TOKEN_ACCOUNT] },
      signatures: {
        [OPERATOR_TOKEN_ACCOUNT]: [{ signature: SIGNATURES[0], slot: 1, blockTime: AUGUST }],
      },
      transactions: {
        [SIGNATURES[0]]: emission({ inner: [mintTo(STRANGER, HONEY_MINT, '4000')] }),
      },
    })

    expect((await indexPayouts({ wallet, networks, rpc, now: NOW })).payouts).toEqual([])
  })

  it('ignores the same token sent by a stranger', async () => {
    const { rpc } = fakeRpc({
      accounts: { [HNT_MINT]: [OPERATOR_HNT_ACCOUNT] },
      signatures: {
        [OPERATOR_HNT_ACCOUNT]: [{ signature: SIGNATURES[0], slot: 1, blockTime: AUGUST }],
      },
      transactions: {
        [SIGNATURES[0]]: transfer({
          pre: [balance(1, STRANGER, HNT_MINT, '900'), balance(2, OPERATOR, HNT_MINT, '10')],
          post: [balance(1, STRANGER, HNT_MINT, '400'), balance(2, OPERATOR, HNT_MINT, '510')],
        }),
      },
    })

    expect((await indexPayouts({ wallet, networks, rpc, now: NOW })).payouts).toEqual([])
  })

  it('stops at the twelve-month boundary and does not read older transactions', async () => {
    const { rpc, fetched } = fakeRpc({
      accounts: { [HONEY_MINT]: [OPERATOR_TOKEN_ACCOUNT] },
      signatures: {
        [OPERATOR_TOKEN_ACCOUNT]: [
          { signature: SIGNATURES[0], slot: 442_918_004, blockTime: AUGUST },
          { signature: SIGNATURES[1], slot: 300_000_000, blockTime: A_YEAR_AND_A_HALF_AGO },
          {
            signature: SIGNATURES[2],
            slot: 299_000_000,
            blockTime: A_YEAR_AND_A_HALF_AGO - 86_400,
          },
        ],
      },
      transactions: {
        [SIGNATURES[0]]: emission(),
        [SIGNATURES[1]]: emission({ blockTime: A_YEAR_AND_A_HALF_AGO }),
        [SIGNATURES[2]]: emission({ blockTime: A_YEAR_AND_A_HALF_AGO - 86_400 }),
      },
    })

    const { payouts } = await indexPayouts({ wallet, networks, rpc, now: NOW, pageSize: 1 })

    expect(payouts).toHaveLength(1)
    expect(fetched).toEqual([SIGNATURES[0]])
  })

  it('does not read a failed transaction at all', async () => {
    const { rpc, fetched } = fakeRpc({
      accounts: { [HONEY_MINT]: [OPERATOR_TOKEN_ACCOUNT] },
      signatures: {
        [OPERATOR_TOKEN_ACCOUNT]: [
          {
            signature: SIGNATURES[0],
            slot: 1,
            blockTime: AUGUST,
            err: { InstructionError: [0, 'x'] },
          },
        ],
      },
      transactions: { [SIGNATURES[0]]: emission() },
    })

    expect((await indexPayouts({ wallet, networks, rpc, now: NOW })).payouts).toEqual([])
    expect(fetched).toEqual([])
  })

  it('skips a signature the node no longer has a transaction for', async () => {
    const { rpc } = fakeRpc({
      accounts: { [HONEY_MINT]: [OPERATOR_TOKEN_ACCOUNT] },
      signatures: {
        [OPERATOR_TOKEN_ACCOUNT]: [{ signature: SIGNATURES[0], slot: 1, blockTime: AUGUST }],
      },
      transactions: {},
    })

    expect((await indexPayouts({ wallet, networks, rpc, now: NOW })).payouts).toEqual([])
  })

  // Курсор належить акаунту, а не гаманцю: акаунти читаються різними списками,
  // і сигнатура, на якій скінчився один, у списку іншого не зустрічається.
  it('stops at the signature the previous pass ended on, account by account', async () => {
    const { rpc, fetched } = fakeRpc({
      accounts: { [HONEY_MINT]: [OPERATOR_TOKEN_ACCOUNT], [HNT_MINT]: [OPERATOR_HNT_ACCOUNT] },
      signatures: {
        [OPERATOR_TOKEN_ACCOUNT]: [
          { signature: SIGNATURES[0], slot: 442_918_004, blockTime: AUGUST },
          { signature: SIGNATURES[1], slot: 442_000_000, blockTime: AUGUST - 86_400 },
        ],
        [OPERATOR_HNT_ACCOUNT]: [
          { signature: SIGNATURES[3], slot: 441_000_000, blockTime: AUGUST - 172_800 },
        ],
      },
      transactions: {
        [SIGNATURES[0]]: emission(),
        [SIGNATURES[1]]: emission(),
        [SIGNATURES[3]]: transfer({ slot: 441_000_000, blockTime: AUGUST - 172_800 }),
      },
    })

    const { payouts } = await indexPayouts({
      wallet,
      networks,
      rpc,
      now: NOW,
      pageSize: 1,
      until: new Map([[OPERATOR_TOKEN_ACCOUNT, SIGNATURES[1]]]),
    })

    expect(fetched).toEqual([SIGNATURES[0], SIGNATURES[3]])
    expect(payouts.map((payout) => payout.networkId)).toEqual(['hivemapper', 'helium'])
  })

  it('reports the newest signature of each account so the next pass can resume', async () => {
    const { rpc } = fakeRpc({
      accounts: { [HONEY_MINT]: [OPERATOR_TOKEN_ACCOUNT], [HNT_MINT]: [OPERATOR_HNT_ACCOUNT] },
      signatures: {
        [OPERATOR_TOKEN_ACCOUNT]: [
          { signature: SIGNATURES[0], slot: 442_918_004, blockTime: AUGUST },
          { signature: SIGNATURES[1], slot: 442_000_000, blockTime: AUGUST - 86_400 },
        ],
        [OPERATOR_HNT_ACCOUNT]: [
          { signature: SIGNATURES[3], slot: 441_000_000, blockTime: AUGUST - 172_800 },
        ],
      },
      transactions: {
        [SIGNATURES[0]]: emission(),
        [SIGNATURES[1]]: emission(),
        [SIGNATURES[3]]: transfer({ slot: 441_000_000, blockTime: AUGUST - 172_800 }),
      },
    })

    const { cursors } = await indexPayouts({ wallet, networks, rpc, now: NOW })

    expect(cursors).toEqual([
      {
        tokenAccount: OPERATOR_TOKEN_ACCOUNT,
        lastSignature: SIGNATURES[0],
        lastSlot: 442_918_004n,
      },
      { tokenAccount: OPERATOR_HNT_ACCOUNT, lastSignature: SIGNATURES[3], lastSlot: 441_000_000n },
    ])
  })

  // Прохід, що не знайшов нічого нового, не має чим зсувати курсор — і не
  // повертає його зовсім, щоб той, хто зберігає, лишив попередній на місці.
  it('reports no cursor for an account with nothing new since the last pass', async () => {
    const { rpc } = fakeRpc({
      accounts: { [HONEY_MINT]: [OPERATOR_TOKEN_ACCOUNT] },
      signatures: {
        [OPERATOR_TOKEN_ACCOUNT]: [
          { signature: SIGNATURES[0], slot: 442_918_004, blockTime: AUGUST },
        ],
      },
      transactions: { [SIGNATURES[0]]: emission() },
    })

    const { payouts, cursors } = await indexPayouts({
      wallet,
      networks,
      rpc,
      now: NOW,
      until: new Map([[OPERATOR_TOKEN_ACCOUNT, SIGNATURES[0]]]),
    })

    expect(payouts).toEqual([])
    expect(cursors).toEqual([])
  })

  it('rejects a token account listing that is not one', async () => {
    const rpc = {
      listTokenAccounts: () => Promise.resolve({ value: [{ pubkey: 'not an address' }] }),
      listSignatures: () => Promise.resolve([]),
      getTransaction: () => Promise.resolve(null),
    }

    await expect(indexPayouts({ wallet, networks, rpc, now: NOW })).rejects.toThrow()
  })
})
