import { createLogger } from '@drf/shared/log'
import { serve } from '@hono/node-server'
import { loadApiConfig } from './config.ts'
import { createServer } from './server.ts'

const config = loadApiConfig()
const logger = createLogger({ service: 'api', level: config.logLevel })

const server = serve({ fetch: createServer({ logger }).fetch, port: config.port }, (address) => {
  logger.info({ port: address.port }, 'api listening')
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down')
    server.close(() => process.exit(0))
  })
}
