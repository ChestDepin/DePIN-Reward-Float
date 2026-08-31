import { createLogger } from '@drf/shared/log'
import { describe, expect, it } from 'vitest'
import { createServer } from './server.ts'

function capture() {
  const lines: Record<string, unknown>[] = []

  return {
    lines,
    logger: createLogger({
      service: 'api-test',
      destination: {
        write(chunk: string) {
          lines.push(JSON.parse(chunk))
        },
      },
    }),
  }
}

describe('createServer', () => {
  it('answers /health', async () => {
    const response = await createServer({ logger: capture().logger }).request('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('has /v1 mounted, so a path under it is a miss and not a wrong prefix', async () => {
    const response = await createServer({ logger: capture().logger }).request('/v1/operators')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'route not found' },
    })
  })

  it('answers an unknown route in the shared error shape', async () => {
    const response = await createServer({ logger: capture().logger }).request('/nothing-here')

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('turns a thrown error into 500 without handing the detail to the caller', async () => {
    const { logger } = capture()
    const app = createServer({ logger })
    app.get('/v1/boom', () => {
      throw new Error('connection to 10.0.0.4 refused')
    })

    const response = await app.request('/v1/boom')

    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('10.0.0.4')
  })

  it('logs the failed request with enough context to find it', async () => {
    const { lines, logger } = capture()
    const app = createServer({ logger })
    app.get('/v1/boom', () => {
      throw new Error('connection to 10.0.0.4 refused')
    })

    await app.request('/v1/boom')

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'error', method: 'GET', path: '/v1/boom' })
  })
})
