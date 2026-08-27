import { base58 } from '@scure/base'
import { z } from 'zod'

const PUBKEY_BYTES = 32
const U64_MAX = 18_446_744_073_709_551_615n

// Довжина в символах base58 не визначає довжину в байтах, тому перевіряємо
// декодуванням: рядок правильного вигляду може розкодуватись у 31 байт.
export const solanaAddressSchema = z
  .string()
  .refine((value) => {
    try {
      return base58.decode(value).length === PUBKEY_BYTES
    } catch {
      return false
    }
  }, 'not a base58-encoded 32-byte address')
  .brand<'SolanaAddress'>()

export type SolanaAddress = z.infer<typeof solanaAddressSchema>

// Суми ходять у мінімальних одиницях токена і тільки як bigint: u64 більший за
// Number.MAX_SAFE_INTEGER, тож число мовчки втратило б молодші розряди.
export const baseUnitsSchema = z
  .union([z.bigint(), z.string().regex(/^\d+$/, 'expected whole minimal units')])
  .transform((value) => (typeof value === 'bigint' ? value : BigInt(value)))
  .refine((value) => value >= 0n && value <= U64_MAX, 'outside the u64 range')

export type BaseUnits = z.infer<typeof baseUnitsSchema>

// Число сюди не приймається навмисно: секунди й мілісекунди на вигляд однакові,
// а помилка в 1000 разів у моменті виплати не падає, а тихо зсуває історію.
export const instantSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
])

export type Instant = z.infer<typeof instantSchema>

const EARLIEST_BLOCK_TIME = 1_500_000_000
const LATEST_BLOCK_TIME = 4_102_444_800

// Єдиний дозволений спосіб перетворити число на момент — і він названий тим,
// звідки число приходить: blockTime у відповіді RPC.
export const blockTimeSchema = z
  .number()
  .int()
  .min(EARLIEST_BLOCK_TIME)
  .max(LATEST_BLOCK_TIME)
  .transform((seconds) => new Date(seconds * 1000))
