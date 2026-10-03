import { describe, expect, it } from 'vitest'
import { loanCost, quoteAprBps, REPAYMENT_PERIOD_SECONDS } from './cost.ts'

const YEAR = 365n * 86_400n
const DENOMINATOR = 10_000n * YEAR

const pool = { baseAprBps: 800, slopeAprBps: 2_000, totalBorrowed: 0n, totalDeposits: 0n }

// The program's own bookkeeping, step by step: interest accrues on what is outstanding
// with the fraction of a unit carried over, and each instalment is paid at the end of
// its period together with the interest booked so far. A second way to the same number.
function simulateSchedule(principal: bigint, aprBps: number, periods: number) {
  let outstanding = principal
  let remainder = 0n
  const rows: { principal: bigint; interest: bigint }[] = []
  for (let k = 1; k <= periods; k++) {
    const numerator = outstanding * BigInt(aprBps) * REPAYMENT_PERIOD_SECONDS + remainder
    const interest = numerator / DENOMINATOR
    remainder = numerator % DENOMINATOR
    const dueBy = (principal * BigInt(k) + BigInt(periods) - 1n) / BigInt(periods)
    const instalment = outstanding - (principal - dueBy)
    outstanding -= instalment
    rows.push({ principal: instalment, interest })
  }
  return rows
}

describe('quoteAprBps', () => {
  it('prices a loan by the utilisation it leaves behind, as the program does', () => {
    const quote = quoteAprBps(
      { ...pool, totalDeposits: 1_000_000_000n, totalBorrowed: 100_000_000n },
      200_000_000n,
    )

    expect(quote).toEqual({ ok: true, aprBps: 800 + 600 })
  })

  it('rounds the utilisation premium up, never in the borrower’s favour', () => {
    expect(quoteAprBps({ ...pool, totalDeposits: 3n }, 1n)).toEqual({ ok: true, aprBps: 1_467 })
  })

  it('lends the last unit of free liquidity at the top of the curve', () => {
    const quote = quoteAprBps({ ...pool, totalDeposits: 500n, totalBorrowed: 200n }, 300n)

    expect(quote).toEqual({ ok: true, aprBps: 2_800 })
  })

  it('refuses more than the free liquidity, and anything from an empty pool', () => {
    const full = { ...pool, totalDeposits: 500n, totalBorrowed: 200n }

    expect(quoteAprBps(full, 301n)).toEqual({ ok: false, reason: 'insufficient-liquidity' })
    expect(quoteAprBps(pool, 1n)).toEqual({ ok: false, reason: 'insufficient-liquidity' })
  })
})

describe('loanCost', () => {
  it('charges the whole principal for the whole term as the ceiling', () => {
    const cost = loanCost({ principal: 100_000_000n, aprBps: 1_200, termPeriods: 3 })

    // 100 USDC · 12 % · 90 / 365 = 2.958904… USDC, the fraction never booked.
    expect(cost.interestIfHeldToTerm).toBe(2_958_904n)
    expect(cost.totalIfHeldToTerm).toBe(102_958_904n)
  })

  it('splits the principal into equal instalments that add up exactly', () => {
    const cost = loanCost({ principal: 100_000_000n, aprBps: 1_200, termPeriods: 3 })

    expect(cost.schedule.map((row) => row.principal)).toEqual([
      33_333_334n,
      33_333_333n,
      33_333_333n,
    ])
    expect(cost.schedule.map((row) => row.dueAfterSeconds)).toEqual([
      REPAYMENT_PERIOD_SECONDS,
      2n * REPAYMENT_PERIOD_SECONDS,
      3n * REPAYMENT_PERIOD_SECONDS,
    ])
  })

  it('books the same interest on schedule as the program accruing period by period', () => {
    for (const [principal, aprBps, periods] of [
      [100_000_000n, 1_200, 3],
      [1n, 2_800, 6],
      [7_777_777n, 801, 5],
      [250_000_000_000n, 2_799, 6],
      [3n, 1_000, 1],
    ] as const) {
      const cost = loanCost({ principal, aprBps, termPeriods: periods })
      const expected = simulateSchedule(principal, aprBps, periods)

      expect(cost.schedule.map(({ principal, interest }) => ({ principal, interest }))).toEqual(
        expected,
      )
      expect(cost.interestOnSchedule).toBe(expected.reduce((sum, row) => sum + row.interest, 0n))
    }
  })

  it('costs less on schedule than held to term, and the same over one period', () => {
    const three = loanCost({ principal: 100_000_000n, aprBps: 1_200, termPeriods: 3 })
    const one = loanCost({ principal: 100_000_000n, aprBps: 1_200, termPeriods: 1 })

    expect(three.interestOnSchedule).toBeLessThan(three.interestIfHeldToTerm)
    expect(one.interestOnSchedule).toBe(one.interestIfHeldToTerm)
  })

  it('names a day past due by what it adds on the full principal, rounded up', () => {
    const cost = loanCost({ principal: 100_000_000n, aprBps: 1_200, termPeriods: 3 })

    // 100 USDC · 12 % / 365 = 32 876.71… units a day.
    expect(cost.interestPerDayPastDue).toBe(32_877n)
  })

  it('refuses a term, a principal or a rate the program would refuse', () => {
    expect(() => loanCost({ principal: 1n, aprBps: 800, termPeriods: 0 })).toThrow(RangeError)
    expect(() => loanCost({ principal: 1n, aprBps: 800, termPeriods: 7 })).toThrow(RangeError)
    expect(() => loanCost({ principal: 0n, aprBps: 800, termPeriods: 1 })).toThrow(RangeError)
    expect(() => loanCost({ principal: 2n ** 64n, aprBps: 800, termPeriods: 1 })).toThrow(
      RangeError,
    )
    expect(() => loanCost({ principal: 1n, aprBps: 65_536, termPeriods: 1 })).toThrow(RangeError)
  })
})
