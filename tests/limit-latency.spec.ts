import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createServer } from '@drf/api/server'
import { createDbCreditProfileStore } from '@drf/api/routes/limit'
import { createDbPayoutHistorySource } from '@drf/api/routes/operators'
import {
  createDatabase,
  creditProfiles,
  type Database,
  networks as networksTable,
  payouts as payoutsTable,
  pricePoints,
} from '@drf/db'
import { createLogger } from '@drf/shared/log'
import { type RewardNetwork, rewardNetworkSchema, solanaAddressSchema } from '@drf/shared/schemas'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { percentile } from './latency.ts'

// SC-001: від підключення гаманця до показаного ліміту — менше 10 секунд (p95)
// на історії за 12 місяців.
const BUDGET_MS = 10_000
const SAMPLES = 20

const NOW = new Date('2026-08-31T12:00:00.000Z')
const HISTORY_START = new Date('2025-09-01T00:00:00.000Z')

const WALLET = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')
const HONEY_MINT = solanaAddressSchema.parse('2RZMt9LwzUzSUNfprdLSUF33gS2Y3EJL3jqN6g6a9oP1')
const HNT_MINT = solanaAddressSchema.parse('3mqvZ478SVFftqm6Pmh14SdUhUHuaG7KkKqaBDqNZADs')
const HONEY_SOURCE = solanaAddressSchema.parse('G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7')
const HNT_SOURCE = solanaAddressSchema.parse('9axh44i2g6U3q4KZxG9ieH4Z8Khx4N8npn4hWotr8zeZ')

const HIVEMAPPER = rewardNetworkSchema.parse({
  id: 'test-latency-hivemapper',
  displayName: 'Hivemapper',
  token: { mint: HONEY_MINT, symbol: 'HONEY', decimals: 9 },
  payoutSources: [{ kind: 'mint', address: HONEY_SOURCE }],
  payoutCadence: 'weekly',
})

// Мережа з `on-demand` ліміту не отримає, але її виплати однаково читаються і
// однаково коштують: історія оператора рідко буває на одній мережі.
const HELIUM = rewardNetworkSchema.parse({
  id: 'test-latency-helium',
  displayName: 'Helium',
  token: { mint: HNT_MINT, symbol: 'HNT', decimals: 8 },
  payoutSources: [{ kind: 'transfer', address: HNT_SOURCE }],
  payoutCadence: 'on-demand',
})

const DAY_MS = 86_400_000

const day = (offset: number) => new Date(HISTORY_START.getTime() + offset * DAY_MS)

const HISTORY_DAYS = Math.round((NOW.getTime() - HISTORY_START.getTime()) / DAY_MS)

type PayoutRow = typeof payoutsTable.$inferInsert
type PriceRow = typeof pricePoints.$inferInsert

// Форма справжніх даних, зміряна в T023a: Hivemapper карбує щотижня, а Helium
// оператор знімає сам, 12–13 разів на місяць. Замір на трьох виплатах був би
// заміром порожньої бази.
function payoutRows(): PayoutRow[] {
  const rows: PayoutRow[] = []

  for (let offset = 3; offset < HISTORY_DAYS; offset += 7) {
    rows.push({
      signature: `latency-honey-${offset}`,
      wallet: WALLET,
      networkId: HIVEMAPPER.id,
      source: HONEY_SOURCE,
      amount: BigInt(400_000_000_000 + offset * 1_000_000_000),
      slot: BigInt(442_000_000 + offset),
      blockTime: day(offset),
      valueUsd: null,
    })
  }

  for (let index = 0; index < 152; index += 1) {
    const offset = Math.floor((index * HISTORY_DAYS) / 152)
    rows.push({
      signature: `latency-hnt-${index}`,
      wallet: WALLET,
      networkId: HELIUM.id,
      source: HNT_SOURCE,
      amount: BigInt(120_000_000 + index * 1_000_000),
      slot: BigInt(443_000_000 + index),
      blockTime: day(offset),
      valueUsd: null,
    })
  }

  return rows
}

