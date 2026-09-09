import { describe, expect, it } from 'vitest'
import { calendarMonthSchema, type MonthlyPayouts } from './aggregate.ts'
import { computeCreditLimit, medianOf, priceVolatilityBp } from './limit.ts'
import { calendarDaySchema, type PriceSeries, priceUsdSchema } from './price.ts'

const series = (quotes: Record<string, string>): PriceSeries =>
  new Map(
    Object.entries(quotes).map(([day, price]) => [
      calendarDaySchema.parse(day),
      priceUsdSchema.parse(price),
    ]),
  )

// Усі три закінчуються останніми днями періоду й мають ту саму недавню ціну
// $0,05 — інакше тести волатильності рухали б заразом і оцінку потоку.
const flat = series({ '2026-12-29': '0.05', '2026-12-30': '0.05', '2026-12-31': '0.05' })
const swinging = series({ '2026-12-29': '0.05', '2026-12-30': '0.04', '2026-12-31': '0.05' })
const wild = series({ '2026-12-29': '0.05', '2026-12-30': '0.01', '2026-12-31': '0.05' })

// Падіння на 90 % рівними денними кроками — той самий порядок величини, що рік
// HONEY (−93 %), тільки без єдиного стрибка.
const sliding = series(
  Object.fromEntries(
    Array.from({ length: 91 }, (_, step) => [
      new Date(Date.UTC(2026, 0, 1 + step)).toISOString().slice(0, 10),
      `0.${String(100 - step).padStart(3, '0')}`,
    ]),
  ),
)

const MONTHS = [
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
  '2026-09',
  '2026-10',
  '2026-11',
  '2026-12',
]

const DECIMALS = 9
const TOKEN = 1_000_000_000n

// `valueUsd: null` скрізь навмисне: ліміт більше не дивиться на вартість місяця
// за ціною того ж місяця, і рахується навіть тоді, коли її взагалі немає.
const month = (name: string, tokens: bigint, payoutCount = 1): MonthlyPayouts => ({
  month: calendarMonthSchema.parse(name),
  payoutCount,
  amount: tokens * TOKEN,
  valueUsd: null,
  daysWithoutPrice: [],
})

const empty = (name: string): MonthlyPayouts => ({
  month: calendarMonthSchema.parse(name),
  payoutCount: 0,
  amount: 0n,
  valueUsd: 0n,
  daysWithoutPrice: [],
})

const everyMonth = (tokens: bigint) => MONTHS.map((name) => month(name, tokens))

const limitOf = (months: readonly MonthlyPayouts[], prices: PriceSeries = flat) => {
  const outcome = computeCreditLimit({ months, prices, decimals: DECIMALS })
  if (outcome.kind !== 'limit') throw new Error(`expected a limit, got ${outcome.kind}`)
  return outcome
}

describe('medianOf', () => {
  it('takes the middle value of an odd count', () => {
    expect(medianOf([3n, 1n, 2n])).toBe(2n)
  })

  it('averages the two middle values of an even count', () => {
    expect(medianOf([1n, 2n, 3n, 4n])).toBe(2n)
  })

  it('truncates the average of the middle pair instead of rounding it up', () => {
    expect(medianOf([1n, 2n])).toBe(1n)
  })

  it('rejects an empty list, which has no middle', () => {
    expect(() => medianOf([])).toThrow()
  })
})

describe('priceVolatilityBp', () => {
  it('is zero for a series that never moves', () => {
    expect(priceVolatilityBp(flat)).toBe(0n)
  })

  it('averages the daily moves, each against the quote it moved from', () => {
    const there = series({ '2026-01-14': '0.05', '2026-01-15': '0.04', '2026-01-16': '0.05' })

    expect(priceVolatilityBp(there)).toBe(2250n)
  })

  it('measures a steady slide by its daily step, not by the size of the fall', () => {
    expect(priceVolatilityBp(sliding)).toBe(250n)
  })

  it('skips a gap instead of reading the jump across it as one day', () => {
    const gapped = series({
      '2026-01-14': '0.05',
      '2026-01-15': '0.04',
      '2026-01-17': '0.10',
      '2026-01-18': '0.11',
    })

    expect(priceVolatilityBp(gapped)).toBe(1500n)
  })

  it('does not depend on the order the quotes were read in', () => {
    const backwards = series({ '2026-01-16': '0.05', '2026-01-15': '0.04', '2026-01-14': '0.05' })

    expect(priceVolatilityBp(backwards)).toBe(2250n)
  })

  it('treats a series with no two adjacent days as motionless', () => {
    expect(priceVolatilityBp(series({ '2026-01-15': '0.05' }))).toBe(0n)
    expect(priceVolatilityBp(series({}))).toBe(0n)
    expect(priceVolatilityBp(series({ '2026-01-15': '0.05', '2026-01-17': '0.19' }))).toBe(0n)
  })
})

