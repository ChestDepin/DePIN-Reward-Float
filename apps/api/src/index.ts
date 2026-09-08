import { createDatabase } from '@drf/db'
import { createLogger } from '@drf/shared/log'
import { serve } from '@hono/node-server'
import { loadApiConfig } from './config.ts'
import { createDbPayoutHistorySource } from './routes/operators.ts'
import { createServer } from './server.ts'

const config = loadApiConfig()
const logger = createLogger({ service: 'api', level: config.logLevel })
const { db, close } = createDatabase(config.databaseUrl)

const app = createServer({
  logger,
  payouts: createDbPayoutHistorySource(db),
  now: () => new Date(),
})

const server = serve({ fetch: app.fetch, port: config.port }, (address) => {
  logger.info({ port: address.port }, 'api listening')
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down')
    server.close(() => {
      close().finally(() => process.exit(0))
    })
  })
}
