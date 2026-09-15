import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  createDatabase,
  type Database,
  networks as networksTable,
  payouts as payoutsTable,
} from '@drf/db'
import {
  type RewardNetwork,
  rewardNetworkSchema,
  type SolanaAddress,
  solanaAddressSchema,
} from '@drf/shared/schemas'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assessPayoutSources,
  createDbPayoutActivitySource,
  createHealthRoutes,
  PAYOUT_SILENCE_DAYS,
  type PayoutActivitySource,
  type PayoutSourceActivity,
} from './health.ts'

const HONEY_MINT = solanaAddressSchema.parse('2RZMt9LwzUzSUNfprdLSUF33gS2Y3EJL3jqN6g6a9oP1')
const HNT_MINT = solanaAddressSchema.parse('3mqvZ478SVFftqm6Pmh14SdUhUHuaG7KkKqaBDqNZADs')
const HONEY_SOURCE = solanaAddressSchema.parse('G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7')
const HNT_SOURCE = solanaAddressSchema.parse('9axh44i2g6U3q4KZxG9ieH4Z8Khx4N8npn4hWotr8zeZ')
const WALLET = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')
const OTHER_WALLET = solanaAddressSchema.parse('7VhQVr8M2Dpdwp4QzzQB7EpvANtMMjv7gwpBHCrV3U2A')

const HIVEMAPPER = rewardNetworkSchema.parse({
  id: 'test-health-hivemapper',
  displayName: 'Hivemapper',
  token: { mint: HONEY_MINT, symbol: 'HONEY', decimals: 9 },
  payoutSources: [{ kind: 'mint', address: HONEY_SOURCE }],
  payoutCadence: 'weekly',
})

const HELIUM = rewardNetworkSchema.parse({
  id: 'test-health-helium',
  displayName: 'Helium',
  token: { mint: HNT_MINT, symbol: 'HNT', decimals: 8 },
  payoutSources: [{ kind: 'transfer', address: HNT_SOURCE }],
  payoutCadence: 'on-demand',
})

const NOW = new Date('2026-08-31T12:00:00.000Z')

const daysBefore = (days: number, ms = 0) =>
  new Date(NOW.getTime() - days * 86_400_000 - ms)

const seen = (network: RewardNetwork, at: Date): PayoutSourceActivity => ({
  networkId: network.id,
  source: network.payoutSources[0]?.address ?? HONEY_SOURCE,
  lastPayoutAt: at,
})

