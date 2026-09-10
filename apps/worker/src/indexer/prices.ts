import { type Database, pricePoints } from '@drf/db'
import type { SolanaAddress } from '@drf/shared/schemas'
import {
  type CalendarDay,
  calendarDaySchema,
  type DayRange,
  dayRangeSchema,
  formatPriceUsd,
  PRICE_DECIMALS,
  type PriceSeries,
  type PriceSeriesProvider,
  type PriceUsd,
  priceUsdSchema,
  toCalendarDay,
} from '@drf/shared/scoring'
import { and, eq, gte, lte } from 'drizzle-orm'
import { z } from 'zod'

const DAY_MS = 86_400_000
const DAY_SECONDS = 86_400

export const DEFILLAMA_SOURCE = 'defillama'

const CHART_URL = 'https://coins.llama.fi/chart'
// Допуск пошуку котирування навколо півночі. Ширший зробив би сусідні дні
// сусідами однієї ціни, вужчий — залишив би дірки там, де торгів було мало.
const SEARCH_WIDTH = '12h'

export type HttpGet = (url: string) => Promise<unknown>

const chartSchema = z.object({
  coins: z.record(
    z.string(),
    z.object({
      prices: z.array(
        z.object({ timestamp: z.number().int().positive(), price: z.number().finite() }),
      ),
    }),
  ),
})

function daysBetween(from: CalendarDay, to: CalendarDay): number {
  return (Date.parse(to) - Date.parse(from)) / DAY_MS
}

// Котирування несе мітку спостереження, а не мітку дня: джерело віддає найближчу
// ціну в межах допуску, і вона регулярно лягає за секунди ДО півночі свого дня
// (заміряно на HONEY: 23:59:08 при запиті на 00:00). Округлення до найближчої
// півночі повертає день, який просили; обрізання зсунуло б увесь ряд на день назад.
function quotedDay(timestampSeconds: number): CalendarDay {
  return toCalendarDay(new Date(Math.round(timestampSeconds / DAY_SECONDS) * DAY_SECONDS * 1000))
}

export function createDefiLlamaPriceFeed(get: HttpGet): PriceSeriesProvider {
  return {
    source: DEFILLAMA_SOURCE,

    async dailyPrices(mint, range) {
      const { from, to } = dayRangeSchema.parse(range)
      const coin = `solana:${mint}`
      const span = daysBetween(from, to) + 1
      const chart = chartSchema.parse(
        await get(
          `${CHART_URL}/${coin}?start=${Date.parse(from) / 1000}&span=${span}&period=1d&searchWidth=${SEARCH_WIDTH}`,
        ),
      )

      const series = new Map<CalendarDay, PriceUsd>()
      for (const point of chart.coins[coin]?.prices ?? []) {
        const day = quotedDay(point.timestamp)
        // Нуль і від'ємне — це брак котирування, а не котирування (FR-004a).
        // Допуск на краях вікна дотягується до сусіднього дня, тож день поза
        // діапазоном тут не помилка, а зайвий рядок, який просто не наш.
        if (point.price <= 0 || day < from || day > to || series.has(day)) continue

        series.set(day, priceUsdSchema.parse(point.price.toFixed(PRICE_DECIMALS)))
      }

      return series
    },
  }
}

export function missingDays(range: DayRange, cached: PriceSeries): CalendarDay[] {
  const { from, to } = dayRangeSchema.parse(range)
  const missing: CalendarDay[] = []

  for (let ahead = 0; ahead <= daysBetween(from, to); ahead += 1) {
    const day = toCalendarDay(new Date(Date.parse(from) + ahead * DAY_MS))
    if (!cached.has(day)) missing.push(day)
  }

  return missing
}

async function readCached(
  db: Database,
  mint: SolanaAddress,
  range: DayRange,
): Promise<PriceSeries> {
  const rows = await db
    .select({ day: pricePoints.day, priceUsd: pricePoints.priceUsd })
    .from(pricePoints)
    .where(
      and(
        eq(pricePoints.mint, mint),
        gte(pricePoints.day, range.from),
        lte(pricePoints.day, range.to),
      ),
    )

  return new Map(
    rows.map((row) => [calendarDaySchema.parse(row.day), priceUsdSchema.parse(row.priceUsd)]),
  )
}

export function createCachedPriceSeries(input: {
  db: Database
  upstream: PriceSeriesProvider
}): PriceSeriesProvider {
  const { db, upstream } = input

  return {
    source: upstream.source,

    async dailyPrices(mint, range) {
      const window = dayRangeSchema.parse(range)
      const cached = await readCached(db, mint, window)

      const missing = missingDays(window, cached)
      const first = missing[0]
      const last = missing[missing.length - 1]
      if (first === undefined || last === undefined) return cached

      // Питаємо один проміжок від першої дірки до останньої, а не кожен день
      // окремо: день без котирування в джерела так і лишиться без нього, тож
      // сходити по нього ще раз доведеться в будь-якому разі.
      const fetched = await upstream.dailyPrices(mint, { from: first, to: last })
      const fresh = [...fetched].filter(([day]) => !cached.has(day))
      if (fresh.length > 0) {
        // Записане котирування не переписується: ліміт, уже порахований за цим
        // днем, не має мовчки поїхати від того, що джерело переглянуло історію.
        await db
          .insert(pricePoints)
          .values(
            fresh.map(([day, priceUsd]) => ({
              mint,
              day,
              priceUsd: formatPriceUsd(priceUsd),
              source: upstream.source,
            })),
          )
          .onConflictDoNothing()
      }

      // Ряд віддається за днями, а не в порядку «спершу кеш, потім свіже»: інакше
      // те, що читач бачить, залежало б від того, скільки днів уже лежало в кеші.
      return new Map(
        [...cached, ...fresh].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      )
    },
  }
}
