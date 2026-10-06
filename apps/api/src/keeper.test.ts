import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { rateFromApp } from './keeper.ts'

const MINT = '5pbCV2sjzLPiYoY48ic1kmS5juTpjeN27ProW6v3QFS'
const issued = {
  rewardMint: MINT,
  stablePerTrillionReward: '2406662',
  attestor: '7ykbVJHDcHVzXXn9Bd5MNRLpqHt4gPvVsHkTBQMJqTL6',
  message: '3J98t1WpEZ73CNmQ',
  signature: '7ykbVJHDcHVzXXn9',
  pricedAt: '2026-10-07T10:00:00.000Z',
  expiresAt: '2026-10-07T10:02:00.000Z',
}

describe('rateFromApp', () => {
  it('asks the rate route of the same process and returns what it signed', async () => {
    const asked: unknown[] = []
    const app = new Hono().post('/v1/attestations/rate', async (c) => {
      asked.push(await c.req.json())
      return c.json(issued, 201)
    })

    await expect(rateFromApp(app)(MINT)).resolves.toEqual(issued)
    expect(asked).toEqual([{ rewardMint: MINT }])
  })

  it('fails with the route’s status and code when no rate is signed', async () => {
    const app = new Hono().post('/v1/attestations/rate', (c) =>
      c.json({ error: { code: 'DATA_UNAVAILABLE', message: 'no fresh rate for this mint' } }, 503),
    )

    await expect(rateFromApp(app)(MINT)).rejects.toThrow(/503.*no fresh rate/)
  })

  it('refuses an answer that is not a rate attestation', async () => {
    const app = new Hono().post('/v1/attestations/rate', (c) =>
      c.json({ ...issued, message: '' }, 201),
    )

    await expect(rateFromApp(app)(MINT)).rejects.toThrow()
  })
})
