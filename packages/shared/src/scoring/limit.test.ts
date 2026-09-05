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

const flat = series({ '2026-01-15': '0.05', '2026-02-15': '0.05' })
const swinging = series({ '2026-01-15': '0.04', '2026-02-15': '0.06' })
const wild = series({ '2026-01-15': '0.01', '2026-02-15': '0.19' })

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

const month = (name: string, valueUsd: bigint | null, payoutCount = 1): MonthlyPayouts => ({
  month: calendarMonthSchema.parse(name),
  payoutCount,
  amount: 1_000_000_000n,
  valueUsd,
  daysWithoutPrice: [],
})

const empty = (name: string): MonthlyPayouts => ({
  month: calendarMonthSchema.parse(name),
  payoutCount: 0,
  amount: 0n,
  valueUsd: 0n,
  daysWithoutPrice: [],
})

const everyMonth = (valueUsd: bigint) => MONTHS.map((name) => month(name, valueUsd))

const limitOf = (months: readonly MonthlyPayouts[], prices: PriceSeries = flat) => {
  const outcome = computeCreditLimit({ months, prices })
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

  it('measures the average distance from the mean quote', () => {
    expect(priceVolatilityBp(swinging)).toBe(2000n)
  })

  it('treats a series too short to move as motionless', () => {
    expect(priceVolatilityBp(series({ '2026-01-15': '0.05' }))).toBe(0n)
    expect(priceVolatilityBp(series({}))).toBe(0n)
  })
})

describe('computeCreditLimit', () => {
  it('lends two months of the median monthly flow', () => {
    const outcome = limitOf(everyMonth(100_000_000n))

    expect(outcome.limitUsd).toBe(200_000_000n)
  })

  it('takes the median, so one outstanding month does not lift the limit', () => {
    const months = everyMonth(100_000_000n).map((entry, index) =>
      index === 11 ? month(entry.month, 10_000_000_000n) : entry,
    )

    expect(limitOf(months).limitUsd).toBe(200_000_000n)
  })

  it('counts a month without payouts as a gap, which lowers the limit twice over', () => {
    const months = MONTHS.map((name, index) =>
      index < 6 ? month(name, 200_000_000n) : empty(name),
    )

    const outcome = limitOf(months)

    expect(outcome.medianMonthlyUsd).toBe(100_000_000n)
    expect(outcome.stabilityBp).toBe(5000n)
    expect(outcome.limitUsd).toBe(100_000_000n)
  })

  it('lowers the limit when the reward token swings', () => {
    const outcome = limitOf(everyMonth(100_000_000n), swinging)

    expect(outcome.volatilityBp).toBe(2000n)
    expect(outcome.limitUsd).toBe(160_000_000n)
  })

  it('stops cutting the limit past the volatility cap', () => {
    const outcome = limitOf(everyMonth(100_000_000n), wild)

    expect(outcome.volatilityBp).toBe(5000n)
    expect(outcome.limitUsd).toBe(100_000_000n)
  })

  it('gives no limit to a wallet with no payouts at all', () => {
    const outcome = limitOf(MONTHS.map(empty))

    expect(outcome.limitUsd).toBe(0n)
  })

  it('refuses to score at all when a month has no value, and names those months', () => {
    const months = everyMonth(100_000_000n).map((entry, index) =>
      index === 3 || index === 7 ? month(entry.month, null) : entry,
    )

    const outcome = computeCreditLimit({ months, prices: flat })

    expect(outcome).toEqual({ kind: 'incomplete-prices', months: ['2026-04', '2026-08'] })
  })

  it('reports the inputs it scored on, so the breakdown does not recompute them', () => {
    const outcome = limitOf(everyMonth(100_000_000n), swinging)

    expect(outcome).toEqual({
      kind: 'limit',
      limitUsd: 160_000_000n,
      medianMonthlyUsd: 100_000_000n,
      stabilityBp: 10_000n,
      volatilityBp: 2000n,
    })
  })

  it('gives the same number twice on the same data', () => {
    const months = MONTHS.map((name, index) =>
      index % 3 === 0 ? empty(name) : month(name, BigInt(index) * 7_000_000n),
    )

    const first = computeCreditLimit({ months, prices: swinging })
    const second = computeCreditLimit({ months, prices: swinging })

    expect(first).toEqual(second)
  })

  it('does not depend on the order the quotes were read in', () => {
    const forwards = series({ '2026-01-15': '0.04', '2026-02-15': '0.06', '2026-03-15': '0.05' })
    const backwards = series({ '2026-03-15': '0.05', '2026-02-15': '0.06', '2026-01-15': '0.04' })

    expect(limitOf(everyMonth(100_000_000n), forwards)).toEqual(
      limitOf(everyMonth(100_000_000n), backwards),
    )
  })

  it('rejects a period with no months in it', () => {
    expect(() => computeCreditLimit({ months: [], prices: flat })).toThrow()
  })
})
