import { createDatabase } from '@drf/db'
import { createLogger } from '@drf/shared/log'
import { solanaAddressSchema } from '@drf/shared/schemas'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'

const WALLET = '7ykbVJHDcHVzXXn9Bd5MNRLpqHt4gPvVsHkTBQMJqTL6'
const ORIGIN = 'https://operator.example.com'

// Драйвер з'єднується при першому запиті, тож на адресі, де ніхто не слухає,
// складання проходить, а перше читання відмовляє одразу.
const UNREACHABLE = 'postgres://drf:drf@127.0.0.1:1/drf'

// Маршрут атестацій тут не кличуть: пара потрібна лише щоб зібрати застосунок.
const ATTESTOR = {
  secretKey: new Uint8Array(32),
  address: solanaAddressSchema.parse('11111111111111111111111111111111'),
}

describe('createApp', () => {
  const { db, close } = createDatabase(UNREACHABLE)
  const app = createApp({
    db,
    logger: createLogger({ service: 'api-test', level: 'fatal' }),
    attestor: ATTESTOR,
    webOrigins: [ORIGIN],
    now: () => new Date('2026-09-22T12:00:00.000Z'),
  })

  afterAll(() => close())

  it('answers /health without touching the database', async () => {
    const response = await app.request('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('lets the configured page origin read /v1', async () => {
    const response = await app.request(`/v1/operators/${WALLET}/payouts`, {
      headers: { origin: ORIGIN },
    })

    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  it('wires the database-backed sources, so an unreachable database is a 503', async () => {
    const response = await app.request(`/v1/operators/${WALLET}/payouts`)

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'DATA_UNAVAILABLE' } })
  })
})