describe('assessPayoutSources', () => {
  it('leaves a paying source alone', () => {
    const health = assessPayoutSources({
      networks: [HIVEMAPPER],
      activity: [seen(HIVEMAPPER, daysBefore(1))],
      now: NOW,
    })

    expect(health.status).toBe('ok')
    expect(health.sources).toEqual([
      {
        networkId: HIVEMAPPER.id,
        kind: 'mint',
        address: HONEY_SOURCE,
        lastPayoutAt: daysBefore(1).toISOString(),
        state: 'paying',
      },
    ])
  })

  it('raises the alarm on a source nobody has been paid by in the window', () => {
    const health = assessPayoutSources({
      networks: [HIVEMAPPER],
      activity: [seen(HIVEMAPPER, daysBefore(PAYOUT_SILENCE_DAYS, 1))],
      now: NOW,
    })

    expect(health.status).toBe('alarm')
    expect(health.sources[0]?.state).toBe('silent')
  })

  it('counts the far edge of the window as still paying', () => {
    const health = assessPayoutSources({
      networks: [HIVEMAPPER],
      activity: [seen(HIVEMAPPER, daysBefore(PAYOUT_SILENCE_DAYS))],
      now: NOW,
    })

    expect(health.status).toBe('ok')
    expect(health.sources[0]?.state).toBe('paying')
  })

  // До першого проходу індексатора такими є всі джерела, і тривога на порожній
  // базі кричала б на кожному розгортанні.
  it('tells a source it has never seen apart from one that went silent', () => {
    const health = assessPayoutSources({ networks: [HIVEMAPPER], activity: [], now: NOW })

    expect(health.status).toBe('ok')
    expect(health.sources[0]).toMatchObject({ state: 'unseen', lastPayoutAt: null })
  })

  it('raises the alarm on one silent source without disturbing the others', () => {
    const health = assessPayoutSources({
      networks: [HIVEMAPPER, HELIUM],
      activity: [
        seen(HIVEMAPPER, daysBefore(PAYOUT_SILENCE_DAYS + 30)),
        seen(HELIUM, daysBefore(2)),
      ],
      now: NOW,
    })

    expect(health.status).toBe('alarm')
    expect(health.sources.map((source) => [source.networkId, source.state])).toEqual([
      [HELIUM.id, 'paying'],
      [HIVEMAPPER.id, 'silent'],
    ])
  })

  it('reports every declared source of a network on its own', () => {
    const twoSources = rewardNetworkSchema.parse({
      ...HIVEMAPPER,
      payoutSources: [
        { kind: 'mint', address: HONEY_SOURCE },
        { kind: 'transfer', address: HNT_SOURCE },
      ],
    })

    const health = assessPayoutSources({
      networks: [twoSources],
      activity: [{ networkId: twoSources.id, source: HNT_SOURCE, lastPayoutAt: daysBefore(1) }],
      now: NOW,
    })

    expect(health.status).toBe('ok')
    expect(health.sources.map((source) => [source.address, source.state])).toEqual([
      [HNT_SOURCE, 'paying'],
      [HONEY_SOURCE, 'unseen'],
    ])
  })

  // Адреса живе під мережею, а не сама по собі: інакше виплата чужої мережі
  // мовчки підтверджувала б розподільника, який насправді замовк.
  it('does not let activity of another network confirm a source', () => {
    const health = assessPayoutSources({
      networks: [HIVEMAPPER],
      activity: [{ networkId: HELIUM.id, source: HONEY_SOURCE, lastPayoutAt: daysBefore(1) }],
      now: NOW,
    })

    expect(health.status).toBe('ok')
    expect(health.sources[0]?.state).toBe('unseen')
  })

  it('ignores activity from an address the network no longer declares', () => {
    const health = assessPayoutSources({
      networks: [HIVEMAPPER],
      activity: [
        seen(HIVEMAPPER, daysBefore(1)),
        { networkId: HIVEMAPPER.id, source: HNT_SOURCE, lastPayoutAt: daysBefore(400) },
      ],
      now: NOW,
    })

    expect(health.status).toBe('ok')
    expect(health.sources).toHaveLength(1)
  })

  it('answers with the window it judged by', () => {
    const health = assessPayoutSources({ networks: [], activity: [], now: NOW })

    expect(health).toEqual({
      status: 'ok',
      checkedAt: NOW.toISOString(),
      silenceDays: PAYOUT_SILENCE_DAYS,
      sources: [],
    })
  })
})

const activitySource = (
  networks: readonly RewardNetwork[],
  activity: readonly PayoutSourceActivity[],
): PayoutActivitySource => ({
  read: async () => ({ networks, activity }),
})

