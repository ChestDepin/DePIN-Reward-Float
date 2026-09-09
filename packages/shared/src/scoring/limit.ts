import type { CalendarMonth, MonthlyPayouts } from './aggregate.ts'
import type { CalendarDay, PriceSeries, PriceUsd } from './price.ts'

export const BASIS_POINTS = 10_000n

// SPEC називає три фактори, але ані ваг, ані формули не задає. Числа живуть тут
// окремо саме тому, що це рішення продукту, а не властивість розрахунку.
export const MONTHS_OF_FLOW = 2n
export const VOLATILITY_CAP_BP = 5_000n

export type LimitOutcome =
  | {
      kind: 'limit'
      // Мікродолари, як `credit_profiles.limit_usd`.
      limitUsd: bigint
      medianMonthlyUsd: bigint
      stabilityBp: bigint
      // Уже зрізана на VOLATILITY_CAP_BP: розбір ліміту показує те, що на нього
      // подіяло, а не те, наскільки насправді хитався токен.
      volatilityBp: bigint
    }
  | { kind: 'incomplete-prices'; months: readonly CalendarMonth[] }

export function medianOf(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const middle = sorted.length >> 1

  const [upper] = sorted.slice(middle)
  const [lower] = sorted.length % 2 === 1 ? [upper] : sorted.slice(middle - 1)
  if (upper === undefined || lower === undefined) {
    throw new Error('a median needs at least one value')
  }

  return (lower + upper) / 2n
}

const DAY_MS = 86_400_000

function isNextDay(previous: CalendarDay, day: CalendarDay): boolean {
  return Date.parse(day) - Date.parse(previous) === DAY_MS
}

// Середня абсолютна ДЕННА зміна, а не відхилення котирувань від їхньої ж середньої
// за період: на трендовому ряді друге міряє падіння, а не волатильність. Заміряно
// 2026-08-31 на річних рядах — по відхиленню від середньої HONEY дає 7508 bp і HNT
// 5215 bp, обидва вище стелі, тож множник перетворювався на константу і жодного
// гаманця не розрізняв; ті самі ряди по денних змінах дають 462 bp і 387 bp.
// Середнє абсолютне, а не середньоквадратичне: корінь із bigint довелося б рахувати
// руками заради тієї самої за змістом величини.
export function priceVolatilityBp(prices: PriceSeries): bigint {
  const quotes = [...prices.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )

  const changes: bigint[] = []
  let previous: readonly [CalendarDay, PriceUsd] | undefined
  for (const [day, price] of quotes) {
    // Дірку в ряді не перестрибуємо: зміна за п'ять днів не є денною зміною, а
    // порахована як одна вона завищила б волатильність саме там, де даних бракує.
    if (previous !== undefined && isNextDay(previous[0], day)) {
      const before = previous[1]
      const moved = price > before ? price - before : before - price
      changes.push((moved * BASIS_POINTS) / before)
    }
    previous = [day, price]
  }

  // Нуль означає «нема чого міряти», а не «ціна стояла»: у ряді немає жодної пари
  // сусідніх днів. На денних котируваннях джерела такого не буває — на наших
  // токенах бракує 6 і 23 днів із 365.
  if (changes.length === 0) return 0n

  return changes.reduce((sum, change) => sum + change, 0n) / BigInt(changes.length)
}

export function computeCreditLimit(input: {
  months: readonly MonthlyPayouts[]
  prices: PriceSeries
}): LimitOutcome {
  const { months, prices } = input
  if (months.length === 0) throw new Error('a limit needs a period of at least one month')

  const values: bigint[] = []
  const unpriced: CalendarMonth[] = []
  for (const month of months) {
    if (month.valueUsd === null) unpriced.push(month.month)
    else values.push(month.valueUsd)
  }

  // FR-004a: неповний ціновий ряд глушить розрахунок цілком. Порахувати ліміт
  // по решті місяців означало б підставити замість них нуль.
  if (unpriced.length > 0) return { kind: 'incomplete-prices', months: unpriced }

  const paidMonths = months.filter((month) => month.payoutCount > 0).length
  const stabilityBp = (BigInt(paidMonths) * BASIS_POINTS) / BigInt(months.length)

  const measured = priceVolatilityBp(prices)
  const volatilityBp = measured > VOLATILITY_CAP_BP ? VOLATILITY_CAP_BP : measured

  const medianMonthlyUsd = medianOf(values)

  // Одне обрізання в кінці, а не після кожного множника: інакше той самий набір
  // даних дає різні числа залежно від порядку дій (SC-002).
  const limitUsd =
    (medianMonthlyUsd * MONTHS_OF_FLOW * stabilityBp * (BASIS_POINTS - volatilityBp)) /
    (BASIS_POINTS * BASIS_POINTS)

  return { kind: 'limit', limitUsd, medianMonthlyUsd, stabilityBp, volatilityBp }
}
