import { Hono } from 'hono'
import type { Logger } from 'pino'
import { DataUnavailable, errorBody } from './routes/errors.ts'
import { createHealthRoutes, type PayoutActivitySource } from './routes/health.ts'
import { type CreditProfileStore, createLimitRoutes } from './routes/limit.ts'
import { createOperatorRoutes, type PayoutHistorySource } from './routes/operators.ts'

export type ServerDeps = {
  logger: Logger
  payouts: PayoutHistorySource
  profiles: CreditProfileStore
  activity: PayoutActivitySource
  // Годинник параметром: період історії — останні 12 місяців, і тест на межі
  // місяця інакше падав би раз на місяць.
  now: () => Date
}

export function createServer({ logger, payouts, profiles, activity, now }: ServerDeps): Hono {
  const app = new Hono()

  app.route('/', createHealthRoutes({ activity, now }))
  app.route('/v1', createOperatorRoutes({ payouts, now }))
  app.route('/v1', createLimitRoutes({ payouts, profiles, now }))

  app.notFound((c) => c.json(errorBody('NOT_FOUND', 'route not found'), 404))

  app.onError((error, c) => {
    logger.error({ method: c.req.method, path: c.req.path, err: error }, 'request failed')

    // Причина лишається в логах: у тексті помилки бувають адреси й імена
    // внутрішніх сервісів, а їх не показують тому, хто прийшов ззовні.
    if (error instanceof DataUnavailable) {
      return c.json(errorBody('DATA_UNAVAILABLE', 'the payout history could not be read'), 503)
    }

    return c.json(errorBody('INTERNAL', 'internal error'), 500)
  })

  return app
}
