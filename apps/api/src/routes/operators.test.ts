import { readFileSync } from 'node:fs'
import path from 'node:path'
import { payoutHistorySchema } from '@drf/shared/api'
import { createDatabase, type Database, networks, payouts, pricePoints } from '@drf/db'
import {
  rewardNetworkSchema,
  type SolanaAddress,
  solanaAddressSchema,
} from '@drf/shared/schemas'
import {
  calendarDaySchema,
  type MonthRange,
  monthRangeSchema,
  type PriceSeries,
  priceUsdSchema,
  type RecognisedPayout,
} from '@drf/shared/scoring'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildPayoutHistory,
  createDbPayoutHistorySource,
  createOperatorRoutes,
  type StoredHistory,
} from './operators.ts'

const WALLET = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')
const HONEY_MINT = solanaAddressSchema.parse('2RZMt9LwzUzSUNfprdLSUF33gS2Y3EJL3jqN6g6a9oP1')
const HNT_MINT = solanaAddressSchema.parse('3mqvZ478SVFftqm6Pmh14SdUhUHuaG7KkKqaBDqNZADs')
const HONEY_SOURCE = solanaAddressSchema.parse('G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7')
const HNT_SOURCE = solanaAddressSchema.parse('9axh44i2g6U3q4KZxG9ieH4Z8Khx4N8npn4hWotr8zeZ')

const SIGNATURES = [
  'mHhyPe2Am14FUfW89ak1Hut2cALVwKTtK3iKxomPkpamC7B17HTknFAgoSwT7zpz3shFoXhugio8pjPb9eRS6Ca',
  '2WMyoJh7W6GFmv4dA8yiv62VXZSZKUcysyVVGAEp4pYgJsA4yK4mcT8w4QZmeGWExdX1EuNq9gGeMbSGmU6pUaZM',
  '3FSFdDkCqRXTJMTkC8NefDfhPLx3hMEh9M3JSx3YaAxnBQSNnPcLxYNVe6ALkk7DRt82QSVP9SAF8QY3C2bANmcp',
  '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy5SMBHrfNPnRgFUJb1jGgWgWmqbUvJH2tGnzXLBRLQeVKcvS7yTdHzs',
] as const

const HIVEMAPPER = rewardNetworkSchema.parse({
  id: 'test-hivemapper',
  displayName: 'Hivemapper',
  token: { mint: HONEY_MINT, symbol: 'HONEY', decimals: 9 },
  payoutSources: [{ kind: 'mint', address: HONEY_SOURCE }],
  payoutCadence: 'weekly',
})

const HELIUM = rewardNetworkSchema.parse({
  id: 'test-helium',
  displayName: 'Helium',
  token: { mint: HNT_MINT, symbol: 'HNT', decimals: 8 },
  payoutSources: [{ kind: 'transfer', address: HNT_SOURCE }],
  payoutCadence: 'daily',
})

const PERIOD: MonthRange = monthRangeSchema.parse({ from: '2025-09', to: '2026-08' })

const payout = (
  index: number,
  network: typeof HIVEMAPPER,
  amount: bigint,
  blockTime: string,
): RecognisedPayout => {
  const signature = SIGNATURES[index]
  if (signature === undefined) throw new Error('the fixture ran out of signatures')

  return {
    signature,
    wallet: WALLET,
    networkId: network.id,
    source: network.payoutSources[0]?.address ?? HONEY_SOURCE,
    amount,
    slot: 442_918_004n,
    blockTime: new Date(blockTime),
  }
}

const series = (quotes: Record<string, string>): PriceSeries =>
  new Map(
    Object.entries(quotes).map(([day, price]) => [
      calendarDaySchema.parse(day),
      priceUsdSchema.parse(price),
    ]),
  )

const stored = (input: Partial<StoredHistory>): StoredHistory => ({
  payouts: [],
  networks: [],
  prices: new Map(),
  ...input,
})

const history = (input: Partial<StoredHistory>) =>
  buildPayoutHistory({ wallet: WALLET, period: PERIOD, stored: stored(input) })

const monthOf = (block: { months: readonly { month: string }[] }, month: string) =>
  block.months.find((entry) => entry.month === month)

