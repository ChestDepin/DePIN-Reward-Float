import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createDatabase, type Database, pricePoints } from '@drf/db'
import { solanaAddressSchema } from '@drf/shared/schemas'
import {
  type CalendarDay,
  calendarDaySchema,
  type DayRange,
  type PriceSeries,
  type PriceSeriesProvider,
  priceUsdSchema,
} from '@drf/shared/scoring'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createCachedPriceSeries,
  createDefiLlamaPriceFeed,
  type HttpGet,
  missingDays,
} from './prices.ts'

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL

  try {
    const file = readFileSync(
      path.join(import.meta.dirname, '..', '..', '..', '..', '.env'),
      'utf8',
    )
    return file
      .split(/\r?\n/)
      .find((line) => line.startsWith('DATABASE_URL='))
      ?.slice('DATABASE_URL='.length)
  } catch {
    return undefined
  }
}

const url = databaseUrl()

const HONEY = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')
const COIN = `solana:${HONEY}`

// Мінт існує тільки в цьому тесті: кешовані рядки чистяться по ньому, тож живий
// прогін не чіпає котирувань, знятих із мейннету.
const TEST_MINT = solanaAddressSchema.parse('t45kYhVdVpTk5UxirScKYqs4rhuTFN6E1aDvb31x2km')

// Справжня відповідь coins.llama.fi, знята 2026-08-31: п'ять днів HONEY від
// 2025-10-29. Кожне котирування має мітку за 52 секунди ДО півночі свого дня.
const CHART = {
  coins: {
    [COIN]: {
      symbol: 'HONEY',
      confidence: 0.99,
      decimals: 9,
      prices: [
        { timestamp: 1_761_695_948, price: 0.01009924716532389 },
        { timestamp: 1_761_782_345, price: 0.009343394443257907 },
        { timestamp: 1_761_868_739, price: 0.009137722348290009 },
        { timestamp: 1_761_955_206, price: 0.01356265540907553 },
        { timestamp: 1_762_041_600, price: 0.011486186345051089 },
      ],
    },
  },
}

const day = (value: string): CalendarDay => calendarDaySchema.parse(value)
const range = (from: string, to: string): DayRange => ({ from: day(from), to: day(to) })

const quotes = (byDay: Record<string, string>): PriceSeries =>
  new Map(Object.entries(byDay).map(([at, price]) => [day(at), priceUsdSchema.parse(price)]))

const chartOf = (prices: readonly { timestamp: number; price: number }[]) => ({
  coins: { [COIN]: { symbol: 'HONEY', confidence: 0.99, decimals: 9, prices } },
})

const asking = (payload: unknown) => {
  const urls: string[] = []
  const get: HttpGet = async (requested) => {
    urls.push(requested)
    return payload
  }

  return { urls, feed: createDefiLlamaPriceFeed(get) }
}

const upstreamOf = (answer: PriceSeries) => {
  const asked: DayRange[] = []
  const provider: PriceSeriesProvider = {
    source: 'test-feed',
    async dailyPrices(_mint, window) {
      asked.push(window)
      return answer
    },
  }

  return { asked, provider }
}

describe('createDefiLlamaPriceFeed', () => {
  it('dates a quote by the midnight it was searched around, not by the minute it carries', async () => {
    const { feed } = asking(CHART)

    const series = await feed.dailyPrices(HONEY, range('2025-10-29', '2025-11-02'))

    expect([...series.keys()]).toEqual([
      '2025-10-29',
      '2025-10-30',
      '2025-10-31',
      '2025-11-01',
      '2025-11-02',
    ])
    expect(series.get(day('2025-10-29'))).toBe(priceUsdSchema.parse('0.010099247165323890'))
    expect(series.get(day('2025-11-02'))).toBe(priceUsdSchema.parse('0.011486186345051089'))
  })

  it('asks for exactly the span it was given, at a twelve-hour tolerance', async () => {
    const { urls, feed } = asking(CHART)

    await feed.dailyPrices(HONEY, range('2025-10-29', '2025-11-02'))

    expect(urls).toEqual([
      `https://coins.llama.fi/chart/${COIN}?start=1761696000&span=5&period=1d&searchWidth=12h`,
    ])
  })

  it('leaves out a quote that falls outside the range it asked for', async () => {
    const { feed } = asking(CHART)

    const series = await feed.dailyPrices(HONEY, range('2025-10-30', '2025-10-31'))

    expect([...series.keys()]).toEqual(['2025-10-30', '2025-10-31'])
  })

  it('treats a non-positive price as a day without a quote', async () => {
    const { feed } = asking(
      chartOf([
        { timestamp: 1_761_695_948, price: 0 },
        { timestamp: 1_761_782_345, price: 0.009343394443257907 },
      ]),
    )

    const series = await feed.dailyPrices(HONEY, range('2025-10-29', '2025-10-30'))

    expect([...series.keys()]).toEqual(['2025-10-30'])
  })

  it('keeps the first quote when the source sends two for one day', async () => {
    const { feed } = asking(
      chartOf([
        { timestamp: 1_761_695_948, price: 0.01 },
        { timestamp: 1_761_700_000, price: 0.02 },
      ]),
    )

    const series = await feed.dailyPrices(HONEY, range('2025-10-29', '2025-10-29'))

    expect(series.get(day('2025-10-29'))).toBe(priceUsdSchema.parse('0.01'))
  })

  it('returns nothing for a mint the source does not know', async () => {
    const { feed } = asking({ coins: {} })

    const series = await feed.dailyPrices(HONEY, range('2025-10-29', '2025-10-31'))

    expect(series.size).toBe(0)
  })

  it('refuses a payload that is not a price chart', async () => {
    const { feed } = asking({ coins: { [COIN]: { prices: 'soon' } } })

    await expect(feed.dailyPrices(HONEY, range('2025-10-29', '2025-10-31'))).rejects.toThrow()
  })
})

