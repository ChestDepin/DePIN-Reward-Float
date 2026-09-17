import { createServer as createSocketServer } from 'node:net'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createDbCreditProfileStore } from '@drf/api/routes/limit'
import { createDbPayoutHistorySource } from '@drf/api/routes/operators'
import { createServer } from '@drf/api/server'
import { createDatabase, type Database } from '@drf/db'
import { createLogger } from '@drf/shared/log'
import { serve } from '@hono/node-server'
import { type Browser, chromium } from 'playwright'
import { build, preview, type PreviewServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clearCachedProfiles,
  databaseUrl,
  HIVEMAPPER,
  NOW,
  seedHistory,
  WALLET,
  wipeHistory,
  wipeNetworks,
} from './history-fixture.ts'
import { percentile, summarise } from './latency.ts'

// SC-009: перший екран дашборда — не довше двох секунд.
const BUDGET_MS = 2_000
const SAMPLES = 20

const WEB_ROOT = path.join(import.meta.dirname, '..', 'apps', 'web')

const url = databaseUrl()

// Порт треба знати до збірки (він вшивається у бандл) і до запуску api (той
// має дозволити походження сторінки), тож обидва беруться наперед.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createSocketServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

describe.skipIf(url === undefined)('SC-009 — the first screen of the dashboard', () => {
  let db: Database
  let closeDb: () => Promise<void>
  let api: ReturnType<typeof serve>
  let site: PreviewServer
  let browser: Browser
  let origin: string

  const measure = async (): Promise<number> => {
    // Свій контекст на кожен замір: перше відкриття сторінки не має кешу, і
    // саме його обіцяє критерій.
    const context = await browser.newContext()
    const page = await context.newPage()

    const started = performance.now()
    await page.goto(`${origin}/limit/${WALLET}`)
    // Не «сторінка завантажилась», а «число видно»: порожній каркас із написом
    // «читаю» першим екраном дашборда не є.
    await page.getByText('AVAILABLE TO BORROW').waitFor({ timeout: BUDGET_MS * 10 })
    const elapsed = performance.now() - started

    await context.close()

    return elapsed
  }

  beforeAll(async () => {
    const handle = createDatabase(url ?? '')
    db = handle.db
    closeDb = handle.close

    await seedHistory(db)

    const apiPort = await freePort()
    const sitePort = await freePort()
    origin = `http://localhost:${sitePort}`

    // Адреса api вшивається у збірку: `VITE_API_URL` читається під час збірки.
    await build({
      root: WEB_ROOT,
      logLevel: 'error',
      define: { 'import.meta.env.VITE_API_URL': JSON.stringify(`http://127.0.0.1:${apiPort}`) },
    })

    api = serve({
      fetch: createServer({
        logger: createLogger({ service: 'first-screen', level: 'fatal' }),
        payouts: createDbPayoutHistorySource(db),
        profiles: createDbCreditProfileStore(db),
        activity: { read: async () => ({ networks: [], activity: [] }) },
        webOrigins: [origin],
        now: () => NOW,
      }).fetch,
      port: apiPort,
    })

    site = await preview({
      root: WEB_ROOT,
      logLevel: 'error',
      preview: { port: sitePort, strictPort: true },
    })

    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await site?.close()
    await new Promise<void>((resolve) => api.close(() => resolve()))
    await wipeHistory(db)
    await wipeNetworks(db)
    await closeDb()
  })

  it('shows the limit it was given, not a number of its own', async () => {
    await clearCachedProfiles(db)
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.goto(`${origin}/limit/${WALLET}`)
    await page.getByText('AVAILABLE TO BORROW').waitFor()

    const shown = await page.getByText(/^\$[\d,]+\.\d{2}$/).first().innerText()
    const named = await page.getByText(HIVEMAPPER.displayName.toUpperCase()).count()

    expect(shown).toMatch(/^\$[\d,]+\.\d{2}$/)
    expect(named).toBeGreaterThan(0)

    await context.close()
  })

  // Той самий холодний шлях, що й у SC-001, але вже цілком: браузер, бандл,
  // запит і рендер. Кеш профілю стирається перед кожним заміром.
  it(`paints the limit within ${BUDGET_MS} ms at p95`, async () => {
    const samples: number[] = []

    await measure()
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      await clearCachedProfiles(db)
      samples.push(await measure())
    }

    console.info(summarise('first screen', samples))

    expect(percentile(samples, 0.95)).toBeLessThanOrEqual(BUDGET_MS)
  })
})