describe('buildPayoutHistory', () => {
  it('values a payout at the quote of the day it landed', () => {
    const result = history({
      payouts: [payout(0, HIVEMAPPER, 1_000_000_000n, '2026-08-10T09:00:00.000Z')],
      networks: [HIVEMAPPER],
      prices: new Map([[HONEY_MINT, series({ '2026-08-10': '2' })]]),
    })

    const block = result.networks[0]
    expect(block?.networkId).toBe('test-hivemapper')
    expect(block?.token).toEqual({ symbol: 'HONEY', decimals: 9 })
    expect(block?.payouts).toEqual([
      {
        signature: SIGNATURES[0],
        source: HONEY_SOURCE,
        amount: '1000000000',
        valueUsd: '2000000',
        slot: '442918004',
        blockTime: '2026-08-10T09:00:00.000Z',
      },
    ])
    expect(monthOf(block ?? { months: [] }, '2026-08')).toEqual({
      month: '2026-08',
      payoutCount: 1,
      amount: '1000000000',
      valueUsd: '2000000',
      daysWithoutPrice: [],
    })
  })

  it('lays out every month of the period, paid or not', () => {
    const result = history({
      payouts: [payout(0, HIVEMAPPER, 1n, '2026-08-10T09:00:00.000Z')],
      networks: [HIVEMAPPER],
      prices: new Map([[HONEY_MINT, series({ '2026-08-10': '2' })]]),
    })

    expect(result.networks[0]?.months).toHaveLength(12)
    expect(monthOf(result.networks[0] ?? { months: [] }, '2025-09')).toMatchObject({
      payoutCount: 0,
      amount: '0',
      valueUsd: '0',
    })
  })

  it('keeps the token amount and drops only the value when the day has no quote', () => {
    const result = history({
      payouts: [payout(0, HIVEMAPPER, 5_000_000_000n, '2026-07-05T00:00:00.000Z')],
      networks: [HIVEMAPPER],
      prices: new Map([[HONEY_MINT, series({ '2026-08-10': '2' })]]),
    })

    const block = result.networks[0]
    expect(block?.payouts[0]).toMatchObject({ amount: '5000000000', valueUsd: null })
    expect(monthOf(block ?? { months: [] }, '2026-07')).toEqual({
      month: '2026-07',
      payoutCount: 1,
      amount: '5000000000',
      valueUsd: null,
      daysWithoutPrice: ['2026-07-05'],
    })
  })

  it('keeps the networks apart, each on its own token scale', () => {
    const result = history({
      payouts: [
        payout(0, HIVEMAPPER, 1_000_000_000n, '2026-08-10T09:00:00.000Z'),
        payout(1, HELIUM, 100_000_000n, '2026-08-11T09:00:00.000Z'),
      ],
      networks: [HIVEMAPPER, HELIUM],
      prices: new Map([
        [HONEY_MINT, series({ '2026-08-10': '2' })],
        [HNT_MINT, series({ '2026-08-11': '3' })],
      ]),
    })

    expect(result.networks.map((block) => block.networkId)).toEqual([
      'test-helium',
      'test-hivemapper',
    ])
    expect(result.networks[0]?.payouts[0]?.valueUsd).toBe('3000000')
    expect(result.networks[1]?.payouts[0]?.valueUsd).toBe('2000000')
  })

  it('answers a wallet with no indexed payouts with no networks, not with an error', () => {
    expect(history({})).toEqual({ wallet: WALLET, period: PERIOD, networks: [] })
  })

  it('puts the newest payout first', () => {
    const result = history({
      payouts: [
        payout(0, HIVEMAPPER, 1n, '2026-02-01T00:00:00.000Z'),
        payout(1, HIVEMAPPER, 2n, '2026-08-01T00:00:00.000Z'),
        payout(2, HIVEMAPPER, 3n, '2026-05-01T00:00:00.000Z'),
      ],
      networks: [HIVEMAPPER],
      prices: new Map(),
    })

    expect(result.networks[0]?.payouts.map((entry) => entry.blockTime)).toEqual([
      '2026-08-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    ])
  })

  it('produces exactly what the shared response contract describes', () => {
    const result = history({
      payouts: [payout(0, HIVEMAPPER, 1_000_000_000n, '2026-08-10T09:00:00.000Z')],
      networks: [HIVEMAPPER],
      prices: new Map([[HONEY_MINT, series({ '2026-08-10': '2' })]]),
    })

    expect(payoutHistorySchema.parse(result)).toEqual(result)
  })

  it('refuses a payout whose network was not read along with it', () => {
    expect(() =>
      history({
        payouts: [payout(0, HIVEMAPPER, 1n, '2026-08-10T09:00:00.000Z')],
        networks: [],
      }),
    ).toThrow(/test-hivemapper/)
  })
})

const recording = (input: Partial<StoredHistory>) => {
  const asked: { wallet: SolanaAddress; period: MonthRange }[] = []

  return {
    asked,
    source: {
      read: async (wallet: SolanaAddress, period: MonthRange) => {
        asked.push({ wallet, period })
        return stored(input)
      },
    },
  }
}

const routes = (input: Partial<StoredHistory>, now: string) => {
  const { asked, source } = recording(input)

  return { asked, app: createOperatorRoutes({ payouts: source, now: () => new Date(now) }) }
}

describe('GET /operators/:address/payouts', () => {
  it('answers a request that carries no signature and no session at all', async () => {
    const { app } = routes(
      {
        payouts: [payout(0, HIVEMAPPER, 1_000_000_000n, '2026-08-10T09:00:00.000Z')],
        networks: [HIVEMAPPER],
        prices: new Map([[HONEY_MINT, series({ '2026-08-10': '2' })]]),
      },
      '2026-08-31T12:00:00.000Z',
    )

    const response = await app.request(`/operators/${WALLET}/payouts`)

    expect(response.status).toBe(200)
    expect(payoutHistorySchema.parse(await response.json()).networks).toHaveLength(1)
  })

  it('asks the store for the last twelve months, counted from the injected clock', async () => {
    const { app, asked } = routes({}, '2026-08-31T12:00:00.000Z')

    await app.request(`/operators/${WALLET}/payouts`)

    expect(asked).toEqual([{ wallet: WALLET, period: { from: '2025-09', to: '2026-08' } }])
  })

  it('carries the twelve-month window back over the turn of the year', async () => {
    const { app, asked } = routes({}, '2026-01-15T00:00:00.000Z')

    await app.request(`/operators/${WALLET}/payouts`)

    expect(asked[0]?.period).toEqual({ from: '2025-02', to: '2026-01' })
  })

  it('refuses something that is not a Solana address before it touches the store', async () => {
    const { app, asked } = routes({}, '2026-08-31T12:00:00.000Z')

    const response = await app.request('/operators/not-an-address/payouts')

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
    expect(asked).toEqual([])
  })
})

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL

  try {
    const file = readFileSync(path.join(import.meta.dirname, '..', '..', '..', '..', '.env'), 'utf8')
    return file
      .split(/\r?\n/)
      .find((line) => line.startsWith('DATABASE_URL='))
      ?.slice('DATABASE_URL='.length)
  } catch {
    return undefined
  }
}

const url = databaseUrl()

describe.skipIf(url === undefined)('createDbPayoutHistorySource against a live postgres', () => {
  let db: Database
  let close: () => Promise<void>

  const wipe = async () => {
    await db.delete(payouts).where(eq(payouts.wallet, WALLET))
    await db.delete(pricePoints).where(eq(pricePoints.mint, HONEY_MINT))
    await db.delete(networks).where(eq(networks.id, HIVEMAPPER.id))
  }

  beforeAll(async () => {
    const handle = createDatabase(url ?? '')
    db = handle.db
    close = handle.close

    await wipe()
    await db.insert(networks).values({
      id: HIVEMAPPER.id,
      displayName: HIVEMAPPER.displayName,
      tokenMint: HONEY_MINT,
      tokenSymbol: 'HONEY',
      tokenDecimals: 9,
      payoutSources: [{ kind: 'mint', address: HONEY_SOURCE }],
      payoutCadence: 'weekly',
    })
    await db.insert(payouts).values([
      { ...payout(0, HIVEMAPPER, 1_000_000_000n, '2026-08-10T09:00:00.000Z') },
      { ...payout(1, HIVEMAPPER, 2_000_000_000n, '2026-07-05T00:00:00.000Z') },
      { ...payout(2, HIVEMAPPER, 9_000_000_000n, '2025-06-01T00:00:00.000Z') },
    ])
    await db
      .insert(pricePoints)
      .values({ mint: HONEY_MINT, day: '2026-08-10', priceUsd: '2', source: 'test' })
  })

  afterAll(async () => {
    await wipe()
    await close()
  })

  it('reads back only the payouts that fall inside the asked period', async () => {
    const result = await createDbPayoutHistorySource(db).read(WALLET, PERIOD)

    expect(result.payouts.map((entry) => entry.signature)).toEqual([SIGNATURES[0], SIGNATURES[1]])
    expect(result.payouts[0]?.amount).toBe(1_000_000_000n)
    expect(result.payouts[0]?.blockTime).toEqual(new Date('2026-08-10T09:00:00.000Z'))
  })

  it('reads the network description as data, not as a hard-coded token', async () => {
    const result = await createDbPayoutHistorySource(db).read(WALLET, PERIOD)

    expect(result.networks).toEqual([HIVEMAPPER])
  })

  it('reads the cached quotes for the mints it actually needs', async () => {
    const result = await createDbPayoutHistorySource(db).read(WALLET, PERIOD)

    expect([...(result.prices.get(HONEY_MINT) ?? [])]).toEqual([
      ['2026-08-10', priceUsdSchema.parse('2')],
    ])
  })

  it('builds the whole response out of what the live store returned', async () => {
    const source = createDbPayoutHistorySource(db)
    const result = buildPayoutHistory({
      wallet: WALLET,
      period: PERIOD,
      stored: await source.read(WALLET, PERIOD),
    })

    expect(payoutHistorySchema.parse(result)).toEqual(result)
    expect(result.networks[0]?.payouts).toEqual([
      expect.objectContaining({ amount: '1000000000', valueUsd: '2000000' }),
      expect.objectContaining({ amount: '2000000000', valueUsd: null }),
    ])
  })

  it('leaves a wallet nobody indexed with an empty history', async () => {
    const other = solanaAddressSchema.parse('7ykbVJHDcHVzXXn9Bd5MNRLpqHt4gPvVsHkTBQMJqTL6')
    const result = await createDbPayoutHistorySource(db).read(other, PERIOD)

    expect(result).toEqual({ payouts: [], networks: [], prices: new Map() })
  })

  it('keeps the out-of-period payout stored: it is the query that leaves it out', async () => {
    const rows = await db
      .select()
      .from(payouts)
      .where(and(eq(payouts.wallet, WALLET), eq(payouts.networkId, HIVEMAPPER.id)))

    expect(rows).toHaveLength(3)
  })
})
