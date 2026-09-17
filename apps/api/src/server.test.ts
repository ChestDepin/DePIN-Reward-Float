import { createLogger } from '@drf/shared/log'
import { solanaAddressSchema } from '@drf/shared/schemas'
import { describe, expect, it } from 'vitest'
import { DataUnavailable } from './routes/errors.ts'
import type { PayoutActivitySource } from './routes/health.ts'
import type { CreditProfileStore } from './routes/limit.ts'
import type { PayoutHistorySource } from './routes/operators.ts'
import { createServer } from './server.ts'

const EMPTY: PayoutHistorySource = {
  read: async () => ({ payouts: [], networks: [], prices: new Map() }),
}

const NO_PROFILES: CreditProfileStore = {
  read: async () => [],
  write: async () => {},
}

const NO_ACTIVITY: PayoutActivitySource = {
  read: async () => ({ networks: [], activity: [] }),
}

const deps = (logger: ReturnType<typeof createLogger>) => ({
  logger,
  payouts: EMPTY,
  profiles: NO_PROFILES,
  activity: NO_ACTIVITY,
  webOrigins: ['http://localhost:5173'],
  now: () => new Date('2026-08-31T12:00:00.000Z'),
})

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
    const response = await createServer(deps(capture().logger)).request('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('mounts the payout-source alarm next to /health', async () => {
    const response = await createServer(deps(capture().logger)).request('/health/payout-sources')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', sources: [] })
  })

  it('says the data is unavailable when the payout activity cannot be read', async () => {
    const app = createServer({
      ...deps(capture().logger),
      activity: {
        read: async () => {
          throw new DataUnavailable('the payout activity')
        },
      },
    })

    const response = await app.request('/health/payout-sources')

    expect(response.status).toBe(503)
  })

  // Без цього заголовка сторінка не бачить нічого: вона завжди на іншому
  // походженні, ніж api.
  it('lets the configured web origin read the answer', async () => {
    const response = await createServer(deps(capture().logger)).request(
      '/v1/operators/4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy/limit',
      { headers: { origin: 'http://localhost:5173' } },
    )

    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('does not hand the same permission to an origin nobody configured', async () => {
    const response = await createServer(deps(capture().logger)).request(
      '/v1/operators/4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy/limit',
      { headers: { origin: 'https://not-ours.example' } },
    )

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('has /v1 mounted, so a path under it is a miss and not a wrong prefix', async () => {
    const response = await createServer(deps(capture().logger)).request('/v1/operators')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'route not found' },
    })
  })

  it('mounts the operator history under /v1', async () => {
    const wallet = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')

    const response = await createServer(deps(capture().logger)).request(
      `/v1/operators/${wallet}/payouts`,
    )

    expect(response.status).toBe(200)
  })

  it('mounts the credit limit under /v1 too', async () => {
    const wallet = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')

    const response = await createServer(deps(capture().logger)).request(
      `/v1/operators/${wallet}/limit`,
    )

    expect(response.status).toBe(200)
  })

  // FR-025: історію не вдалося прочитати — окремий стан, а не ліміт 0 і не
  // внутрішня помилка, за якою оператор нічого не може зробити.
  it('says the data is unavailable when the history cannot be read', async () => {
    const wallet = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')
    const app = createServer({
      ...deps(capture().logger),
      payouts: {
        read: async () => {
          throw new DataUnavailable('payouts')
        },
      },
    })

    const response = await app.request(`/v1/operators/${wallet}/limit`)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'DATA_UNAVAILABLE', message: 'the payout history could not be read' },
    })
  })

  it('logs the unreadable source instead of naming it to the caller', async () => {
    const { lines, logger } = capture()
    const app = createServer({
      ...deps(logger),
      payouts: {
        read: async () => {
          throw new DataUnavailable('select from payouts at 10.0.0.4')
        },
      },
    })

    await app.request('/v1/operators/4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy/limit')

    expect(JSON.stringify(lines)).toContain('10.0.0.4')
  })

  it('answers an unknown route in the shared error shape', async () => {
    const response = await createServer(deps(capture().logger)).request('/nothing-here')

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('turns a thrown error into 500 without handing the detail to the caller', async () => {
    const { logger } = capture()
    const app = createServer(deps(logger))
    app.get('/v1/boom', () => {
      throw new Error('connection to 10.0.0.4 refused')
    })

    const response = await app.request('/v1/boom')

    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('10.0.0.4')
  })

  it('logs the failed request with enough context to find it', async () => {
    const { lines, logger } = capture()
    const app = createServer(deps(logger))
    app.get('/v1/boom', () => {
      throw new Error('connection to 10.0.0.4 refused')
    })

    await app.request('/v1/boom')

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 'error', method: 'GET', path: '/v1/boom' })
  })
})
