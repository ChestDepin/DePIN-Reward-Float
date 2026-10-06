import { signAsync } from '@noble/ed25519'
import { base58 } from '@scure/base'
import { z } from 'zod'
import { baseUnitsSchema, instantSchema, solanaAddressSchema } from '../schemas/primitives.ts'

// The same attestor key signs credit limits; the tag keeps one from parsing as the other.
const TAG = new TextEncoder().encode('drf:rat1')

const MINT_OFFSET = TAG.length
const RATE_OFFSET = MINT_OFFSET + 32
const PRICED_AT_OFFSET = RATE_OFFSET + 8
const EXPIRES_AT_OFFSET = PRICED_AT_OFFSET + 8

export const RATE_ATTESTATION_BYTES = EXPIRES_AT_OFFSET + 8

const SECRET_KEY_BYTES = 32

// No nonce and no operator: a rate is a public fact, and presenting it twice before it
// expires claims nothing new.
export const rateAttestationSchema = z
  .object({
    // The devnet mint the program sees on the loan, not the mainnet token that was priced.
    rewardMint: solanaAddressSchema,
    // Stablecoin base units for 10^12 reward base units: independent of either mint's
    // decimals, and still seven significant digits for a token at a fraction of a cent.
    stablePerTrillionReward: baseUnitsSchema.refine(
      (rate) => rate > 0n,
      'a zero rate values any delegation at nothing',
    ),
    // When the price was observed, not when it was signed: the program judges its age.
    pricedAt: instantSchema,
    expiresAt: instantSchema,
  })
  .refine(
    ({ pricedAt, expiresAt }) => toUnixSeconds(expiresAt) > toUnixSeconds(pricedAt),
    'a rate that expires when it is priced is never valid on chain',
  )

export type RateAttestation = z.infer<typeof rateAttestationSchema>

export type SignedRateAttestation = {
  message: Uint8Array
  signature: Uint8Array
}

// Truncated like the limit attestation: rounding up would keep it valid a second longer.
function toUnixSeconds(instant: Date): bigint {
  return BigInt(Math.floor(instant.getTime() / 1000))
}

export function serializeRateAttestation(attestation: RateAttestation): Uint8Array {
  const message = new Uint8Array(RATE_ATTESTATION_BYTES)
  const view = new DataView(message.buffer)

  message.set(TAG, 0)
  message.set(base58.decode(attestation.rewardMint), MINT_OFFSET)
  view.setBigUint64(RATE_OFFSET, attestation.stablePerTrillionReward, true)
  view.setBigInt64(PRICED_AT_OFFSET, toUnixSeconds(attestation.pricedAt), true)
  view.setBigInt64(EXPIRES_AT_OFFSET, toUnixSeconds(attestation.expiresAt), true)

  return message
}

export async function signRateAttestation(
  attestation: RateAttestation,
  secretKey: Uint8Array,
): Promise<SignedRateAttestation> {
  if (secretKey.length !== SECRET_KEY_BYTES) {
    throw new Error(`an attestor secret key is ${SECRET_KEY_BYTES} bytes, got ${secretKey.length}`)
  }

  const message = serializeRateAttestation(attestation)

  return { message, signature: await signAsync(message, secretKey) }
}
