import { type CalendarMonth, type MonthlyPayouts, payoutValueUsd } from './aggregate.ts'
import {
  type CalendarDay,
  type DayRange,
  type PriceSeries,
  type PriceUsd,
  toCalendarDay,
} from './price.ts'

export const BASIS_POINTS = 10_000n

// SPEC називає три фактори, але ані ваг, ані формули не задає. Числа живуть тут
// окремо саме тому, що це рішення продукту, а не властивість розрахунку.
export const MONTHS_OF_FLOW = 2n
export const VOLATILITY_CAP_BP = 5_000n
// Недавня ціна береться медіаною за вікно, а не спотом: одна свічка на тонкому
// ринку не має рухати ліміт.
export const RECENT_PRICE_DAYS = 30

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
  // FR-004a: без недавньої ціни ліміт не рахується взагалі, і це інше твердження,
  // ніж «ліміт 0». Вікно віддається назвати, щоб відповідь могла сказати, де саме
  // котирувань не знайшлося.
  | { kind: 'no-recent-price'; window: DayRange }

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

// Вікно закінчується останнім днем періоду, а не останнім днем ряду: інакше ряд,
// що обірвався три місяці тому, сам оголосив би свою останню ціну недавньою.
export function recentPriceWindow(last: CalendarMonth): DayRange {
  const endOfMonth = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 0))

  return {
    from: toCalendarDay(new Date(endOfMonth.getTime() - (RECENT_PRICE_DAYS - 1) * DAY_MS)),
    to: toCalendarDay(endOfMonth),
  }
}

// Серединне котирування, а не середнє двох середніх: недавня ціна має бути ціною,
// яка справді була, а не вигаданою точкою між двома.
function medianQuote(prices: PriceSeries, window: DayRange): PriceUsd | undefined {
  const quotes = [...prices]
    .filter(([day]) => day >= window.from && day <= window.to)
    .map(([, price]) => price)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

  return quotes[quotes.length >> 1]
}

export function computeCreditLimit(input: {
  months: readonly MonthlyPayouts[]
  prices: PriceSeries
  decimals: number
}): LimitOutcome {
  const { months, prices, decimals } = input
  const last = months[months.length - 1]
  if (last === undefined) throw new Error('a limit needs a period of at least one month')

  const window = recentPriceWindow(last.month)
  const recentPrice = medianQuote(prices, window)
  if (recentPrice === undefined) return { kind: 'no-recent-price', window }

  const paidMonths = months.filter((month) => month.payoutCount > 0).length
  const stabilityBp = (BigInt(paidMonths) * BASIS_POINTS) / BigInt(months.length)

  const measured = priceVolatilityBp(prices)
  const volatilityBp = measured > VOLATILITY_CAP_BP ? VOLATILITY_CAP_BP : measured

  // Потік береться в токенах і оцінюється однією недавньою ціною: оцінка кожного
  // місяця ціною того ж місяця кредитує під вартість, якої вже не існує, тоді як
  // позика гаситься майбутніми винагородами за майбутніми цінами.
  const medianMonthlyUsd = payoutValueUsd(
    medianOf(months.map((month) => month.amount)),
    decimals,
    recentPrice,
  )

  // Одне обрізання в кінці, а не після кожного множника: інакше той самий набір
  // даних дає різні числа залежно від порядку дій (SC-002).
  const limitUsd =
    (medianMonthlyUsd * MONTHS_OF_FLOW * stabilityBp * (BASIS_POINTS - volatilityBp)) /
    (BASIS_POINTS * BASIS_POINTS)

  return { kind: 'limit', limitUsd, medianMonthlyUsd, stabilityBp, volatilityBp }
}
