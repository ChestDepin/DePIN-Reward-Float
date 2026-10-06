import type { IssuedAttestation, IssuedRateAttestation } from '@drf/shared/api'
import {
  limitAttestationSchema,
  rateAttestationSchema,
  signLimitAttestation,
  signRateAttestation,
} from '@drf/shared/attestation'
import type { SolanaAddress } from '@drf/shared/schemas'
import { base58 } from '@scure/base'

// The api's ATTESTATION_TTL_MS; the borrow has to land inside it like any other.
const VALID_FOR_MS = 5 * 60_000
// The api's rate lifetime.
const RATE_VALID_FOR_MS = 2 * 60_000

// What POST /v1/operators/:address/attestations answers, signed with the same key and
// the same serialisation, minus the credit profile behind the limit: SC-004 is about the
// transaction, and the limit itself is SC-001's and SC-002's to prove.
export async function attestationFor(input: {
  operator: SolanaAddress
  attestor: { secretKey: Uint8Array; address: SolanaAddress }
  limitBaseUnits: bigint
  nonce: bigint
  at: Date
}): Promise<IssuedAttestation> {
  const expiresAt = new Date(input.at.getTime() + VALID_FOR_MS)
  const signed = await signLimitAttestation(
    limitAttestationSchema.parse({
      operator: input.operator,
      limitBaseUnits: input.limitBaseUnits,
      computedAt: input.at,
      expiresAt,
      nonce: input.nonce,
    }),
    input.attestor.secretKey,
  )
  return {
    wallet: input.operator,
    nonce: input.nonce.toString(),
    limitBaseUnits: input.limitBaseUnits.toString(),
    attestor: input.attestor.address,
    message: base58.encode(signed.message),
    signature: base58.encode(signed.signature),
    computedAt: input.at.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }
}

// What POST /v1/attestations/rate answers, at a rate made up for the run: the bench
// measures the transaction, and any rate sizes some reward allowance.
export async function rateAttestationFor(input: {
  rewardMint: SolanaAddress
  attestor: { secretKey: Uint8Array; address: SolanaAddress }
  stablePerTrillionReward: bigint
  at: Date
}): Promise<IssuedRateAttestation> {
  const expiresAt = new Date(input.at.getTime() + RATE_VALID_FOR_MS)
  const signed = await signRateAttestation(
    rateAttestationSchema.parse({
      rewardMint: input.rewardMint,
      stablePerTrillionReward: input.stablePerTrillionReward,
      pricedAt: input.at,
      expiresAt,
    }),
    input.attestor.secretKey,
  )
  return {
    rewardMint: input.rewardMint,
    stablePerTrillionReward: input.stablePerTrillionReward.toString(),
    attestor: input.attestor.address,
    message: base58.encode(signed.message),
    signature: base58.encode(signed.signature),
    pricedAt: input.at.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }
}
