import { describe, expect, it } from 'vitest'
import { REPAYMENT_PERIOD_SECONDS } from './cost.ts'
import { accrueTo, type LoanState, loanPosition, operatorPosition } from './position.ts'
import {
  allocateRepayment,
  applyRepayment,
  REPAY_ALL_MARGIN_SECONDS,
  repayAllAmount,
} from './repayment.ts'

const T0 = 1_700_000_000n
const PERIOD = REPAYMENT_PERIOD_SECONDS

function loan(overrides: Partial<LoanState> = {}): LoanState {
  return {
    principal: 300_000_000n,
    outstanding: 300_000_000n,
    accruedInterest: 0n,
    interestRemainder: 0n,
    openedAt: T0,
    dueAt: T0 + 3n * PERIOD,
    lastAccrualAt: T0,
    aprBps: 1_000,
    ...overrides,
  }
}

const sum = (values: readonly bigint[]) => values.reduce((total, value) => total + value, 0n)
const owedAfterMargin = (state: LoanState, now: bigint) =>
  state.outstanding + accrueTo(state, now + REPAY_ALL_MARGIN_SECONDS).accruedInterest
const nextAmount = (state: LoanState, now: bigint) => {
  const { next } = loanPosition(state, now)
  return next.principal + next.interest
}

describe('allocateRepayment', () => {
  it('puts a repayment smaller than the next payment wholly on the one loan', () => {
    expect(allocateRepayment([loan()], 5_000_000n, T0 + 86_400n)).toEqual({
      ok: true,
      perLoan: [5_000_000n],
    })
  })

  it('pays exactly the next payment shown when given exactly that amount', () => {
    const now = T0 + 2n * PERIOD + 86_400n
    const ahead = loan({ openedAt: now - 86_400n, dueAt: now - 86_400n + PERIOD })
    const behind = loan({ outstanding: 250_000_000n })
    const older = loan({ openedAt: T0 - PERIOD, dueAt: T0 + 2n * PERIOD })
    const loans = [ahead, behind, older]
    const next = operatorPosition(loans, now).next
    const amount = next === null ? 0n : next.principal + next.interest

    expect(allocateRepayment(loans, amount, now)).toEqual({
      ok: true,
      perLoan: [0n, nextAmount(behind, now), nextAmount(older, now)],
    })
  })

  it('settles the oldest arrear before a younger one', () => {
    const now = T0 + 2n * PERIOD + 86_400n
    const behind = loan({ outstanding: 250_000_000n })
    const older = loan({ openedAt: T0 - PERIOD, dueAt: T0 + 2n * PERIOD })

    expect(allocateRepayment([behind, older], 1_000_000n, now)).toEqual({
      ok: true,
      perLoan: [0n, 1_000_000n],
    })
  })

  it('sends what is left after every next payment down the same order, up to each debt', () => {
    const now = T0 + 86_400n
    const soon = loan({ openedAt: T0 - 10n * 86_400n, dueAt: T0 - 10n * 86_400n + 3n * PERIOD })
    const later = loan()
    const loans = [later, soon]
    const firstPass = nextAmount(soon, now) + nextAmount(later, now)
    const extra = owedAfterMargin(soon, now) - nextAmount(soon, now) + 7n

    expect(allocateRepayment(loans, firstPass + extra, now)).toEqual({
      ok: true,
      perLoan: [nextAmount(later, now) + 7n, owedAfterMargin(soon, now)],
    })
  })

  it('never asks more of a loan than its debt ten minutes from now', () => {
    const now = T0 + 2n * PERIOD + 86_400n
    // Only the last instalment is left, and the interest projected to its date is more
    // than will accrue in the next ten minutes.
    const last = loan({ outstanding: 100_000_000n })
    const amount = owedAfterMargin(last, now)

    expect(nextAmount(last, now)).toBeGreaterThan(amount)
    expect(allocateRepayment([last], amount, now)).toEqual({ ok: true, perLoan: [amount] })

    // With a later loan behind it, what the first cannot take goes on to the next one.
    const later = loan({ openedAt: now, dueAt: now + PERIOD, lastAccrualAt: now })
    expect(allocateRepayment([last, later], amount + 5n, now)).toEqual({
      ok: true,
      perLoan: [amount, 5n],
    })
  })

  it('refuses more than everything owed, and says how much that is', () => {
    const now = T0 + 86_400n
    const loans = [loan(), loan({ principal: 50_000_000n, outstanding: 50_000_000n })]
    const all = repayAllAmount(loans, now)

    expect(allocateRepayment(loans, all + 1n, now)).toEqual({
      ok: false,
      reason: 'over-debt',
      max: all,
    })
  })

  it('refuses nothing, and anything without open loans', () => {
    expect(allocateRepayment([loan()], 0n, T0)).toEqual({ ok: false, reason: 'nothing' })
    expect(allocateRepayment([], 5n, T0)).toEqual({ ok: false, reason: 'over-debt', max: 0n })
  })
})

describe('repayAllAmount', () => {
  it('covers every loan’s debt as it will be ten minutes from now', () => {
    const now = T0 + 86_400n
    const loans = [loan({ accruedInterest: 11n }), loan({ outstanding: 120_000_000n })]

    expect(repayAllAmount(loans, now)).toBe(sum(loans.map((state) => owedAfterMargin(state, now))))
  })

  it('splits back into each loan’s whole ceiling, which closes every loan', () => {
    const now = T0 + 86_400n
    const loans = [loan(), loan({ outstanding: 120_000_000n })]
    const result = allocateRepayment(loans, repayAllAmount(loans, now), now)

    expect(result).toEqual({
      ok: true,
      perLoan: loans.map((state) => owedAfterMargin(state, now)),
    })
  })
})

describe('applyRepayment', () => {
  it('books the interest up to the moment, then pays it before principal', () => {
    expect(applyRepayment(loan(), 5_000_000n, T0 + PERIOD)).toEqual(
      loan({
        outstanding: 297_465_753n,
        interestRemainder: 133_920_000_000n,
        lastAccrualAt: T0 + PERIOD,
      }),
    )
  })

  it('leaves the principal whole when the amount does not cover the interest', () => {
    expect(applyRepayment(loan(), 1_000_000n, T0 + PERIOD)).toEqual(
      loan({
        accruedInterest: 1_465_753n,
        interestRemainder: 133_920_000_000n,
        lastAccrualAt: T0 + PERIOD,
      }),
    )
  })

  it('is no loan at all once the amount covers everything owed', () => {
    expect(applyRepayment(loan(), 400_000_000n, T0 + PERIOD)).toBeNull()
  })

  it('leaves a loan given nothing as it was', () => {
    expect(applyRepayment(loan(), 0n, T0 + PERIOD)).toEqual(loan())
  })
})
