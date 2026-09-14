import { describe, expect, it } from 'vitest'
import type { PayoutCadence } from '../schemas/network.ts'
import { calendarMonthSchema, type MonthlyPayouts } from './aggregate.ts'
import { assessEligibility, REQUIRED_PAID_MONTHS } from './eligibility.ts'
import { calendarDaySchema } from './price.ts'

const TWELVE_MONTHS = [
  '2025-09',
  '2025-10',
  '2025-11',
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
] as const

const monthValueOf = (mark: string): bigint | null => {
  if (mark === '?') return null
  if (mark === '.') return 0n
  return 200_000_000n
}

// 'P' — місяць із виплатою і котируванням, '.' — місяць без виплат,
// '?' — виплата є, а котирування за її день немає.
const period = (marks: string, over: readonly string[] = TWELVE_MONTHS): MonthlyPayouts[] =>
  [...marks].map((mark, index) => {
    const raw = over[index]
    if (raw === undefined) throw new Error('the pattern runs past the period it is written over')

    const month = calendarMonthSchema.parse(raw)
    return {
      month,
      payoutCount: mark === '.' ? 0 : 1,
      amount: mark === '.' ? 0n : 100_000_000n,
      valueUsd: monthValueOf(mark),
      daysWithoutPrice: mark === '?' ? [calendarDaySchema.parse(`${month}-15`)] : [],
    }
  })

// Каденція за замовчуванням — push-мережа: ці випадки міряють історію, а не ритм.
const assess = (months: readonly MonthlyPayouts[], cadence: PayoutCadence = 'weekly') =>
  assessEligibility({ months, cadence })

describe('assessEligibility', () => {
  it('holds the agreed threshold: six paid months', () => {
    expect(REQUIRED_PAID_MONTHS).toBe(6)
  })

  it('passes a wallet paid every month of the period', () => {
    expect(assess(period('PPPPPPPPPPPP'))).toEqual({ kind: 'eligible' })
  })

  it('passes six paid months that are not in a row', () => {
    expect(assess(period('P.P.P.P.P.P.'))).toEqual({ kind: 'eligible' })
  })

  it('passes six paid months even when the newest ones are empty', () => {
    expect(assess(period('PPPPPP......'))).toEqual({ kind: 'eligible' })
  })

  it('refuses five paid months and names what it counted', () => {
    expect(assess(period('P.P.P.P.P...'))).toEqual({
      kind: 'short-history',
      paidMonths: 5,
      periodMonths: 12,
      thresholdReachedIn: '2026-10',
    })
  })

  it('reaches the threshold next month when the recent months carry the history', () => {
    const outcome = assess(period('.......PPPPP'))

    expect(outcome).toEqual({
      kind: 'short-history',
      paidMonths: 5,
      periodMonths: 12,
      thresholdReachedIn: '2026-09',
    })
  })

  it('counts out the paid months that age out of the window before the threshold', () => {
    const outcome = assess(period('PPPPP.......'))

    expect(outcome).toEqual({
      kind: 'short-history',
      paidMonths: 5,
      periodMonths: 12,
      thresholdReachedIn: '2027-02',
    })
  })

  it('gives an empty history six months of payouts to reach the threshold', () => {
    const outcome = assess(period('............'))

    expect(outcome).toEqual({
      kind: 'short-history',
      paidMonths: 0,
      periodMonths: 12,
      thresholdReachedIn: '2027-02',
    })
  })

  it('carries the projection over the turn of the year', () => {
    const overDecember = [
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
    const outcome = assess(period('............', overDecember))

    expect(outcome).toEqual({
      kind: 'short-history',
      paidMonths: 0,
      periodMonths: 12,
      thresholdReachedIn: '2027-06',
    })
  })

  it('passes a history whose months have no dollar value: the limit no longer needs one', () => {
    expect(assess(period('PPPPPPPP?PP?'))).toEqual({ kind: 'eligible' })
  })

  it('refuses a short history, quotes or no quotes', () => {
    expect(assess(period('?...........'))).toEqual({
      kind: 'short-history',
      paidMonths: 1,
      periodMonths: 12,
      thresholdReachedIn: '2027-02',
    })
  })

  it('answers the same twice: nothing here reads a clock', () => {
    const months = period('P.P.P.P.P...')

    expect(assess(months)).toEqual(assess(months))
  })

  it('refuses a period no payout history could ever fill', () => {
    expect(() => assess(period('.....'))).toThrow(/never hold/)
  })

  it('refuses an empty period', () => {
    expect(() => assess([])).toThrow(/never hold/)
  })

  // FR-001a: у мережі, де оператор забирає накопичене сам, ончейн лежить історія
  // зняттів, а не заробітку, і рахувати ліміт на ній не можна ні за яких даних.
  it('refuses a network whose payouts come on demand, however full the history', () => {
    expect(assess(period('PPPPPPPPPPPP'), 'on-demand')).toEqual({
      kind: 'withdrawal-history',
      cadence: 'on-demand',
    })
  })

  it('refuses on demand before it ever looks at the period', () => {
    expect(assess(period('.....'), 'on-demand')).toEqual({
      kind: 'withdrawal-history',
      cadence: 'on-demand',
    })
  })

  it('lets every paid cadence through to the history threshold', () => {
    for (const cadence of ['daily', 'weekly', 'monthly'] as const) {
      expect(assess(period('PPPPPPPPPPPP'), cadence)).toEqual({ kind: 'eligible' })
    }
  })
})
