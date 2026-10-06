import { createDatabase } from '@drf/db'
import { createLogger } from '@drf/shared/log'
import { SUPPORTED_NETWORKS } from '@drf/shared/schemas'
import { startDevnetKeeper } from '@drf/worker/keeper'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { loadApiConfig, type RateConfig } from './config.ts'
import { createJupiterRateSource, createRpcBlockTime, rateMints } from './jupiter.ts'
import { rateFromApp } from './keeper.ts'
import { resolveAttestor } from './routes/attestations.ts'
import type { RateSource } from './routes/rate.ts'
import { createShutdown } from './shutdown.ts'

// Render дає процесу 30 с після SIGTERM; решта — на закриття бази.
const SHUTDOWN_GRACE_MS = 10_000
// A borrow waits on this answer; a hung upstream must become a 503, not a hung page.
const UPSTREAM_TIMEOUT_MS = 5_000
// Short against the two-minute attestation, long against the key's 60 requests a minute.
const RATE_CACHE_MS = 15_000

// Named, not by URL: the RPC url carries the Helius key.
async function readJson(source: string, response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`${source} answered ${response.status}`)
  return response.json()
}

function rateSource(rates: RateConfig): RateSource {
  return createJupiterRateSource({
    mints: rateMints(rates.rewardMints, SUPPORTED_NETWORKS),
    apiKey: rates.jupiterApiKey,
    get: async (url, headers) =>
      readJson(
        'Jupiter',
        await fetch(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }),
      ),
    blockTime: createRpcBlockTime(async (body) =>
      readJson(
        'the mainnet RPC',
        await fetch(rates.mainnetRpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        }),
      ),
    ),
    cacheMs: RATE_CACHE_MS,
    clock: () => Date.now(),
  })
}

const config = loadApiConfig()
const logger = createLogger({ service: 'api', level: config.logLevel })
const { db, close } = createDatabase(config.databaseUrl)

// Пара звіряється до того, як процес почне слухати: атестація, підписана не тим
// ключем, що в стані програми, впала б аж у мить видачі кредиту.
const attestor = await resolveAttestor({
  secretKey: config.attestorSecretKey,
  publicKey: config.attestorPublicKey,
})

const app = createApp({
  db,
  logger,
  attestor,
  rates: config.rates === null ? null : rateSource(config.rates),
  webOrigins: config.webOrigins,
  now: () => new Date(),
})

// Render's free plan has no background workers, so the keeper runs in this process.
const keeper =
  config.keeper === null
    ? null
    : startDevnetKeeper({
        rpcUrl: config.keeper.devnetRpcUrl,
        secretKey: config.keeper.secretKey,
        stableMint: config.keeper.stableMint,
        issueRate: rateFromApp(app),
        logger: logger.child({ component: 'keeper' }),
      })

const server = serve({ fetch: app.fetch, port: config.port }, (address) => {
  logger.info({ port: address.port }, 'api listening')
})

const shutdown = createShutdown({
  logger,
  closeServer: () =>
    new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    }),
  closeDatabase: close,
  graceMs: SHUTDOWN_GRACE_MS,
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    keeper?.stop()
    shutdown(signal).then((code) => process.exit(code))
  })
}
