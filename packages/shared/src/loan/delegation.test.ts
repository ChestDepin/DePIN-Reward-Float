import { describe, expect, it } from 'vitest'
import { REPAYMENT_PERIOD_SECONDS } from './cost.ts'
import { debtCeiling, newLoanState, rewardAllowance } from './delegation.ts'
import type { LoanState } from './position.ts'

const NOW = 1_791_288_000n
const DAY = 86_400n

// $100 at 20 % for three 30-day periods, opened now.
const fresh = newLoanState({ principal: 100_000_000n, aprBps: 2000, termPeriods: 3, now: NOW })

describe('newLoanState', () => {
  it('describes the loan as the program will book it at issue', () => {
    expect(fresh).toEqual({
      principal: 100_000_000n,
      outstanding: 100_000_000n,
      accruedInterest: 0n,
      interestRemainder: 0n,
      openedAt: NOW,
      dueAt: NOW + 3n * REPAYMENT_PERIOD_SECONDS,
      lastAccrualAt: NOW,
      aprBps: 2000,
    })
  })
})

describe('debtCeiling', () => {
  // 100 * 0.20 * 90 / 365 = 4.931506..., cut to whole base units as the program does.
  it('is what is owed at the due date if nothing is repaid before it', () => {
    expect(debtCeiling([fresh], NOW)).toBe(104_931_506n)
  })

  it('adds the loans together, each to its own due date', () => {
    const older: LoanState = {
      ...fresh,
      principal: 50_000_000n,
      outstanding: 20_000_000n,
      accruedInterest: 300_000n,
      openedAt: NOW - 60n * DAY,
      dueAt: NOW + 30n * DAY,
      lastAccrualAt: NOW - 10n * DAY,
    }
    // 20 * 0.20 * 40 / 365 = 0.438356... on top of the 0.30 already booked.
    expect(debtCeiling([fresh, older], NOW)).toBe(104_931_506n + 20_738_356n)
  })

  // Past the term the bound is the debt as it is now: interest keeps running, and an
  // allowance for tomorrow's debt would already exceed today's.
  it('is the debt right now for a loan past its due date', () => {
    const overdue: LoanState = {
      ...fresh,
      openedAt: NOW - 100n * DAY,
      dueAt: NOW - 10n * DAY,
      lastAccrualAt: NOW - 10n * DAY,
    }
    // 100 * 0.20 * 10 / 365 = 0.547945...: the ten days since the due date, not zero.
    expect(debtCeiling([overdue], NOW)).toBe(100_000_000n + 547_945n)
  })

  it('is nothing when nothing is open', () => {
    expect(debtCeiling([], NOW)).toBe(0n)
  })
})

describe('rewardAllowance', () => {
  // 104.931506 USDC at 2 406 662 units per 10^12 HONEY units (about $0.0024 a HONEY).
  it('is the debt in reward units at the attested rate, rounded down', () => {
    expect(rewardAllowance(104_931_506n, 2_406_662n)).toBe(43_600_433_297_239n)
  })

  // Down, because the value delegated may not exceed the debt (FR-014a).
  it('never values the allowance above the debt at the same rate', () => {
    const rate = 5_167_210_998n
    const allowance = rewardAllowance(104_931_506n, rate)

    expect((allowance * rate) / 1_000_000_000_000n).toBeLessThanOrEqual(104_931_506n)
    expect(((allowance + 1n) * rate) / 1_000_000_000_000n).toBeGreaterThanOrEqual(104_931_506n)
  })

  it('is nothing for no debt', () => {
    expect(rewardAllowance(0n, 2_406_662n)).toBe(0n)
  })

  it('refuses a zero rate instead of dividing by it', () => {
    expect(() => rewardAllowance(1n, 0n)).toThrow(RangeError)
  })
})
