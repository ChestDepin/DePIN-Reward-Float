import { z } from 'zod'
import type { RewardNetwork } from '../schemas/network.ts'
import type { RecognisedPayout } from './classify.ts'
import {
  type CalendarDay,
  PRICE_DECIMALS,
  type PriceSeries,
  type PriceUsd,
  toCalendarDay,
} from './price.ts'

export const USD_DECIMALS = 6

export const calendarMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected a YYYY-MM month')
  .brand<'CalendarMonth'>()

export type CalendarMonth = z.infer<typeof calendarMonthSchema>

export const monthRangeSchema = z
  .object({ from: calendarMonthSchema, to: calendarMonthSchema })
  .refine(({ from, to }) => from <= to, 'the period ends before it starts')

export type MonthRange = z.infer<typeof monthRangeSchema>

export type MonthlyPayouts = {
  month: CalendarMonth
  payoutCount: number
  amount: bigint
  // null — не всі виплати місяця мають котирування, тож сума невідома. Нуль тут
  // означав би «місяць без виплат», а це інше твердження (FR-004a).
  valueUsd: bigint | null
  daysWithoutPrice: readonly CalendarDay[]
}

// Дзеркало `formatPriceUsd` для колонок `numeric(20,6)`: у домені вартість —
// мікродолари цілим числом, у базі — десятковий рядок, і різниця в останньому
// розряді тут була б різницею в грошах.
export const usdAmountSchema = z
  .string()
  .regex(
    new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${USD_DECIMALS}})?$`),
    `expected a decimal amount with at most ${USD_DECIMALS} fractional digits`,
  )
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.')
    return BigInt(`${whole}${fraction.padEnd(USD_DECIMALS, '0')}`)
  })

export function formatUsd(units: bigint): string {
  const scale = 10n ** BigInt(USD_DECIMALS)

  return `${units / scale}.${(units % scale).toString().padStart(USD_DECIMALS, '0')}`
}

export function payoutValueUsd(amount: bigint, decimals: number, price: PriceUsd): bigint {
  return (amount * price) / 10n ** BigInt(decimals + PRICE_DECIMALS - USD_DECIMALS)
}

export function toCalendarMonth(instant: Date): CalendarMonth {
  return calendarMonthSchema.parse(instant.toISOString().slice(0, 7))
}

function eachMonth(from: CalendarMonth, to: CalendarMonth): CalendarMonth[] {
  const months: CalendarMonth[] = []
  let year = Number(from.slice(0, 4))
  let month = Number(from.slice(5, 7))
  let current = from

  while (current <= to) {
    months.push(current)
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
    current = calendarMonthSchema.parse(`${year}-${String(month).padStart(2, '0')}`)
  }

  return months
}

type Bucket = {
  payoutCount: number
  amount: bigint
  valueUsd: bigint | null
  daysWithoutPrice: Set<CalendarDay>
}

export function aggregateMonthlyPayouts(input: {
  payouts: readonly RecognisedPayout[]
  network: RewardNetwork
  prices: PriceSeries
  period: MonthRange
}): readonly MonthlyPayouts[] {
  const { payouts, network, prices } = input
  const { from, to } = monthRangeSchema.parse(input.period)

  // Місяці розкладаються наперед на весь період: FR-004 рахує стабільність як
  // кількість місяців без пропусків, а місяць без виплат не лишає по собі
  // жодної виплати, з якої його можна було б вивести.
  const buckets = new Map<CalendarMonth, Bucket>(
    eachMonth(from, to).map((month) => [
      month,
      { payoutCount: 0, amount: 0n, valueUsd: 0n, daysWithoutPrice: new Set<CalendarDay>() },
    ]),
  )

  for (const payout of payouts) {
    if (payout.networkId !== network.id) {
      throw new Error(
        `payout ${payout.signature} belongs to ${payout.networkId}, not to ${network.id}`,
      )
    }

    const month = toCalendarMonth(payout.blockTime)
    const bucket = buckets.get(month)
    if (bucket === undefined) {
      throw new Error(`payout ${payout.signature} falls in ${month}, outside ${from}..${to}`)
    }

    const day = toCalendarDay(payout.blockTime)
    const price = prices.get(day)

    bucket.payoutCount += 1
    bucket.amount += payout.amount

    if (price === undefined) {
      bucket.daysWithoutPrice.add(day)
      bucket.valueUsd = null
    } else if (bucket.valueUsd !== null) {
      bucket.valueUsd += payoutValueUsd(payout.amount, network.token.decimals, price)
    }
  }

  return [...buckets].map(([month, bucket]) => ({
    month,
    payoutCount: bucket.payoutCount,
    amount: bucket.amount,
    valueUsd: bucket.valueUsd,
    daysWithoutPrice: [...bucket.daysWithoutPrice].sort(),
  }))
}
