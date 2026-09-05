import { describe, expect, it } from 'vitest'
import { solanaAddressSchema } from '../schemas/primitives.ts'
import { calendarDaySchema, createFixturePriceSeriesProvider, priceUsdSchema } from './price.ts'

const HONEY_MINT = 'B55r1aQEJhL8xba9ncHHrY7w2tsykbtewac2uYUmgLyP'
const HNT_MINT = 'Da5nJidcBhY7Ae6qCJTkJ3yDeGJkMjhURA5Ny9QEDTne'
const GRASS_MINT = 'G95USU96LZUv4MKKUUVfoG6oPbwrszovRykBYfQdBe3Q'

const honey = solanaAddressSchema.parse(HONEY_MINT)
const hnt = solanaAddressSchema.parse(HNT_MINT)
const grass = solanaAddressSchema.parse(GRASS_MINT)

const range = (from: string, to: string) => ({
  from: calendarDaySchema.parse(from),
  to: calendarDaySchema.parse(to),
})

const day = (value: string) => calendarDaySchema.parse(value)

const quotes = [
  { mint: HONEY_MINT, day: '2026-01-30', priceUsd: '0.041' },
  { mint: HONEY_MINT, day: '2026-01-31', priceUsd: '0.052' },
  { mint: HONEY_MINT, day: '2026-02-02', priceUsd: '0.048' },
  { mint: HONEY_MINT, day: '2026-02-03', priceUsd: '0.05' },
  { mint: HNT_MINT, day: '2026-02-02', priceUsd: '3.17' },
]

describe('calendarDaySchema', () => {
  it('accepts a calendar day', () => {
    expect(calendarDaySchema.parse('2026-02-28')).toBe('2026-02-28')
  })

  it('rejects a day that never happened', () => {
    expect(() => calendarDaySchema.parse('2026-02-30')).toThrow()
    expect(() => calendarDaySchema.parse('2025-02-29')).toThrow()
  })

  it('rejects a day that is not zero-padded', () => {
    expect(() => calendarDaySchema.parse('2026-2-3')).toThrow()
  })
})

describe('priceUsdSchema', () => {
  it('scales a decimal quote to the precision of the price column', () => {
    expect(priceUsdSchema.parse('0.052')).toBe(52_000_000_000_000_000n)
    expect(priceUsdSchema.parse('3.17')).toBe(3_170_000_000_000_000_000n)
    expect(priceUsdSchema.parse('12')).toBe(12_000_000_000_000_000_000n)
  })

  it('keeps the smallest representable quote', () => {
    expect(priceUsdSchema.parse('0.000000000000000001')).toBe(1n)
  })

  it('rejects a quote more precise than the column, instead of truncating it', () => {
    expect(() => priceUsdSchema.parse('0.0000000000000000001')).toThrow()
  })

  it('rejects a zero quote: a zero price is a missing quote, not a quote', () => {
    expect(() => priceUsdSchema.parse('0')).toThrow()
    expect(() => priceUsdSchema.parse('0.000')).toThrow()
  })

  it('rejects anything that is not a plain decimal', () => {
    expect(() => priceUsdSchema.parse('-0.052')).toThrow()
    expect(() => priceUsdSchema.parse('5.2e-2')).toThrow()
    expect(() => priceUsdSchema.parse('.052')).toThrow()
    expect(() => priceUsdSchema.parse('0.')).toThrow()
    expect(() => priceUsdSchema.parse('abc')).toThrow()
  })
})

describe('createFixturePriceSeriesProvider', () => {
  it('returns the quotes of one mint inside the range', async () => {
    const provider = createFixturePriceSeriesProvider(quotes)

    const series = await provider.dailyPrices(honey, range('2026-01-31', '2026-02-03'))

    expect([...series.keys()]).toEqual(['2026-01-31', '2026-02-02', '2026-02-03'])
    expect(series.get(day('2026-01-31'))).toBe(52_000_000_000_000_000n)
  })

  it('includes both ends of the range', async () => {
    const provider = createFixturePriceSeriesProvider(quotes)

    const series = await provider.dailyPrices(honey, range('2026-01-31', '2026-02-02'))

    expect([...series.keys()]).toEqual(['2026-01-31', '2026-02-02'])
  })

  it('does not leak the quotes of another mint', async () => {
    const provider = createFixturePriceSeriesProvider(quotes)

    const series = await provider.dailyPrices(hnt, range('2026-01-30', '2026-02-03'))

    expect([...series.keys()]).toEqual(['2026-02-02'])
    expect(series.get(day('2026-02-02'))).toBe(3_170_000_000_000_000_000n)
  })

  it('leaves a day without a quote absent, with no zero and no price carried over', async () => {
    const provider = createFixturePriceSeriesProvider(quotes)

    const series = await provider.dailyPrices(honey, range('2026-01-30', '2026-02-03'))

    expect(series.has(day('2026-02-01'))).toBe(false)
    expect(series.get(day('2026-02-01'))).toBeUndefined()
  })

  it('reports a mint it has never heard of as an empty series, not as an error', async () => {
    const provider = createFixturePriceSeriesProvider(quotes)

    const series = await provider.dailyPrices(grass, range('2026-01-30', '2026-02-03'))

    expect(series.size).toBe(0)
  })

  it('rejects two quotes for the same mint and day', () => {
    expect(() =>
      createFixturePriceSeriesProvider([
        { mint: HONEY_MINT, day: '2026-02-02', priceUsd: '0.048' },
        { mint: HONEY_MINT, day: '2026-02-02', priceUsd: '0.049' },
      ]),
    ).toThrow(/2026-02-02/)
  })

  it('rejects a malformed quote', () => {
    expect(() =>
      createFixturePriceSeriesProvider([{ mint: HONEY_MINT, day: '2026-02-02', priceUsd: '0' }]),
    ).toThrow()
    expect(() =>
      createFixturePriceSeriesProvider([
        { mint: 'not-an-address', day: '2026-02-02', priceUsd: '1' },
      ]),
    ).toThrow()
  })

  it('rejects a range that ends before it starts', async () => {
    const provider = createFixturePriceSeriesProvider(quotes)

    await expect(provider.dailyPrices(honey, range('2026-02-03', '2026-01-31'))).rejects.toThrow()
  })
})
