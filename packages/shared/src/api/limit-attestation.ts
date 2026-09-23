import { z } from 'zod'
import { solanaAddressSchema } from '../schemas/primitives.ts'
import { wholeNumberSchema } from './payout-history.ts'

const base58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'expected base58')

// Атестація видається на гаманець, а не на мережу: ончейн ліміт в оператора один
// (FR-012), і цей рядок — сума лімітів усіх мереж, які його мають.
export const issuedAttestationSchema = z.object({
  wallet: solanaAddressSchema,
  nonce: wholeNumberSchema,
  // Мінімальні одиниці стейблкоїна — те саме число, що підписане в `message`.
  limitBaseUnits: wholeNumberSchema,
  // Ключ, яким підписано: після ротації (FR-012c) у ланцюгу може стояти вже інший,
  // і власник атестації має бачити, чиїм підписом вона підписана.
  attestor: solanaAddressSchema,
  // Самі підписані байти, а не лише поля, з яких їх можна скласти: в Ed25519-
  // інструкцію їде рівно те, що підписано, і перескладання на боці сторінки
  // додало б другий опис формату, який ніхто не звіряє з першим.
  message: base58Schema,
  signature: base58Schema,
  computedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
})

export type IssuedAttestation = z.infer<typeof issuedAttestationSchema>
