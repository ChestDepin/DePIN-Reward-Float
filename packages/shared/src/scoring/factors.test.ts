import { describe, expect, it } from 'vitest'
import { calendarMonthSchema, type MonthlyPayouts } from './aggregate.ts'
import { explainLimit, type ScoredLimit } from './factors.ts'
import { computeCreditLimit } from './limit.ts'
import { calendarDaySchema, type PriceSeries, priceUsdSchema } from './price.ts'

const scored = (
  medianMonthlyUsd: bigint,
  stabilityBp: bigint,
  volatilityBp: bigint,
  limitUsd: bigint,
): ScoredLimit => ({ kind: 'limit', limitUsd, medianMonthlyUsd, stabilityBp, volatilityBp })

const totalOf = (limit: ScoredLimit) =>
  explainLimit(limit).reduce((sum, factor) => sum + factor.deltaUsd, 0n)

describe('explainLimit', () => {
  it('opens with two months of the median flow, before anything cuts it', () => {
    expect(explainLimit(scored(100_000_000n, 10_000n, 0n, 200_000_000n))).toEqual([
      { name: 'median-flow', deltaUsd: 200_000_000n },
      { name: 'stability', deltaUsd: 0n },
      { name: 'volatility', deltaUsd: 0n },
    ])
  })

  it('charges the gaps in the history to stability', () => {
    expect(explainLimit(scored(100_000_000n, 5000n, 0n, 100_000_000n))).toEqual([
      { name: 'median-flow', deltaUsd: 200_000_000n },
      { name: 'stability', deltaUsd: -100_000_000n },
      { name: 'volatility', deltaUsd: 0n },
    ])
  })

  it('charges volatility on what stability left, not on the whole base', () => {
    const factors = explainLimit(scored(100_000_000n, 5000n, 2000n, 80_000_000n))

    expect(factors[2]).toEqual({ name: 'volatility', deltaUsd: -20_000_000n })
  })

  it('keeps the factors in one order, whatever they came out to', () => {
    expect(explainLimit(scored(7n, 3333n, 1777n, 3n)).map((factor) => factor.name)).toEqual([
      'median-flow',
      'stability',
      'volatility',
    ])
  })

  it('explains a limit of zero as a flow of zero', () => {
    expect(totalOf(scored(0n, 0n, 0n, 0n))).toBe(0n)
  })

  it('adds up to the limit exactly', () => {
    expect(totalOf(scored(100_000_000n, 5000n, 2000n, 80_000_000n))).toBe(80_000_000n)
  })

  it('adds up to the limit even where every step is truncated', () => {
    const months: MonthlyPayouts[] = [
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
    ].map((name, index) => ({
      month: calendarMonthSchema.parse(name),
      payoutCount: index < 7 ? 1 : 0,
      amount: index < 7 ? 606_060_606_060n : 0n,
      valueUsd: null,
      daysWithoutPrice: [],
    }))

    const prices: PriceSeries = new Map([
      [calendarDaySchema.parse('2026-12-29'), priceUsdSchema.parse('0.04')],
      [calendarDaySchema.parse('2026-12-30'), priceUsdSchema.parse('0.055')],
      [calendarDaySchema.parse('2026-12-31'), priceUsdSchema.parse('0.06')],
    ])

    const outcome = computeCreditLimit({ months, prices, decimals: 9 })
    if (outcome.kind !== 'limit') throw new Error(`expected a limit, got ${outcome.kind}`)

    expect(outcome.stabilityBp).toBe(5833n)
    expect(totalOf(outcome)).toBe(outcome.limitUsd)
  })
})
