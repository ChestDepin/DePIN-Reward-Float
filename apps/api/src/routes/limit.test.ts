import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createDatabase, creditProfiles, type Database, networks } from '@drf/db'
import { creditLimitSchema } from '@drf/shared/api'
import {
  type RewardNetwork,
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
  REQUIRED_PAID_MONTHS,
} from '@drf/shared/scoring'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StoredHistory } from './operators.ts'
import {
  buildCreditLimit,
  computeProfiles,
  createDbCreditProfileStore,
  createLimitRoutes,
  LIMIT_TTL_HOURS,
  type StoredCreditProfile,
} from './limit.ts'

const WALLET = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')
const HONEY_MINT = solanaAddressSchema.parse('2RZMt9LwzUzSUNfprdLSUF33gS2Y3EJL3jqN6g6a9oP1')
const HNT_MINT = solanaAddressSchema.parse('3mqvZ478SVFftqm6Pmh14SdUhUHuaG7KkKqaBDqNZADs')
const HONEY_SOURCE = solanaAddressSchema.parse('G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7')
const HNT_SOURCE = solanaAddressSchema.parse('9axh44i2g6U3q4KZxG9ieH4Z8Khx4N8npn4hWotr8zeZ')

const HIVEMAPPER = rewardNetworkSchema.parse({
  id: 'test-limit-hivemapper',
  displayName: 'Hivemapper',
  token: { mint: HONEY_MINT, symbol: 'HONEY', decimals: 9 },
  payoutSources: [{ kind: 'mint', address: HONEY_SOURCE }],
  payoutCadence: 'weekly',
})

// Каденція `on-demand` — саме та мережа, на якій ліміт рахувати не можна.
const HELIUM = rewardNetworkSchema.parse({
  id: 'test-limit-helium',
  displayName: 'Helium',
  token: { mint: HNT_MINT, symbol: 'HNT', decimals: 8 },
  payoutSources: [{ kind: 'transfer', address: HNT_SOURCE }],
  payoutCadence: 'on-demand',
})

const PERIOD: MonthRange = monthRangeSchema.parse({ from: '2025-09', to: '2026-08' })
const NOW = new Date('2026-08-31T12:00:00.000Z')

const MONTHS = [
  '2025-09',
  '2025-10',
  '2025-11',
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
] as const

const payout = (network: RewardNetwork, month: string, amount: bigint): RecognisedPayout => ({
  signature: `${network.id}-${month}`,
  wallet: WALLET,
  networkId: network.id,
  source: network.payoutSources[0]?.address ?? HONEY_SOURCE,
  amount,
  slot: 442_918_004n,
  blockTime: new Date(`${month}-15T09:00:00.000Z`),
})

const paidMonths = (network: RewardNetwork, count: number, amount: bigint) =>
  MONTHS.slice(MONTHS.length - count).map((month) => payout(network, month, amount))

// Рівний ряд на все вікно недавньої ціни: волатильність нульова, тож ліміт у
// тестах рухають тільки медіана і стабільність.
const flatSeries = (price: string, days: number, until: string): PriceSeries => {
  const end = Date.parse(`${until}T00:00:00.000Z`)

  return new Map(
    Array.from({ length: days }, (_, index) => [
      calendarDaySchema.parse(
        new Date(end - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10),
      ),
      priceUsdSchema.parse(price),
    ]),
  )
}

const HONEY_PRICES = flatSeries('2', 30, '2026-08-31')

const stored = (input: Partial<StoredHistory>): StoredHistory => ({
  payouts: [],
  networks: [],
  prices: new Map(),
  ...input,
})

const profilesOf = (input: Partial<StoredHistory>, now = NOW) =>
  computeProfiles({ stored: stored(input), period: PERIOD, now })

const fullHivemapper = {
  payouts: paidMonths(HIVEMAPPER, 12, 1_000_000_000n),
  networks: [HIVEMAPPER],
  prices: new Map([[HONEY_MINT, HONEY_PRICES]]),
}