describe('computeCreditLimit', () => {
  it('lends two months of the median monthly flow, priced at the recent quote', () => {
    const outcome = limitOf(everyMonth(2_000n))

    expect(outcome.medianMonthlyUsd).toBe(100_000_000n)
    expect(outcome.limitUsd).toBe(200_000_000n)
  })

  it('prices the flow at the recent quote, not at what each month was worth then', () => {
    const months = everyMonth(2_000n).map((entry) => ({ ...entry, valueUsd: 900_000_000n }))

    expect(limitOf(months).limitUsd).toBe(200_000_000n)
  })

  it('takes the median, so one outstanding month does not lift the limit', () => {
    const months = everyMonth(2_000n).map((entry, index) =>
      index === 11 ? month(entry.month, 200_000n) : entry,
    )

    expect(limitOf(months).limitUsd).toBe(200_000_000n)
  })

  it('counts a month without payouts as a gap, which lowers the limit twice over', () => {
    const months = MONTHS.map((name, index) => (index < 6 ? month(name, 4_000n) : empty(name)))

    const outcome = limitOf(months)

    expect(outcome.medianMonthlyUsd).toBe(100_000_000n)
    expect(outcome.stabilityBp).toBe(5000n)
    expect(outcome.limitUsd).toBe(100_000_000n)
  })

  it('lowers the limit when the reward token swings', () => {
    const outcome = limitOf(everyMonth(2_000n), swinging)

    expect(outcome.volatilityBp).toBe(2250n)
    expect(outcome.limitUsd).toBe(155_000_000n)
  })

  it('stops cutting the limit past the volatility cap', () => {
    const outcome = limitOf(everyMonth(2_000n), wild)

    expect(outcome.volatilityBp).toBe(5000n)
    expect(outcome.limitUsd).toBe(100_000_000n)
  })

  it('gives no limit to a wallet with no payouts at all', () => {
    const outcome = limitOf(MONTHS.map(empty))

    expect(outcome.limitUsd).toBe(0n)
  })

  it('takes the median of the recent window, so one spike does not price the flow', () => {
    const spike = series({ '2026-12-29': '0.05', '2026-12-30': '0.05', '2026-12-31': '0.20' })

    expect(limitOf(everyMonth(2_000n), spike).medianMonthlyUsd).toBe(100_000_000n)
  })

  it('leaves the quotes older than the recent window out of the price', () => {
    const fallen = series({
      '2026-01-14': '0.50',
      '2026-01-15': '0.50',
      '2026-01-16': '0.50',
      '2026-01-17': '0.50',
      '2026-12-29': '0.05',
      '2026-12-30': '0.05',
      '2026-12-31': '0.05',
    })

    expect(limitOf(everyMonth(2_000n), fallen).medianMonthlyUsd).toBe(100_000_000n)
  })

  it('refuses to score when nothing quoted the token recently, and names the window', () => {
    const stale = series({ '2026-01-14': '0.05', '2026-01-15': '0.05' })

    const outcome = computeCreditLimit({ months: everyMonth(2_000n), prices: stale, decimals: 9 })

    expect(outcome).toEqual({
      kind: 'no-recent-price',
      window: { from: '2026-12-02', to: '2026-12-31' },
    })
  })

  it('reports the inputs it scored on, so the breakdown does not recompute them', () => {
    const outcome = limitOf(everyMonth(2_000n), swinging)

    expect(outcome).toEqual({
      kind: 'limit',
      limitUsd: 155_000_000n,
      medianMonthlyUsd: 100_000_000n,
      stabilityBp: 10_000n,
      volatilityBp: 2250n,
    })
  })

  it('gives the same number twice on the same months and the same series', () => {
    const months = MONTHS.map((name, index) =>
      index % 3 === 0 ? empty(name) : month(name, BigInt(index) * 140n),
    )

    const first = computeCreditLimit({ months, prices: swinging, decimals: DECIMALS })
    const second = computeCreditLimit({ months, prices: swinging, decimals: DECIMALS })

    expect(first).toEqual(second)
    expect(first).toEqual({
      kind: 'limit',
      limitUsd: 21_697_830n,
      medianMonthlyUsd: 21_000_000n,
      stabilityBp: 6666n,
      volatilityBp: 2250n,
    })
  })

  it('scores the same months differently when the series ends a day earlier', () => {
    const through31 = series({ '2026-12-29': '0.06', '2026-12-30': '0.05', '2026-12-31': '0.04' })
    const through30 = series({ '2026-12-29': '0.06', '2026-12-30': '0.05' })

    expect(limitOf(everyMonth(2_000n), through31).medianMonthlyUsd).toBe(100_000_000n)
    expect(limitOf(everyMonth(2_000n), through30).medianMonthlyUsd).toBe(120_000_000n)
  })

  it('does not depend on the order the quotes were read in', () => {
    const forwards = series({ '2026-12-29': '0.04', '2026-12-30': '0.06', '2026-12-31': '0.05' })
    const backwards = series({ '2026-12-31': '0.05', '2026-12-30': '0.06', '2026-12-29': '0.04' })

    expect(limitOf(everyMonth(2_000n), forwards)).toEqual(limitOf(everyMonth(2_000n), backwards))
  })

  it('rejects a period with no months in it', () => {
    expect(() => computeCreditLimit({ months: [], prices: flat, decimals: DECIMALS })).toThrow()
  })
})