function priceRows(): PriceRow[] {
  const rows: PriceRow[] = []

  for (let offset = 0; offset < HISTORY_DAYS; offset += 1) {
    const wobble = 1 + Math.sin(offset / 30) / 4
    rows.push({
      mint: HONEY_MINT,
      day: day(offset).toISOString().slice(0, 10),
      priceUsd: (0.02 * wobble).toFixed(18),
      source: 'latency-fixture',
    })
    rows.push({
      mint: HNT_MINT,
      day: day(offset).toISOString().slice(0, 10),
      priceUsd: (3.5 * wobble).toFixed(18),
      source: 'latency-fixture',
    })
  }

  return rows
}

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL

  try {
    const file = readFileSync(path.join(import.meta.dirname, '..', '.env'), 'utf8')
    return file
      .split(/\r?\n/)
      .find((line) => line.startsWith('DATABASE_URL='))
      ?.slice('DATABASE_URL='.length)
  } catch {
    return undefined
  }
}

const url = databaseUrl()

const CHUNK = 200

async function insertAll<T>(rows: readonly T[], write: (batch: T[]) => Promise<unknown>) {
  for (let start = 0; start < rows.length; start += CHUNK) {
    await write(rows.slice(start, start + CHUNK))
  }
}

function summarise(label: string, samples: readonly number[]): string {
  const round = (value: number) => Math.round(value)

  return [
    `${label}: n=${samples.length}`,
    `min=${round(percentile(samples, 0.01))}ms`,
    `p50=${round(percentile(samples, 0.5))}ms`,
    `p95=${round(percentile(samples, 0.95))}ms`,
    `max=${round(percentile(samples, 1))}ms`,
  ].join(' ')
}

describe.skipIf(url === undefined)('SC-001 — connecting a wallet until the limit is shown', () => {
  let db: Database
  let close: () => Promise<void>
  let app: ReturnType<typeof createServer>

  const wipeHistory = async () => {
    await db.delete(payoutsTable).where(eq(payoutsTable.wallet, WALLET))
    await db.delete(creditProfiles).where(eq(creditProfiles.wallet, WALLET))

    for (const mint of [HONEY_MINT, HNT_MINT]) {
      await db.delete(pricePoints).where(eq(pricePoints.mint, mint))
    }
  }

  const wipeNetworks = async () => {
    for (const network of [HIVEMAPPER, HELIUM]) {
      await db.delete(networksTable).where(eq(networksTable.id, network.id))
    }
  }

  const seedNetwork = async (network: RewardNetwork) => {
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

  const measure = async (): Promise<number> => {
    const started = performance.now()
    const response = await app.request(`/v1/operators/${WALLET}/limit`)
    const elapsed = performance.now() - started

    expect(response.status).toBe(200)

    return elapsed
  }

  beforeAll(async () => {
    const handle = createDatabase(url ?? '')
    db = handle.db
    close = handle.close

    await wipeHistory()
    await wipeNetworks()
    await seedNetwork(HIVEMAPPER)
    await seedNetwork(HELIUM)
    await insertAll(payoutRows(), (batch) => db.insert(payoutsTable).values(batch))
    await insertAll(priceRows(), (batch) => db.insert(pricePoints).values(batch))

    app = createServer({
      logger: createLogger({ service: 'limit-latency', level: 'fatal' }),
      payouts: createDbPayoutHistorySource(db),
      profiles: createDbCreditProfileStore(db),
      // Джерела тривоги в замірі немає: `GET /limit` до неї не звертається.
      activity: { read: async () => ({ networks: [], activity: [] }) },
      now: () => NOW,
    })
  })

  afterAll(async () => {
    await wipeHistory()
    await wipeNetworks()
    await close()
  })

  it('has the twelve months of history the criterion speaks of', async () => {
    const rows = await db
      .select({ signature: payoutsTable.signature })
      .from(payoutsTable)
      .where(eq(payoutsTable.wallet, WALLET))

    expect(rows.length).toBeGreaterThan(200)
  })

  // Холодний шлях і є критерієм: оператор, який щойно підключив гаманець,
  // збереженого профілю не має за визначенням.
  it(`answers a first-time wallet within ${BUDGET_MS} ms at p95`, async () => {
    const cold: number[] = []

    for (let sample = 0; sample < SAMPLES; sample += 1) {
      await db.delete(creditProfiles).where(eq(creditProfiles.wallet, WALLET))
      cold.push(await measure())
    }

    console.info(summarise('cold', cold))

    expect(percentile(cold, 0.95)).toBeLessThanOrEqual(BUDGET_MS)
  })

  // Довідка, а не бюджет: показує, що саме купує кеш, і не гейтить нічого —
  // `SC-001` про друге підключення не говорить.
  it('records what the cached path costs, without holding it to a budget', async () => {
    const warm: number[] = []

    await measure()
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      warm.push(await measure())
    }

    console.info(summarise('warm', warm))

    expect(warm).toHaveLength(SAMPLES)
  })
})
