import { verifyAsync } from '@noble/ed25519'
import { base58, hex } from '@scure/base'
import { describe, expect, it } from 'vitest'
import { limitAttestationSchema, serializeLimitAttestation } from './limit.ts'
import {
  RATE_ATTESTATION_BYTES,
  rateAttestationSchema,
  serializeRateAttestation,
  signRateAttestation,
} from './rate.ts'

const REWARD_MINT = '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy'

// 1000 HONEY at $0.002278438 is 2.278438 USDC.
const ATTESTATION = {
  rewardMint: REWARD_MINT,
  stablePerTrillionReward: 2_278_438n,
  pricedAt: '2026-10-06T10:00:00.000Z',
  expiresAt: '2026-10-06T10:02:00.000Z',
}

// Built apart from the implementation: the tag in ASCII, the mint by base58 decoding,
// the numbers as little-endian bytes. The program reads exactly these bytes.
const GOLDEN =
  '6472663a72617431' +
  '3a3e72b67ea94e1765004ef68244f6b0b32ddde743a33b20f91430e1e817c1ac' +
  '26c4220000000000' +
  'a0c6c46a00000000' +
  '18c7c46a00000000'

// RFC 8032, test 1: a seed and the public key derived from it.
const SECRET_KEY = hex.decode('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
const PUBLIC_KEY = hex.decode('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')

describe('rateAttestationSchema', () => {
  it('reads the mint, the rate and the moments of a well-formed attestation', () => {
    const parsed = rateAttestationSchema.parse(ATTESTATION)

    expect(parsed.rewardMint).toBe(REWARD_MINT)
    expect(parsed.stablePerTrillionReward).toBe(2_278_438n)
    expect(parsed.pricedAt.toISOString()).toBe('2026-10-06T10:00:00.000Z')
    expect(parsed.expiresAt.toISOString()).toBe('2026-10-06T10:02:00.000Z')
  })

  // A zero rate values any delegation at nothing, so "the delegated amount is worth no
  // more than the debt" would hold for an unlimited approval.
  it('rejects a zero rate', () => {
    const free = { ...ATTESTATION, stablePerTrillionReward: 0n }

    expect(rateAttestationSchema.safeParse(free).success).toBe(false)
  })

  it('rejects a rate the program could not hold in a u64', () => {
    const tooLarge = { ...ATTESTATION, stablePerTrillionReward: 18_446_744_073_709_551_616n }

    expect(rateAttestationSchema.safeParse(tooLarge).success).toBe(false)
  })

  it('rejects an attestation that expires no later than the price it carries', () => {
    expect(
      rateAttestationSchema.safeParse({ ...ATTESTATION, expiresAt: ATTESTATION.pricedAt }).success,
    ).toBe(false)
    expect(
      rateAttestationSchema.safeParse({ ...ATTESTATION, expiresAt: '2026-10-06T09:59:00.000Z' })
        .success,
    ).toBe(false)
  })

  it('rejects a mint that is not a 32-byte address', () => {
    const short = { ...ATTESTATION, rewardMint: 'HvmDemo7xK2qF4b9WgQn3sT8yLcRzA1eU6dJ5mNpVe' }

    expect(rateAttestationSchema.safeParse(short).success).toBe(false)
  })
})

describe('serializeRateAttestation', () => {
  it('writes the 64-byte layout the program parses', () => {
    const message = serializeRateAttestation(rateAttestationSchema.parse(ATTESTATION))

    expect(message.length).toBe(RATE_ATTESTATION_BYTES)
    expect(hex.encode(message)).toBe(GOLDEN)
  })

  it('puts the raw mint key where the program reads a pubkey', () => {
    const message = serializeRateAttestation(rateAttestationSchema.parse(ATTESTATION))

    expect(message.slice(8, 40)).toEqual(base58.decode(REWARD_MINT))
  })

  it('keeps a rate at the top of the u64 range exact', () => {
    const atMax = rateAttestationSchema.parse({
      ...ATTESTATION,
      stablePerTrillionReward: 18_446_744_073_709_551_615n,
    })

    expect(hex.encode(serializeRateAttestation(atMax).slice(40, 48))).toBe('ffffffffffffffff')
  })

  it('drops the milliseconds instead of rounding the second up', () => {
    const late = rateAttestationSchema.parse({
      ...ATTESTATION,
      pricedAt: '2026-10-06T10:00:00.999Z',
      expiresAt: '2026-10-06T10:02:00.999Z',
    })

    expect(hex.encode(serializeRateAttestation(late))).toBe(GOLDEN)
  })

  // One attestor key signs both kinds; the tag is what keeps a rate from being read
  // as a credit limit.
  it('cannot be mistaken for a limit attestation', () => {
    const rate = serializeRateAttestation(rateAttestationSchema.parse(ATTESTATION))
    const limit = serializeLimitAttestation(
      limitAttestationSchema.parse({
        operator: REWARD_MINT,
        limitBaseUnits: 1n,
        computedAt: ATTESTATION.pricedAt,
        expiresAt: ATTESTATION.expiresAt,
        nonce: 1n,
      }),
    )

    expect(hex.encode(rate.slice(0, 8))).not.toBe(hex.encode(limit.slice(0, 8)))
  })
})

describe('signRateAttestation', () => {
  it('signs the canonical message so the attestor key verifies it', async () => {
    const signed = await signRateAttestation(rateAttestationSchema.parse(ATTESTATION), SECRET_KEY)

    expect(hex.encode(signed.message)).toBe(GOLDEN)
    expect(await verifyAsync(signed.signature, signed.message, PUBLIC_KEY)).toBe(true)
  })

  it('does not carry over to a different rate', async () => {
    const signed = await signRateAttestation(rateAttestationSchema.parse(ATTESTATION), SECRET_KEY)
    const cheaper = serializeRateAttestation(
      rateAttestationSchema.parse({ ...ATTESTATION, stablePerTrillionReward: 1_000_000n }),
    )

    expect(await verifyAsync(signed.signature, cheaper, PUBLIC_KEY)).toBe(false)
  })

  it('refuses an expanded 64-byte secret key instead of signing with its first half', async () => {
    const expanded = new Uint8Array([...SECRET_KEY, ...PUBLIC_KEY])

    await expect(
      signRateAttestation(rateAttestationSchema.parse(ATTESTATION), expanded),
    ).rejects.toThrow(/32/)
  })
})
