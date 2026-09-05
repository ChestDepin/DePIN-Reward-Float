import type { CalendarMonth, MonthlyPayouts } from './aggregate.ts'
import type { PriceSeries } from './price.ts'

const BASIS_POINTS = 10_000n

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

// Середнє абсолютне відхилення, а не середньоквадратичне: корінь із bigint довелося
// б рахувати руками заради тієї самої за змістом величини, а MAD ще й менше
// смикається від одного викиду в ряді.
export function priceVolatilityBp(prices: PriceSeries): bigint {
  const quotes = [...prices.values()]
  // Ряд, коротший за дві точки, не рухався. Заниженою волатильністю це ліміт не
  // завищує: такий ряд означає щонайбільше один день із виплатою за весь період,
  // а на ньому медіана місячного потоку і так нульова.
  if (quotes.length < 2) return 0n

  const count = BigInt(quotes.length)
  const mean = quotes.reduce((sum, quote) => sum + quote, 0n) / count
  const deviation =
    quotes.reduce((sum, quote) => sum + (quote > mean ? quote - mean : mean - quote), 0n) / count

  return (deviation * BASIS_POINTS) / mean
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
