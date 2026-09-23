import type { Database } from '@drf/db'
import type { Hono } from 'hono'
import type { Logger } from 'pino'
import { type Attestor, createDbAttestationJournal } from './routes/attestations.ts'
import { createDbPayoutActivitySource } from './routes/health.ts'
import { createDbCreditProfileStore } from './routes/limit.ts'
import { createDbPayoutHistorySource } from './routes/operators.ts'
import { createServer } from './server.ts'

export type AppDeps = {
  db: Database
  logger: Logger
  // Пара атестатора заходить готовою, а не рядками конфіга: складання сервера
  // лишається синхронним, а звірка пари робиться раз при старті процесу.
  attestor: Attestor
  webOrigins: readonly string[]
  now: () => Date
}

// Єдине місце, де сервер збирається з джерел на базі: і запуск, і заміри
// беруть застосунок звідси, тож зміна складання не пройде повз замір.
export function createApp({ db, logger, attestor, webOrigins, now }: AppDeps): Hono {
  return createServer({
    logger,
    payouts: createDbPayoutHistorySource(db),
    profiles: createDbCreditProfileStore(db),
    activity: createDbPayoutActivitySource(db),
    journal: createDbAttestationJournal(db),
    attestor,
    webOrigins,
    now,
  })
}