describe('missingDays', () => {
  it('names every day of the range the cache does not hold', () => {
    const cached = quotes({ '2025-10-30': '0.0093' })

    expect(missingDays(range('2025-10-29', '2025-10-31'), cached)).toEqual([
      '2025-10-29',
      '2025-10-31',
    ])
  })

  it('is empty when the cache covers the range', () => {
    const cached = quotes({ '2025-10-29': '0.01', '2025-10-30': '0.0093' })

    expect(missingDays(range('2025-10-29', '2025-10-30'), cached)).toEqual([])
  })
})

describe.skipIf(url === undefined)('cached prices against a live postgres', () => {
  let db: Database
  let close: () => Promise<void>

  beforeAll(() => {
    if (url === undefined) throw new Error('unreachable: the suite is skipped without a url')
    const handle = createDatabase(url)
    db = handle.db
    close = handle.close
  })

  beforeEach(async () => {
    await db.delete(pricePoints).where(eq(pricePoints.mint, TEST_MINT))
  })

  afterAll(async () => {
    await db.delete(pricePoints).where(eq(pricePoints.mint, TEST_MINT))
    await close()
  })

  const seed = async (byDay: Record<string, string>) => {
    await db.insert(pricePoints).values(
      Object.entries(byDay).map(([at, price]) => ({
        mint: TEST_MINT,
        day: at,
        priceUsd: price,
        source: 'seed',
      })),
    )
  }

  it('serves a fully cached range without asking the source', async () => {
    await seed({ '2025-10-29': '0.01', '2025-10-30': '0.02' })
    const { asked, provider } = upstreamOf(quotes({ '2025-10-29': '0.09' }))

    const series = await createCachedPriceSeries({ db, upstream: provider }).dailyPrices(
      TEST_MINT,
      range('2025-10-29', '2025-10-30'),
    )

    expect(asked).toEqual([])
    expect(series.get(day('2025-10-29'))).toBe(priceUsdSchema.parse('0.01'))
  })

  it('asks the source only for the span it is missing, and keeps what came back', async () => {
    await seed({ '2025-10-30': '0.02' })
    const { asked, provider } = upstreamOf(quotes({ '2025-10-29': '0.01', '2025-10-31': '0.03' }))
    const prices = createCachedPriceSeries({ db, upstream: provider })

    const first = await prices.dailyPrices(TEST_MINT, range('2025-10-29', '2025-10-31'))
    const second = await prices.dailyPrices(TEST_MINT, range('2025-10-29', '2025-10-31'))

    expect(asked).toEqual([range('2025-10-29', '2025-10-31')])
    expect([...first.keys()]).toEqual(['2025-10-29', '2025-10-30', '2025-10-31'])
    expect(second).toEqual(first)
  })

  it('keeps the quote it already cached when the source answers differently', async () => {
    await seed({ '2025-10-29': '0.01' })
    const { provider } = upstreamOf(quotes({ '2025-10-29': '0.09', '2025-10-30': '0.02' }))

    const series = await createCachedPriceSeries({ db, upstream: provider }).dailyPrices(
      TEST_MINT,
      range('2025-10-29', '2025-10-30'),
    )

    expect(series.get(day('2025-10-29'))).toBe(priceUsdSchema.parse('0.01'))
  })

  it('leaves a day the source has no quote for missing, and asks again next time', async () => {
    const { asked, provider } = upstreamOf(quotes({ '2025-10-29': '0.01' }))
    const prices = createCachedPriceSeries({ db, upstream: provider })

    const first = await prices.dailyPrices(TEST_MINT, range('2025-10-29', '2025-10-30'))
    await prices.dailyPrices(TEST_MINT, range('2025-10-29', '2025-10-30'))

    expect([...first.keys()]).toEqual(['2025-10-29'])
    expect(asked).toEqual([range('2025-10-29', '2025-10-30'), range('2025-10-30', '2025-10-30')])
  })
})
