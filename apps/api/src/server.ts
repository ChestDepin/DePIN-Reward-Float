import { Hono } from 'hono'
import { cors } from 'hono/cors'
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
  webOrigins: readonly string[]
  // Годинник параметром: період історії — останні 12 місяців, і тест на межі
  // місяця інакше падав би раз на місяць.
  now: () => Date
}

export function createServer({
  logger,
  payouts,
  profiles,
  activity,
  webOrigins,
  now,
}: ServerDeps): Hono {
  const app = new Hono()

  // Без цього заголовка сторінка не може прочитати навіть публічну історію:
  // вона завжди на іншому походженні, ніж api. Перевірки прав тут немає й бути
  // не може — CORS обмежує чужі сторінки, а не чужих людей.
  app.use('/v1/*', cors({ origin: [...webOrigins] }))

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