describe('computeProfiles', () => {
  it('computes a limit for a wallet paid every month of the period', () => {
    const [profile] = profilesOf(fullHivemapper)

    // 1 HONEY на місяць × $2 × 2 місяці потоку × стабільність 1 × (1 − 0) = $4.
    expect(profile?.limitUsd).toBe(4_000_000n)
    expect(profile?.reason).toBeNull()
    expect(profile?.network.id).toBe(HIVEMAPPER.id)
  })

  it('shows the derivation, and the factors add up to the limit itself', () => {
    const [profile] = profilesOf(fullHivemapper)
    const total = (profile?.factors ?? []).reduce((sum, factor) => sum + factor.deltaUsd, 0n)

    expect((profile?.factors ?? []).map((factor) => factor.name)).toEqual([
      'median-flow',
      'stability',
      'volatility',
    ])
    expect(total).toBe(profile?.limitUsd)
  })

  it('refuses a history shorter than the threshold and names the month it is reached', () => {
    const [profile] = profilesOf({
      ...fullHivemapper,
      payouts: paidMonths(HIVEMAPPER, 3, 1_000_000_000n),
    })

    expect(profile?.limitUsd).toBeNull()
    expect(profile?.reason).toEqual({
      kind: 'short-history',
      requiredMonths: REQUIRED_PAID_MONTHS,
      thresholdReachedIn: '2026-11',
    })
    expect(profile?.factors).toEqual([])
  })

  // FR-001a: ончейн у такої мережі лежить історія зняттів, а не заробітку.
  it('refuses an on-demand network however full its history is', () => {
    const [profile] = profilesOf({
      payouts: paidMonths(HELIUM, 12, 100_000_000n),
      networks: [HELIUM],
      prices: new Map([[HNT_MINT, flatSeries('3', 30, '2026-08-31')]]),
    })

    expect(profile?.limitUsd).toBeNull()
    expect(profile?.reason).toEqual({ kind: 'withdrawal-history', cadence: 'on-demand' })
  })

  // FR-004a: «недавньої ціни немає» — не те саме, що «ліміт 0».
  it('refuses without a recent price and names the window it looked in', () => {
    const [profile] = profilesOf({ ...fullHivemapper, prices: new Map() })

    expect(profile?.limitUsd).toBeNull()
    expect(profile?.reason).toEqual({
      kind: 'no-recent-price',
      window: { from: '2026-08-02', to: '2026-08-31' },
    })
  })

  it('keeps the networks apart, each on its own token scale', () => {
    const profiles = profilesOf({
      payouts: [...paidMonths(HIVEMAPPER, 12, 1_000_000_000n), ...paidMonths(HELIUM, 12, 1n)],
      networks: [HIVEMAPPER, HELIUM],
      prices: new Map([
        [HONEY_MINT, HONEY_PRICES],
        [HNT_MINT, flatSeries('3', 30, '2026-08-31')],
      ]),
    })

    expect(profiles.map((profile) => profile.network.id)).toEqual([HELIUM.id, HIVEMAPPER.id])
    expect(profiles[1]?.limitUsd).toBe(4_000_000n)
  })

  // FR-007: показане значення не старше за 24 години.
  it('stamps the profile with the clock it was computed on and when it goes stale', () => {
    const [profile] = profilesOf(fullHivemapper)

    expect(profile?.computedAt).toEqual(NOW)
    expect(profile?.expiresAt).toEqual(new Date(NOW.getTime() + LIMIT_TTL_HOURS * 3_600_000))
  })

  // FR-025: нуль — це порахований ліміт, а не «не змогли порахувати».
  it('computes a limit of zero and does not call it a refusal', () => {
    const [profile] = profilesOf({ ...fullHivemapper, payouts: paidMonths(HIVEMAPPER, 12, 1n) })

    expect(profile?.limitUsd).toBe(0n)
    expect(profile?.reason).toBeNull()
  })

  it('answers a wallet with no indexed payouts with no profiles, not with an error', () => {
    expect(profilesOf({})).toEqual([])
  })
})

