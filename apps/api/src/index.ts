import { createDatabase } from '@drf/db'
import { createLogger } from '@drf/shared/log'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { loadApiConfig } from './config.ts'
import { resolveAttestor } from './routes/attestations.ts'
import { createShutdown } from './shutdown.ts'

// Render дає процесу 30 с після SIGTERM; решта — на закриття бази.
const SHUTDOWN_GRACE_MS = 10_000

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
  webOrigins: config.webOrigins,
  now: () => new Date(),
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
    shutdown(signal).then((code) => process.exit(code))
  })
}
