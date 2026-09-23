import { verifyAsync } from '@noble/ed25519'
import { base58, hex } from '@scure/base'
import { describe, expect, it } from 'vitest'
import {
  LIMIT_ATTESTATION_BYTES,
  limitAttestationSchema,
  serializeLimitAttestation,
  signLimitAttestation,
} from './limit.ts'

const OPERATOR = '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy'

const ATTESTATION = {
  operator: OPERATOR,
  limitBaseUnits: 1_000_000n,
  computedAt: '2026-09-23T10:00:00.000Z',
  expiresAt: '2026-09-24T10:00:00.000Z',
  nonce: 7n,
}

// Зібраний окремо від реалізації: тег в ASCII, адреса — base58-декодуванням,
// числа — байтами little-endian. Якщо розкладка поїде, програма з T035 перестане
// читати те саме повідомлення, а тест про це мовчатиме, поки він не дослівний.
const GOLDEN =
  '6472663a6c696d31' +
  '3a3e72b67ea94e1765004ef68244f6b0b32ddde743a33b20f91430e1e817c1ac' +
  '40420f0000000000' +
  '20a3b36a00000000' +
  'a0f4b46a00000000' +
  '0700000000000000'

// RFC 8032, test 1: сід і виведений із нього публічний ключ.
const SECRET_KEY = hex.decode('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
const PUBLIC_KEY = hex.decode('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')

describe('limitAttestationSchema', () => {
  it('reads the moments and the amounts of a well-formed attestation', () => {
    const parsed = limitAttestationSchema.parse(ATTESTATION)

    expect(parsed.operator).toBe(OPERATOR)
    expect(parsed.limitBaseUnits).toBe(1_000_000n)
    expect(parsed.computedAt.toISOString()).toBe('2026-09-23T10:00:00.000Z')
    expect(parsed.nonce).toBe(7n)
  })

  it('rejects an attestation that expires before it was computed', () => {
    const inverted = { ...ATTESTATION, expiresAt: '2026-09-23T09:00:00.000Z' }

    expect(limitAttestationSchema.safeParse(inverted).success).toBe(false)
  })

  it('rejects an attestation that expires in the same second it was computed', () => {
    const instant = { ...ATTESTATION, expiresAt: ATTESTATION.computedAt }

    expect(limitAttestationSchema.safeParse(instant).success).toBe(false)
  })

  it('rejects a limit the program could not hold in a u64', () => {
    const tooLarge = { ...ATTESTATION, limitBaseUnits: 18_446_744_073_709_551_616n }

    expect(limitAttestationSchema.safeParse(tooLarge).success).toBe(false)
  })

  it('rejects an operator that is not a 32-byte address', () => {
    const short = { ...ATTESTATION, operator: 'HvmDemo7xK2qF4b9WgQn3sT8yLcRzA1eU6dJ5mNpVe' }

    expect(limitAttestationSchema.safeParse(short).success).toBe(false)
  })
})

describe('serializeLimitAttestation', () => {
  it('writes the 72-byte layout the program parses', () => {
    const message = serializeLimitAttestation(limitAttestationSchema.parse(ATTESTATION))

    expect(message.length).toBe(LIMIT_ATTESTATION_BYTES)
    expect(hex.encode(message)).toBe(GOLDEN)
  })

  it('puts the raw operator key where the program reads a pubkey', () => {
    const message = serializeLimitAttestation(limitAttestationSchema.parse(ATTESTATION))

    expect(message.slice(8, 40)).toEqual(base58.decode(OPERATOR))
  })

  it('keeps a limit at the top of the u64 range exact', () => {
    const atMax = limitAttestationSchema.parse({
      ...ATTESTATION,
      limitBaseUnits: 18_446_744_073_709_551_615n,
    })

    expect(hex.encode(serializeLimitAttestation(atMax).slice(40, 48))).toBe('ffffffffffffffff')
  })

  it('reads the same moment from a Date and from its ISO text', () => {
    const fromText = serializeLimitAttestation(limitAttestationSchema.parse(ATTESTATION))
    const fromDate = serializeLimitAttestation(
      limitAttestationSchema.parse({
        ...ATTESTATION,
        computedAt: new Date(ATTESTATION.computedAt),
        expiresAt: new Date(ATTESTATION.expiresAt),
      }),
    )

    expect(hex.encode(fromDate)).toBe(hex.encode(fromText))
  })

  // Ончейн момент — це секунди, і дві атестації, розраховані в одну секунду,
  // мають давати однакові байти: інакше «та сама атестація» з FR-012b залежить
  // від мілісекунд, яких у програмі немає.
  it('drops the milliseconds instead of rounding the second up', () => {
    const late = limitAttestationSchema.parse({
      ...ATTESTATION,
      computedAt: '2026-09-23T10:00:00.999Z',
    })

    expect(hex.encode(serializeLimitAttestation(late))).toBe(GOLDEN)
  })
})

describe('signLimitAttestation', () => {
  it('signs the canonical message so the attestor key verifies it', async () => {
    const attestation = limitAttestationSchema.parse(ATTESTATION)
    const signed = await signLimitAttestation(attestation, SECRET_KEY)

    expect(hex.encode(signed.message)).toBe(GOLDEN)
    expect(signed.signature.length).toBe(64)
    expect(await verifyAsync(signed.signature, signed.message, PUBLIC_KEY)).toBe(true)
  })

  it('does not carry over to an attestation for a larger limit', async () => {
    const signed = await signLimitAttestation(limitAttestationSchema.parse(ATTESTATION), SECRET_KEY)
    const raised = serializeLimitAttestation(
      limitAttestationSchema.parse({ ...ATTESTATION, limitBaseUnits: 2_000_000n }),
    )

    expect(await verifyAsync(signed.signature, raised, PUBLIC_KEY)).toBe(false)
  })

  it('refuses an expanded 64-byte secret key instead of signing with its first half', async () => {
    const expanded = new Uint8Array([...SECRET_KEY, ...PUBLIC_KEY])

    await expect(
      signLimitAttestation(limitAttestationSchema.parse(ATTESTATION), expanded),
    ).rejects.toThrow(/32/)
  })
})