describe('buildCreditLimit', () => {
  it('sends every number as a string and keeps the refusal structured', () => {
    const body = buildCreditLimit({ wallet: WALLET, profiles: profilesOf(fullHivemapper) })

    expect(creditLimitSchema.parse(body)).toEqual(body)
    expect(body.networks[0]).toMatchObject({
      networkId: HIVEMAPPER.id,
      displayName: 'Hivemapper',
      token: { symbol: 'HONEY', decimals: 9 },
      limitUsd: '4000000',
      reason: null,
      computedAt: NOW.toISOString(),
    })
  })

  it('carries a refusal instead of a number, never both', () => {
    const body = buildCreditLimit({
      wallet: WALLET,
      profiles: profilesOf({ ...fullHivemapper, prices: new Map() }),
    })

    expect(creditLimitSchema.parse(body).networks[0]).toMatchObject({
      limitUsd: null,
      factors: [],
      reason: { kind: 'no-recent-price', window: { from: '2026-08-02', to: '2026-08-31' } },
    })
  })
})

const memoryStore = (initial: readonly StoredCreditProfile[] = []) => {
  const rows = { current: [...initial], writes: 0 }

  return {
    rows,
    store: {
      read: async () => rows.current,
      write: async (_wallet: SolanaAddress, profiles: readonly StoredCreditProfile[]) => {
        rows.current = [...profiles]
        rows.writes += 1
      },
    },
  }
}

const routes = (input: {
  history?: Partial<StoredHistory>
  profiles?: readonly StoredCreditProfile[]
  now?: Date
}) => {
  const asked: MonthRange[] = []
  const { rows, store } = memoryStore(input.profiles)
  const at = input.now ?? NOW

  const app = createLimitRoutes({
    payouts: {
      read: async (_wallet: SolanaAddress, period: MonthRange) => {
        asked.push(period)
        return stored(input.history ?? {})
      },
    },
    profiles: store,
    now: () => at,
  })

  return { app, asked, rows }
}

describe('GET /operators/:address/limit', () => {
  it('computes the limit when the wallet has no profile yet', async () => {
    const { app, asked, rows } = routes({ history: fullHivemapper })

    const response = await app.request(`/operators/${WALLET}/limit`)

    expect(response.status).toBe(200)
    expect(creditLimitSchema.parse(await response.json()).networks[0]?.limitUsd).toBe('4000000')
    expect(asked).toEqual([{ from: '2025-09', to: '2026-08' }])
    expect(rows.writes).toBe(1)
  })

  it('serves a profile that has not expired without reading the history again', async () => {
    const { app, asked, rows } = routes({
      history: fullHivemapper,
      profiles: profilesOf(fullHivemapper, new Date(NOW.getTime() - 3_600_000)),
    })

    const response = await app.request(`/operators/${WALLET}/limit`)

    expect(creditLimitSchema.parse(await response.json()).networks[0]?.limitUsd).toBe('4000000')
    expect(asked).toEqual([])
    expect(rows.writes).toBe(0)
  })

  // FR-007: старше за 24 години не показуємо навіть із кешу.
  it('recomputes a profile that has gone stale', async () => {
    const { app, asked, rows } = routes({
      history: fullHivemapper,
      profiles: profilesOf(fullHivemapper, new Date(NOW.getTime() - 25 * 3_600_000)),
    })

    await app.request(`/operators/${WALLET}/limit`)

    expect(asked).toHaveLength(1)
    expect(rows.writes).toBe(1)
    expect(rows.current[0]?.computedAt).toEqual(NOW)
  })

  it('refuses something that is not a Solana address before it touches the store', async () => {
    const { app, asked, rows } = routes({ history: fullHivemapper })

    const response = await app.request('/operators/not-an-address/limit')

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
    expect(asked).toEqual([])
    expect(rows.writes).toBe(0)
  })
})

