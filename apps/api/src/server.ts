import { Hono } from 'hono'
import type { Logger } from 'pino'
import { createOperatorRoutes, type PayoutHistorySource } from './routes/operators.ts'

export type ServerDeps = {
  logger: Logger
  payouts: PayoutHistorySource
  // Годинник параметром: період історії — останні 12 місяців, і тест на межі
  // місяця інакше падав би раз на місяць.
  now: () => Date
}

function errorBody(code: 'NOT_FOUND' | 'INTERNAL', message: string) {
  return { error: { code, message } }
}

export function createServer({ logger, payouts, now }: ServerDeps): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.route('/v1', createOperatorRoutes({ payouts, now }))

  app.notFound((c) => c.json(errorBody('NOT_FOUND', 'route not found'), 404))

  app.onError((error, c) => {
    logger.error({ method: c.req.method, path: c.req.path, err: error }, 'request failed')

    // Причина лишається в логах: у тексті помилки бувають адреси й імена
    // внутрішніх сервісів, а їх не показують тому, хто прийшов ззовні.
    return c.json(errorBody('INTERNAL', 'internal error'), 500)
  })

  return app
}
