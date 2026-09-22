import type { Database } from '@drf/db'
import type { Hono } from 'hono'
import type { Logger } from 'pino'
import { createDbPayoutActivitySource } from './routes/health.ts'
import { createDbCreditProfileStore } from './routes/limit.ts'
import { createDbPayoutHistorySource } from './routes/operators.ts'
import { createServer } from './server.ts'

export type AppDeps = {
  db: Database
  logger: Logger
  webOrigins: readonly string[]
  now: () => Date
}

// Єдине місце, де сервер збирається з джерел на базі: і запуск, і заміри
// беруть застосунок звідси, тож зміна складання не пройде повз замір.
export function createApp({ db, logger, webOrigins, now }: AppDeps): Hono {
  return createServer({
    logger,
    payouts: createDbPayoutHistorySource(db),
    profiles: createDbCreditProfileStore(db),
    activity: createDbPayoutActivitySource(db),
    webOrigins,
    now,
  })
}
