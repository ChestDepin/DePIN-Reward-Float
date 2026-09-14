import { z } from 'zod'
import { PAYOUT_CADENCES } from '../schemas/network.ts'
import { solanaAddressSchema } from '../schemas/primitives.ts'
import { calendarMonthSchema } from '../scoring/aggregate.ts'
import { dayRangeSchema } from '../scoring/price.ts'
import { wholeNumberSchema } from './payout-history.ts'

// Внесок фактора буває від'ємним: стабільність і волатильність ліміт знижують.
const signedWholeNumberSchema = z.string().regex(/^-?\d+$/, 'expected a whole number as a string')

export const limitFactorSchema = z.object({
  name: z.enum(['median-flow', 'stability', 'volatility']),
  deltaUsd: signedWholeNumberSchema,
})

export type LimitFactorView = z.infer<typeof limitFactorSchema>

// Причина відмови їде структурою, а не текстом: `FR-006` обіцяє назвати дату
// досягнення порогу, а `FR-004a` — вікно, у якому не знайшлося котирувань.
export const limitRefusalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('short-history'),
    requiredMonths: z.number().int().positive(),
    thresholdReachedIn: calendarMonthSchema,
  }),
  z.object({
    kind: z.literal('withdrawal-history'),
    cadence: z.enum(PAYOUT_CADENCES),
  }),
  z.object({ kind: z.literal('no-recent-price'), window: dayRangeSchema }),
])

export type LimitRefusal = z.infer<typeof limitRefusalSchema>

// Ліміт — на мережу, а не на гаманець: HONEY і HNT непорівнянні ані знаками, ані
// ціною, ані волатильністю, і одне число довелося б складати з непорівнянних.
export const networkCreditLimitSchema = z
  .object({
    networkId: z.string(),
    displayName: z.string(),
    token: z.object({ symbol: z.string(), decimals: z.number().int() }),
    // Мікродолари, як `credit_profiles.limit_usd`. null — ліміт не порахований, і
    // це інше твердження, ніж «ліміт 0» (FR-025).
    limitUsd: wholeNumberSchema.nullable(),
    factors: z.array(limitFactorSchema),
    reason: limitRefusalSchema.nullable(),
    computedAt: z.iso.datetime({ offset: true }),
    // FR-007: після цього моменту показувати число не можна, його перераховують.
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .refine(
    ({ limitUsd, reason }) => (limitUsd === null) === (reason !== null),
    'a limit and a refusal are the same statement said twice',
  )

export type NetworkCreditLimit = z.infer<typeof networkCreditLimitSchema>

export const creditLimitSchema = z.object({
  wallet: solanaAddressSchema,
  networks: z.array(networkCreditLimitSchema),
})

export type CreditLimit = z.infer<typeof creditLimitSchema>
