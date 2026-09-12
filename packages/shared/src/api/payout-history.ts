import { z } from 'zod'
import { solanaAddressSchema } from '../schemas/primitives.ts'
import { calendarMonthSchema, monthRangeSchema } from '../scoring/aggregate.ts'
import { calendarDaySchema } from '../scoring/price.ts'

// Цілі числа їдуть рядками: u64 не вміщається в JSON-число, а bigint у JSON не
// серіалізується взагалі. Масштаб у кожного свій і читається з сусіднього поля —
// токен у мінімальних одиницях мережі, вартість у мікродоларах, як `limit_usd`.
const wholeNumberSchema = z.string().regex(/^\d+$/, 'expected a whole number as a string')

export const payoutEntrySchema = z.object({
  signature: z.string(),
  source: solanaAddressSchema,
  amount: wholeNumberSchema,
  valueUsd: wholeNumberSchema.nullable(),
  slot: wholeNumberSchema,
  blockTime: z.iso.datetime({ offset: true }),
})

export type PayoutEntry = z.infer<typeof payoutEntrySchema>

export const payoutMonthSchema = z.object({
  month: calendarMonthSchema,
  payoutCount: z.number().int().nonnegative(),
  amount: wholeNumberSchema,
  // null — котирування є не на всі дні виплат місяця, тож сума невідома. Нуль
  // тут означав би «місяць без виплат», а це інше твердження (FR-004a).
  valueUsd: wholeNumberSchema.nullable(),
  daysWithoutPrice: z.array(calendarDaySchema),
})

export type PayoutMonth = z.infer<typeof payoutMonthSchema>

export const networkPayoutHistorySchema = z.object({
  networkId: z.string(),
  displayName: z.string(),
  token: z.object({ symbol: z.string(), decimals: z.number().int() }),
  months: z.array(payoutMonthSchema),
  payouts: z.array(payoutEntrySchema),
})

export type NetworkPayoutHistory = z.infer<typeof networkPayoutHistorySchema>

// Історія розкладена по мережах, а не злита в один список: у HONEY дев'ять
// знаків, у HNT вісім, і спільна сума в токенах була б беззмістовною.
export const payoutHistorySchema = z.object({
  wallet: solanaAddressSchema,
  period: monthRangeSchema,
  networks: z.array(networkPayoutHistorySchema),
})

export type PayoutHistory = z.infer<typeof payoutHistorySchema>
