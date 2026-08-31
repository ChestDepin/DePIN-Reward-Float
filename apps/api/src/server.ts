import { Hono } from 'hono'
import type { Logger } from 'pino'

export type ServerDeps = {
  logger: Logger
}

function errorBody(code: 'NOT_FOUND' | 'INTERNAL', message: string) {
  return { error: { code, message } }
}

export function createServer({ logger }: ServerDeps): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Порожній навмисно: роути приходять зі своїми задачами. Точка монтування
  // існує з самого початку, щоб префікс жив в одному місці, а не в кожному роуті.
  app.route('/v1', new Hono())

  app.notFound((c) => c.json(errorBody('NOT_FOUND', 'route not found'), 404))

  app.onError((error, c) => {
    logger.error({ method: c.req.method, path: c.req.path, err: error }, 'request failed')

    // Причина лишається в логах: у тексті помилки бувають адреси й імена
    // внутрішніх сервісів, а їх не показують тому, хто прийшов ззовні.
    return c.json(errorBody('INTERNAL', 'internal error'), 500)
  })

  return app
}
