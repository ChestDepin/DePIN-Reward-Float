import { issuedAttestationSchema } from '@drf/shared/api'
import { serializeLimitAttestation } from '@drf/shared/attestation'
import { solanaAddressSchema } from '@drf/shared/schemas'
import { base58 } from '@scure/base'
import { describe, expect, it } from 'vitest'
import { attestationFor } from './borrow-attestation.ts'

const OPERATOR = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')
const ATTESTOR_ADDRESS = solanaAddressSchema.parse('9n7CAm5gV7hCCWG8gGP2CwXdoX3YYvXkZfpqqmH4c2rP')
const SECRET_KEY = new Uint8Array(32).fill(7)
const AT = new Date('2026-10-05T12:00:00.000Z')

describe('the attestation a measured borrow is issued', () => {
  const issue = (overrides: { secretKey?: Uint8Array } = {}) =>
    attestationFor({
      operator: OPERATOR,
      attestor: { secretKey: overrides.secretKey ?? SECRET_KEY, address: ATTESTOR_ADDRESS },
      limitBaseUnits: 10_000_000n,
      nonce: 3n,
      at: AT,
    })

  it('has the shape the api answers with', async () => {
    const attestation = issuedAttestationSchema.parse(await issue())

    expect(attestation.wallet).toBe(OPERATOR)
    expect(attestation.attestor).toBe(ATTESTOR_ADDRESS)
    expect([attestation.nonce, attestation.limitBaseUnits]).toEqual(['3', '10000000'])
  })

  it('carries exactly the bytes the program reads, valid for five minutes from now', async () => {
    const attestation = await issue()

    expect(base58.decode(attestation.message)).toEqual(
      serializeLimitAttestation({
        operator: OPERATOR,
        limitBaseUnits: 10_000_000n,
        computedAt: AT,
        expiresAt: new Date(AT.getTime() + 5 * 60_000),
        nonce: 3n,
      }),
    )
    expect(base58.decode(attestation.signature)).toHaveLength(64)
    expect(attestation.expiresAt).toBe('2026-10-05T12:05:00.000Z')
  })

  it('refuses a 64-byte Solana secret key in place of the attestor seed', async () => {
    await expect(issue({ secretKey: new Uint8Array(64) })).rejects.toThrow(/32 bytes/)
  })
})
