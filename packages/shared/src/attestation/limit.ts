import { signAsync } from '@noble/ed25519'
import { base58 } from '@scure/base'
import { z } from 'zod'
import { baseUnitsSchema, instantSchema, solanaAddressSchema } from '../schemas/primitives.ts'

// Перші вісім байтів кажуть, ЩО підписано. Тим самим ключем підписується ще й
// атестація курсу (FR-015b), і без розрізнювача байти однієї могли б розібратися
// як інша. Цифра в кінці — версія розкладки: зміна формату має ламатися голосно.
const TAG = new TextEncoder().encode('drf:lim1')

const OPERATOR_OFFSET = TAG.length
const LIMIT_OFFSET = OPERATOR_OFFSET + 32
const COMPUTED_AT_OFFSET = LIMIT_OFFSET + 8
const EXPIRES_AT_OFFSET = COMPUTED_AT_OFFSET + 8
const NONCE_OFFSET = EXPIRES_AT_OFFSET + 8

export const LIMIT_ATTESTATION_BYTES = NONCE_OFFSET + 8

const SECRET_KEY_BYTES = 32

export const limitAttestationSchema = z
  .object({
    operator: solanaAddressSchema,
    // Мінімальні одиниці стейблкоїна, а не мікродолари: програма рухає токен, і
    // на стейблкоїні з іншою кількістю знаків ці числа розійшлися б.
    limitBaseUnits: baseUnitsSchema,
    computedAt: instantSchema,
    expiresAt: instantSchema,
    // Підписаний, бо саме ним програма впізнає повторне подання (FR-012b).
    // Непідписаний нонс міняє будь-хто, і одноразовість перестає бути властивістю.
    nonce: baseUnitsSchema,
  })
  .refine(
    ({ computedAt, expiresAt }) => toUnixSeconds(expiresAt) > toUnixSeconds(computedAt),
    'an attestation that expires when it is computed is never valid on chain',
  )

export type LimitAttestation = z.infer<typeof limitAttestationSchema>

export type SignedLimitAttestation = {
  message: Uint8Array
  signature: Uint8Array
}

// Ончейн-годинник іде в секундах, тож момент зрізається, а не округлюється:
// округлення вгору зробило б атестацію чинною на секунду довше, ніж обіцяно.
function toUnixSeconds(instant: Date): bigint {
  return BigInt(Math.floor(instant.getTime() / 1000))
}

export function serializeLimitAttestation(attestation: LimitAttestation): Uint8Array {
  const message = new Uint8Array(LIMIT_ATTESTATION_BYTES)
  const view = new DataView(message.buffer)

  message.set(TAG, 0)
  message.set(base58.decode(attestation.operator), OPERATOR_OFFSET)
  view.setBigUint64(LIMIT_OFFSET, attestation.limitBaseUnits, true)
  view.setBigInt64(COMPUTED_AT_OFFSET, toUnixSeconds(attestation.computedAt), true)
  view.setBigInt64(EXPIRES_AT_OFFSET, toUnixSeconds(attestation.expiresAt), true)
  view.setBigUint64(NONCE_OFFSET, attestation.nonce, true)

  return message
}

export async function signLimitAttestation(
  attestation: LimitAttestation,
  secretKey: Uint8Array,
): Promise<SignedLimitAttestation> {
  // Ключ оператора Solana часто носять розширеним на 64 байти; підписати його
  // першою половиною мовчки — значить видати атестацію іншим ключем, ніж той,
  // що записаний у стані програми.
  if (secretKey.length !== SECRET_KEY_BYTES) {
    throw new Error(`an attestor secret key is ${SECRET_KEY_BYTES} bytes, got ${secretKey.length}`)
  }

  const message = serializeLimitAttestation(attestation)

  return { message, signature: await signAsync(message, secretKey) }
}