describe('POST /operators/:address/limit/refresh', () => {
  it('recomputes on demand even when the stored profile is still fresh', async () => {
    const { app, asked, rows } = routes({
      history: fullHivemapper,
      profiles: profilesOf(fullHivemapper, new Date(NOW.getTime() - 3_600_000)),
    })

    const response = await app.request(`/operators/${WALLET}/limit/refresh`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect(asked).toHaveLength(1)
    expect(rows.writes).toBe(1)
    expect(rows.current[0]?.computedAt).toEqual(NOW)
  })

  it('answers with the same shape as the plain read', async () => {
    const { app } = routes({ history: fullHivemapper })

    const response = await app.request(`/operators/${WALLET}/limit/refresh`, { method: 'POST' })

    expect(creditLimitSchema.parse(await response.json()).wallet).toBe(WALLET)
  })
})

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL

  try {
    const file = readFileSync(
      path.join(import.meta.dirname, '..', '..', '..', '..', '.env'),
      'utf8',
    )
    return file
      .split(/\r?\n/)
      .find((line) => line.startsWith('DATABASE_URL='))
      ?.slice('DATABASE_URL='.length)
  } catch {
    return undefined
  }
}

const url = databaseUrl()

describe.skipIf(url === undefined)('createDbCreditProfileStore against a live postgres', () => {
  let db: Database
  let close: () => Promise<void>

  const wipe = async () => {
    await db.delete(creditProfiles).where(eq(creditProfiles.wallet, WALLET))
  }

  const seed = async (network: RewardNetwork) => {
    await db.delete(networks).where(eq(networks.id, network.id))
    await db.insert(networks).values({
      id: network.id,
      displayName: network.displayName,
      tokenMint: network.token.mint,
      tokenSymbol: network.token.symbol,
      tokenDecimals: network.token.decimals,
      payoutSources: [...network.payoutSources],
      payoutCadence: network.payoutCadence,
    })
  }

  beforeAll(async () => {
    const handle = createDatabase(url ?? '')
    db = handle.db
    close = handle.close

    await wipe()
    await seed(HIVEMAPPER)
    await seed(HELIUM)
  })

  afterAll(async () => {
    await wipe()
    await db.delete(networks).where(eq(networks.id, HIVEMAPPER.id))
    await db.delete(networks).where(eq(networks.id, HELIUM.id))
    await close()
  })

  it('has no profile for a wallet whose limit was never computed', async () => {
    const store = createDbCreditProfileStore(db)

    expect(await store.read(WALLET)).toEqual([])
  })

  it('reads back a computed limit exactly as it was written', async () => {
    await wipe()
    const store = createDbCreditProfileStore(db)
    const written = profilesOf(fullHivemapper)

    await store.write(WALLET, written)

    expect(await store.read(WALLET)).toEqual(written)
  })

  // Кожна відмова їде в базу іншими колонками, і саме тут вони збираються назад.
  it('reads back every refusal with the same reason it was refused for', async () => {
    await wipe()
    const store = createDbCreditProfileStore(db)
    // Порядок той самий, у якому сховище читає: за зростанням `network_id`.
    const refusals = [
      ...profilesOf({
        payouts: paidMonths(HELIUM, 12, 100_000_000n),
        networks: [HELIUM],
        prices: new Map(),
      }),
      ...profilesOf({ ...fullHivemapper, payouts: paidMonths(HIVEMAPPER, 3, 1_000_000_000n) }),
    ]

    await store.write(WALLET, refusals)

    expect(await store.read(WALLET)).toEqual(refusals)
  })

  it('reads back a refusal that has no recent price to name', async () => {
    await wipe()
    const store = createDbCreditProfileStore(db)
    const written = profilesOf({ ...fullHivemapper, prices: new Map() })

    await store.write(WALLET, written)

    expect(await store.read(WALLET)).toEqual(written)
  })

  it('replaces the profile of a network instead of adding a second one', async () => {
    await wipe()
    const store = createDbCreditProfileStore(db)

    await store.write(WALLET, profilesOf(fullHivemapper))
    await store.write(WALLET, profilesOf(fullHivemapper, new Date(NOW.getTime() + 3_600_000)))

    const rows = await store.read(WALLET)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.computedAt).toEqual(new Date(NOW.getTime() + 3_600_000))
  })
})
