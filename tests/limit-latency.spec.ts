import { performance } from 'node:perf_hooks'
import { createApp } from '@drf/api/app'
import { createDatabase, type Database, payouts as payoutsTable } from '@drf/db'
import { createLogger } from '@drf/shared/log'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clearCachedProfiles,
  databaseUrl,
  NOW,
  seedHistory,
  WALLET,
  wipeHistory,
  wipeNetworks,
} from './history-fixture.ts'
import { percentile, summarise } from './latency.ts'

// SC-001: від підключення гаманця до показаного ліміту — менше 10 секунд (p95)
// на історії за 12 місяців.
const BUDGET_MS = 10_000
const SAMPLES = 20

const url = databaseUrl()

describe.skipIf(url === undefined)('SC-001 — connecting a wallet until the limit is shown', () => {
  let db: Database
  let close: () => Promise<void>
  let app: ReturnType<typeof createApp>

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

    await seedHistory(db)

    app = createApp({
      db,
      logger: createLogger({ service: 'limit-latency', level: 'fatal' }),
      // Замір ходить у процесі, без браузера, тож жодне походження йому не
      // потрібне — але список порожнім бути не може.
      webOrigins: ['http://localhost:5173'],
      now: () => NOW,
    })
  })

  afterAll(async () => {
    await wipeHistory(db)
    await wipeNetworks(db)
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
      await clearCachedProfiles(db)
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
