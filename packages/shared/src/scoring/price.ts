import { z } from 'zod'
import { type SolanaAddress, solanaAddressSchema } from '../schemas/primitives.ts'

const PRICE_DECIMALS = 18

export const calendarDaySchema = z.iso.date().brand<'CalendarDay'>()

export type CalendarDay = z.infer<typeof calendarDaySchema>

// Ціна приходить десятковим рядком і тільки ним: bigint на вході неоднозначний
// (1n — це долар чи 1e-18?), а number втратив би молодші розряди. Масштаб той
// самий, що в колонці `price_points.price_usd numeric(38,18)`.
export const priceUsdSchema = z
  .string()
  .regex(
    new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${PRICE_DECIMALS}})?$`),
    `expected a decimal price with at most ${PRICE_DECIMALS} fractional digits`,
  )
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.')
    return BigInt(`${whole}${fraction.padEnd(PRICE_DECIMALS, '0')}`)
  })
  // FR-004a: нуль замість котирування підставляти не можна, тож нуль і не є
  // котируванням — інакше вартість виплати за той день вийшла б нульовою.
  .refine((units) => units > 0n, 'a zero price is a missing quote, not a quote')
  .brand<'PriceUsd'>()

export type PriceUsd = z.infer<typeof priceUsdSchema>

export const dayRangeSchema = z
  .object({ from: calendarDaySchema, to: calendarDaySchema })
  .refine(({ from, to }) => from <= to, 'the range ends before it starts')

export type DayRange = z.infer<typeof dayRangeSchema>

// Відсутній ключ означає «котирування за той день немає». Дірку заповнює не
// провайдер: FR-004a вимагає показати брак даних, а не сховати його.
export type PriceSeries = ReadonlyMap<CalendarDay, PriceUsd>

export type PriceSeriesProvider = {
  readonly source: string
  dailyPrices(mint: SolanaAddress, range: DayRange): Promise<PriceSeries>
}

const priceQuoteSchema = z.object({
  mint: solanaAddressSchema,
  day: calendarDaySchema,
  priceUsd: priceUsdSchema,
})

export type PriceQuote = z.infer<typeof priceQuoteSchema>

export function createFixturePriceSeriesProvider(quotes: unknown): PriceSeriesProvider {
  const byMint = new Map<SolanaAddress, Map<CalendarDay, PriceUsd>>()

  for (const quote of z.array(priceQuoteSchema).parse(quotes)) {
    let days = byMint.get(quote.mint)
    if (days === undefined) {
      days = new Map()
      byMint.set(quote.mint, days)
    }

    // Той самий ключ, що й первинний у `price_points`: два котирування на один
    // день не суперечать одне одному тихо, залежно від порядку у фікстурі.
    if (days.has(quote.day)) {
      throw new Error(`duplicate quote for ${quote.mint} on ${quote.day}`)
    }
    days.set(quote.day, quote.priceUsd)
  }

  return {
    source: 'fixture',

    async dailyPrices(mint, range) {
      // Перевернутий діапазон інакше віддав би порожній ряд, який прочитається
      // як брак котирувань і зупинить розрахунок ліміту замість падіння тут.
      const { from, to } = dayRangeSchema.parse(range)
      const days = byMint.get(mint)
      const series = new Map<CalendarDay, PriceUsd>()

      for (const [day, price] of days ?? []) {
        if (day >= from && day <= to) series.set(day, price)
      }

      return series
    },
  }
}
