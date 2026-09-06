import { type CalendarMonth, calendarMonthSchema, type MonthlyPayouts } from './aggregate.ts'

// Рішення 2026-08-31: шість непорожніх місяців із дванадцяти, підряд
// не обов'язково. «Регулярність» із критерію приймання читається саме так.
export const REQUIRED_PAID_MONTHS = 6

export type Eligibility =
  | { kind: 'eligible' }
  | {
      kind: 'short-history'
      paidMonths: number
      periodMonths: number
      // Найраніший місяць, у якому поріг буде досягнутий, якщо виплати
      // приходитимуть щомісяця починаючи з наступного. Місяць, а не день:
      // історія агрегована помісячно, тож точніша дата була б вигаданою.
      thresholdReachedIn: CalendarMonth
    }
  | { kind: 'incomplete-prices'; months: readonly CalendarMonth[] }

const isPaid = (month: MonthlyPayouts) => month.payoutCount > 0

function addMonths(month: CalendarMonth, count: number): CalendarMonth {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count

  return calendarMonthSchema.parse(
    `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`,
  )
}

// Вікно котиться разом із періодом: за кожен новий місяць найстаріший із нього
// випадає. Тому давно оплачені місяці поріг не наближають, а віддаляють — саме
// їх втрачає оператор, поки набирає нові.
function projectThresholdMonth(months: readonly MonthlyPayouts[], last: CalendarMonth) {
  for (let ahead = 1; ahead < REQUIRED_PAID_MONTHS; ahead += 1) {
    const kept = months.slice(ahead).filter(isPaid).length
    if (kept + ahead >= REQUIRED_PAID_MONTHS) return addMonths(last, ahead)
  }

  return addMonths(last, REQUIRED_PAID_MONTHS)
}

export function assessEligibility(months: readonly MonthlyPayouts[]): Eligibility {
  if (months.length < REQUIRED_PAID_MONTHS) {
    throw new Error(
      `a period of ${months.length} months can never hold ${REQUIRED_PAID_MONTHS} paid ones`,
    )
  }

  const last = months[months.length - 1]
  if (last === undefined) throw new Error('a period needs a last month to count forward from')

  const paidMonths = months.filter(isPaid).length
  // Порядок відмов: коротка історія не залежить від котирувань і не зміниться,
  // коли вони доїдуть. Назвати брак цін першим означало б пообіцяти ліміт,
  // якого не буде і з повним ціновим рядом.
  if (paidMonths < REQUIRED_PAID_MONTHS) {
    return {
      kind: 'short-history',
      paidMonths,
      periodMonths: months.length,
      thresholdReachedIn: projectThresholdMonth(months, last.month),
    }
  }

  const unpriced = months.filter((month) => month.valueUsd === null).map((month) => month.month)
  if (unpriced.length > 0) return { kind: 'incomplete-prices', months: unpriced }

  return { kind: 'eligible' }
}
