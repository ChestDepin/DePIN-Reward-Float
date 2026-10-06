import { issuedRateAttestationSchema } from '@drf/shared/api'
import { rateAttestationSchema, serializeRateAttestation } from '@drf/shared/attestation'
import { type SolanaAddress, solanaAddressSchema } from '@drf/shared/schemas'
import { verifyAsync } from '@noble/ed25519'
import { base58, hex } from '@scure/base'
import { describe, expect, it } from 'vitest'
import { DataUnavailable } from './errors.ts'
import {
  attestedRate,
  createRateRoutes,
  MAX_PRICE_AGE_MS,
  RATE_TTL_MS,
  type RateQuote,
  type RateSource,
  stablePerTrillionReward,
} from './rate.ts'

// RFC 8032, test 1: a seed and the public key derived from it.
const SECRET_KEY = hex.decode('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
const PUBLIC_KEY = hex.decode('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
const ATTESTOR = {
  secretKey: SECRET_KEY,
  address: solanaAddressSchema.parse(base58.encode(PUBLIC_KEY)),
}

const NOW = new Date('2026-10-06T12:00:00.000Z')
const DEVNET_HONEY = solanaAddressSchema.parse('5pbCV2sjzLPiYoY48ic1kmS5juTpjeN27ProW6v3QFS')
const UNKNOWN_MINT = solanaAddressSchema.parse('Hvfc8s2Z7EU3dcY4LDNHbkHrJ7EgDg5iaFnLzaUdALYh')

// Jupiter's HONEY price on 2026-10-06, priced 28 seconds before the request.
const HONEY_QUOTE: RateQuote = {
  usdPrice: 0.0023922837836002826,
  decimals: 9,
  pricedAt: new Date(NOW.getTime() - 28_000),
}

describe('stablePerTrillionReward', () => {
  it('turns a dollar price into stablecoin units per 10^12 reward units', () => {
    expect(stablePerTrillionReward(0.0022784388963531643, 9)).toBe(2_278_439n)
    expect(stablePerTrillionReward(0.5146358844105925, 8)).toBe(5_146_358_845n)
    expect(stablePerTrillionReward(120, 9)).toBe(120_000_000_000n)
  })

  // Float arithmetic gives 0.29 * 1e9 = 290000000.00000006, which rounds up to a
  // unit that nobody quoted.
  it('works on the decimal digits of the price, not on float products', () => {
    expect(stablePerTrillionReward(0.29, 9)).toBe(290_000_000n)
  })

  it('reads prices that print in exponent form', () => {
    expect(stablePerTrillionReward(1e-7, 9)).toBe(100n)
    expect(stablePerTrillionReward(1e21, 18)).toBe(1_000_000_000_000_000_000_000n)
  })

  // Up, because the operator delegates debt / rate tokens: a higher rate never lets the
  // protocol hold more than the debt is worth (FR-014a).
  it('rounds a fraction of a unit up', () => {
    expect(stablePerTrillionReward(1.5e-12, 9)).toBe(1n)
  })

  it('refuses a price that is not a positive number', () => {
    expect(() => stablePerTrillionReward(0, 9)).toThrow()
    expect(() => stablePerTrillionReward(-1, 9)).toThrow()
    expect(() => stablePerTrillionReward(Number.NaN, 9)).toThrow()
    expect(() => stablePerTrillionReward(Number.POSITIVE_INFINITY, 9)).toThrow()
  })
})

describe('attestedRate', () => {
  it('signs for two minutes from now and keeps the moment of the price itself', () => {
    expect(attestedRate(HONEY_QUOTE, NOW)).toEqual({
      stablePerTrillionReward: 2_392_284n,
      pricedAt: HONEY_QUOTE.pricedAt,
      expiresAt: new Date(NOW.getTime() + RATE_TTL_MS),
    })
  })

  it('still signs a price exactly at the age limit', () => {
    const atLimit = { ...HONEY_QUOTE, pricedAt: new Date(NOW.getTime() - MAX_PRICE_AGE_MS) }

    expect(attestedRate(atLimit, NOW)).not.toBeNull()
  })

  it('refuses a price older than the limit', () => {
    const stale = { ...HONEY_QUOTE, pricedAt: new Date(NOW.getTime() - MAX_PRICE_AGE_MS - 1000) }

    expect(attestedRate(stale, NOW)).toBeNull()
  })
})

function source(quotes: Map<SolanaAddress, RateQuote | null | Error>): RateSource {
  return {
    supports: (mint) => quotes.has(mint),
    async quote(mint) {
      const quote = quotes.get(mint)
      if (quote instanceof Error) throw quote
      return quote ?? null
    },
  }
}

function app(rates: RateSource | null) {
  return createRateRoutes({ rates, attestor: ATTESTOR, now: () => NOW })
}

const ask = (rates: RateSource | null, body: unknown) =>
  app(rates).request('/attestations/rate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /attestations/rate', () => {
  it('issues a rate attestation the attestor key verifies', async () => {
    const response = await ask(source(new Map([[DEVNET_HONEY, HONEY_QUOTE]])), {
      rewardMint: DEVNET_HONEY,
    })

    expect(response.status).toBe(201)
    const body = issuedRateAttestationSchema.parse(await response.json())
    expect(body).toEqual({
      rewardMint: DEVNET_HONEY,
      stablePerTrillionReward: '2392284',
      attestor: ATTESTOR.address,
      message: body.message,
      signature: body.signature,
      pricedAt: '2026-10-06T11:59:32.000Z',
      expiresAt: '2026-10-06T12:02:00.000Z',
    })

    const expected = serializeRateAttestation(
      rateAttestationSchema.parse({
        rewardMint: DEVNET_HONEY,
        stablePerTrillionReward: 2_392_284n,
        pricedAt: body.pricedAt,
        expiresAt: body.expiresAt,
      }),
    )
    expect(body.message).toBe(base58.encode(expected))
    expect(
      await verifyAsync(base58.decode(body.signature), base58.decode(body.message), PUBLIC_KEY),
    ).toBe(true)
  })

  it('says so when the api has no rate source configured', async () => {
    const response = await ask(null, { rewardMint: DEVNET_HONEY })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'DATA_UNAVAILABLE', message: 'rates are not set up' },
    })
  })

  it('does not know a mint that no network is tied to', async () => {
    const response = await ask(source(new Map([[DEVNET_HONEY, HONEY_QUOTE]])), {
      rewardMint: UNKNOWN_MINT,
    })

    expect(response.status).toBe(404)
  })

  it('refuses rather than sign a stale price', async () => {
    const stale = { ...HONEY_QUOTE, pricedAt: new Date(NOW.getTime() - 10 * 60_000) }
    const response = await ask(source(new Map([[DEVNET_HONEY, stale]])), {
      rewardMint: DEVNET_HONEY,
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'DATA_UNAVAILABLE', message: 'no fresh rate for this mint' },
    })
  })

  it('refuses when the market has no price for the token', async () => {
    const response = await ask(source(new Map([[DEVNET_HONEY, null]])), {
      rewardMint: DEVNET_HONEY,
    })

    expect(response.status).toBe(503)
  })

  it('answers an unreachable price source with 503, not with a server error', async () => {
    const down = new DataUnavailable('the Jupiter price', { cause: new Error('ECONNRESET') })
    const response = await ask(source(new Map([[DEVNET_HONEY, down]])), {
      rewardMint: DEVNET_HONEY,
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'DATA_UNAVAILABLE', message: 'the rate could not be read' },
    })
  })

  it('rejects a body without a mint address', async () => {
    const response = await ask(source(new Map()), { rewardMint: 'not-a-key' })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: 'INVALID_INPUT', message: 'expected { rewardMint: <mint address> }' },
    })
  })
})
