import type { IssuedRateAttestation } from '@drf/shared/api'
import { rateAttestationSchema, signRateAttestation } from '@drf/shared/attestation'
import { type SolanaAddress, solanaAddressSchema } from '@drf/shared/schemas'
import { zValidator } from '@hono/zod-validator'
import { base58 } from '@scure/base'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Attestor } from './attestations.ts'
import { DataUnavailable, errorBody } from './errors.ts'

// FR-015b: long enough to sign one borrow in a wallet, short enough that a keeper
// cannot shop among old rates for the one that suits a sweep.
export const RATE_TTL_MS = 2 * 60_000
export const MAX_PRICE_AGE_MS = 5 * 60_000

// The stablecoin has 6 decimals and is taken at one dollar, as the credit limit is:
// micro-dollars are its base units. The rate is quoted per 10^12 reward base units.
const STABLE_PER_TRILLION_EXPONENT = 6 + 12

export type RateQuote = { usdPrice: number; decimals: number; pricedAt: Date }
export type RateSource = {
  supports(rewardMint: SolanaAddress): boolean
  // null: the market has no usable price for the token right now.
  quote(rewardMint: SolanaAddress): Promise<RateQuote | null>
}

export type AttestedRate = { stablePerTrillionReward: bigint; pricedAt: Date; expiresAt: Date }

const DECIMAL = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/

// Exact on the digits of the price as JavaScript prints it, because a float product
// can land just above a whole unit and round up to a rate nobody quoted.
export function stablePerTrillionReward(usdPrice: number, decimals: number): bigint {
  if (!Number.isFinite(usdPrice) || usdPrice <= 0) {
    throw new Error(`not a usable price: ${usdPrice}`)
  }
  const match = DECIMAL.exec(String(usdPrice))
  if (match === null) throw new Error(`cannot read the price ${usdPrice}`)
  const [, whole = '', fraction = '', exponent = '0'] = match
  const digits = BigInt(whole + fraction)
  const shift = Number(exponent) - fraction.length + STABLE_PER_TRILLION_EXPONENT - decimals
  if (shift >= 0) return digits * 10n ** BigInt(shift)
  const divisor = 10n ** BigInt(-shift)
  // Up, because the operator delegates debt / rate tokens: a higher rate never lets
  // the protocol hold more than the debt is worth (FR-014a).
  return (digits + divisor - 1n) / divisor
}

export function attestedRate(quote: RateQuote, now: Date): AttestedRate | null {
  if (now.getTime() - quote.pricedAt.getTime() > MAX_PRICE_AGE_MS) return null
  return {
    stablePerTrillionReward: stablePerTrillionReward(quote.usdPrice, quote.decimals),
    pricedAt: quote.pricedAt,
    expiresAt: new Date(now.getTime() + RATE_TTL_MS),
  }
}

const rateRequest = zValidator(
  'json',
  z.object({ rewardMint: solanaAddressSchema }),
  (result, c) => {
    if (result.success) return
    return c.json(errorBody('INVALID_INPUT', 'expected { rewardMint: <mint address> }'), 400)
  },
)

export function createRateRoutes({
  rates,
  attestor,
  now,
}: {
  rates: RateSource | null
  attestor: Attestor
  now: () => Date
}): Hono {
  const routes = new Hono()

  routes.post('/attestations/rate', rateRequest, async (c) => {
    if (rates === null) {
      return c.json(errorBody('DATA_UNAVAILABLE', 'rates are not set up'), 503)
    }
    const { rewardMint } = c.req.valid('json')
    if (!rates.supports(rewardMint)) {
      return c.json(errorBody('NOT_FOUND', 'no network is tied to this mint'), 404)
    }

    let quote: RateQuote | null
    try {
      quote = await rates.quote(rewardMint)
    } catch (error) {
      if (!(error instanceof DataUnavailable)) throw error
      return c.json(errorBody('DATA_UNAVAILABLE', 'the rate could not be read'), 503)
    }
    const at = now()
    const attested = quote === null ? null : attestedRate(quote, at)
    if (attested === null) {
      return c.json(errorBody('DATA_UNAVAILABLE', 'no fresh rate for this mint'), 503)
    }

    const signed = await signRateAttestation(
      rateAttestationSchema.parse({ rewardMint, ...attested }),
      attestor.secretKey,
    )
    const body: IssuedRateAttestation = {
      rewardMint,
      stablePerTrillionReward: attested.stablePerTrillionReward.toString(),
      attestor: attestor.address,
      message: base58.encode(signed.message),
      signature: base58.encode(signed.signature),
      pricedAt: attested.pricedAt.toISOString(),
      expiresAt: attested.expiresAt.toISOString(),
    }
    return c.json(body, 201)
  })

  return routes
}