describe('createHealthRoutes', () => {
  const app = (source: PayoutActivitySource) =>
    createHealthRoutes({ activity: source, now: () => NOW })

  it('answers /health without reading the database', async () => {
    const unreadable: PayoutActivitySource = {
      read: async () => {
        throw new Error('the database is down')
      },
    }

    const response = await app(unreadable).request('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('reports the payout sources', async () => {
    const source = activitySource([HIVEMAPPER], [seen(HIVEMAPPER, daysBefore(1))])

    const response = await app(source).request('/health/payout-sources')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      checkedAt: NOW.toISOString(),
      silenceDays: PAYOUT_SILENCE_DAYS,
      sources: [
        {
          networkId: HIVEMAPPER.id,
          kind: 'mint',
          address: HONEY_SOURCE,
          lastPayoutAt: daysBefore(1).toISOString(),
          state: 'paying',
        },
      ],
    })
  })

  // Тривога, а не непрацездатність: сам сервіс відповідає, тому 200 зі станом
  // у тілі, а не код помилки.
  it('answers 200 with the alarm in the body', async () => {
    const source = activitySource(
      [HIVEMAPPER],
      [seen(HIVEMAPPER, daysBefore(PAYOUT_SILENCE_DAYS + 1))],
    )

    const response = await app(source).request('/health/payout-sources')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'alarm' })
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

describe.skipIf(url === undefined)('createDbPayoutActivitySource against a live postgres', () => {
  let db: Database
  let close: () => Promise<void>

  const wipe = async () => {
    for (const wallet of [WALLET, OTHER_WALLET]) {
      await db.delete(payoutsTable).where(eq(payoutsTable.wallet, wallet))
    }
  }

  const seedNetwork = async (network: RewardNetwork) => {
    await db.delete(networksTable).where(eq(networksTable.id, network.id))
    await db.insert(networksTable).values({
      id: network.id,
      displayName: network.displayName,
      tokenMint: network.token.mint,
      tokenSymbol: network.token.symbol,
      tokenDecimals: network.token.decimals,
      payoutSources: [...network.payoutSources],
      payoutCadence: network.payoutCadence,
    })
  }

  const record = async (input: {
    signature: string
    wallet: SolanaAddress
    network: RewardNetwork
    source: SolanaAddress
    blockTime: Date
  }) => {
    await db.insert(payoutsTable).values({
      signature: input.signature,
      wallet: input.wallet,
      networkId: input.network.id,
      source: input.source,
      amount: 514_000_000_000n,
      slot: 442_918_004n,
      blockTime: input.blockTime,
      valueUsd: null,
    })
  }

  beforeAll(async () => {
    const handle = createDatabase(url ?? '')
    db = handle.db
    close = handle.close

    await wipe()
    await seedNetwork(HIVEMAPPER)
    await seedNetwork(HELIUM)
  })

  afterAll(async () => {
    await wipe()
    await db.delete(networksTable).where(eq(networksTable.id, HIVEMAPPER.id))
    await db.delete(networksTable).where(eq(networksTable.id, HELIUM.id))
    await close()
  })

  // Саме те, що обіцяє задача: тиша рахується по всіх гаманцях разом, тож
  // найсвіжіша виплата чужого гаманця тримає джерело живим.
  it('reports the newest payout of a source across every wallet', async () => {
    await wipe()
    await record({
      signature: 'health-old',
      wallet: WALLET,
      network: HIVEMAPPER,
      source: HONEY_SOURCE,
      blockTime: daysBefore(PAYOUT_SILENCE_DAYS + 10),
    })
    await record({
      signature: 'health-fresh',
      wallet: OTHER_WALLET,
      network: HIVEMAPPER,
      source: HONEY_SOURCE,
      blockTime: daysBefore(1),
    })

    const { activity } = await createDbPayoutActivitySource(db).read()
    const hivemapper = activity.filter((entry) => entry.networkId === HIVEMAPPER.id)

    expect(hivemapper).toEqual([
      { networkId: HIVEMAPPER.id, source: HONEY_SOURCE, lastPayoutAt: daysBefore(1) },
    ])
  })

  it('reads the seeded networks back as networks, not as rows', async () => {
    const { networks } = await createDbPayoutActivitySource(db).read()

    expect(networks).toContainEqual(HIVEMAPPER)
    expect(networks).toContainEqual(HELIUM)
  })

  it('leaves a source with no payout at all out of the activity', async () => {
    await wipe()

    const { activity } = await createDbPayoutActivitySource(db).read()

    expect(activity.some((entry) => entry.networkId === HIVEMAPPER.id)).toBe(false)
  })
})
