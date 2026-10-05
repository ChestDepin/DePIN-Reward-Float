import { describe, expect, it } from 'vitest'
import { REPAYMENT_PERIOD_SECONDS } from './cost.ts'
import { accrueTo, type LoanState, loanPosition, operatorPosition } from './position.ts'

const T0 = 1_700_000_000n
const PERIOD = REPAYMENT_PERIOD_SECONDS
const YEAR = 365n * 86_400n
const DENOMINATOR = 10_000n * YEAR

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

describe('accrueTo', () => {
  it('accrues the annual rate over a year on what is outstanding, as the program does', () => {
    const state = loan({ outstanding: 1_000_000_000n, principal: 1_000_000_000n })

    expect(accrueTo(state, T0 + YEAR)).toEqual({
      accruedInterest: 100_000_000n,
      interestRemainder: 0n,
    })
  })

  it('carries the fraction already on the books into what accrues next', () => {
    const state = loan({
      outstanding: 100_000_000n,
      interestRemainder: 3n * 100_000_000n * 1_000n,
    })

    // Three seconds carried plus one more cross a whole unit, as in the program's test.
    expect(accrueTo(state, T0 + 1n)).toEqual({
      accruedInterest: 1n,
      interestRemainder: 4n * 100_000_000n * 1_000n - DENOMINATOR,
    })
  })

  it('adds to the interest already accrued and counts only from the last accrual', () => {
    const state = loan({
      outstanding: 100_000_000n,
      accruedInterest: 5_000n,
      lastAccrualAt: T0 + 86_400n,
    })

    expect(accrueTo(state, T0 + 2n * 86_400n).accruedInterest).toBe(5_000n + 27_397n)
  })

  it('moves nothing for a clock behind the last accrual', () => {
    const state = loan({ accruedInterest: 42n, interestRemainder: 7n, lastAccrualAt: T0 + 60n })

    expect(accrueTo(state, T0)).toEqual({ accruedInterest: 42n, interestRemainder: 7n })
  })
})

describe('loanPosition', () => {
  it('owes the principal left plus the interest accrued up to now, not up to the last write', () => {
    const position = loanPosition(loan({ accruedInterest: 10n }), T0 + YEAR / 10n)

    expect(position.outstanding).toBe(300_000_000n)
    expect(position.interest).toBe(10n + 3_000_000n)
    expect(position.owed).toBe(300_000_000n + 10n + 3_000_000n)
  })

  it('names the end of the first period as the next payment of a fresh loan', () => {
    const position = loanPosition(loan(), T0 + 86_400n)

    expect(position.next).toEqual({
      kind: 'instalment',
      dueAt: T0 + PERIOD,
      principal: 100_000_000n,
      // Interest on the whole principal for the whole period: none of it is repaid yet.
      interest: (300_000_000n * 1_000n * PERIOD) / DENOMINATOR,
    })
  })

  it('asks only for what the operator still lacks of an instalment they partly paid', () => {
    const position = loanPosition(loan({ outstanding: 260_000_000n }), T0 + 86_400n)

    expect(position.next).toMatchObject({
      kind: 'instalment',
      dueAt: T0 + PERIOD,
      principal: 60_000_000n,
    })
  })

  it('moves the next payment out past every instalment already paid ahead of schedule', () => {
    const position = loanPosition(loan({ outstanding: 150_000_000n }), T0 + 86_400n)

    expect(position.next).toMatchObject({
      kind: 'instalment',
      dueAt: T0 + 2n * PERIOD,
      principal: 50_000_000n,
    })
  })

  it('projects the interest to the payment date on the principal still outstanding', () => {
    const state = loan({ outstanding: 150_000_000n, accruedInterest: 999n })
    const position = loanPosition(state, T0 + 86_400n)

    expect(position.next).toMatchObject({
      interest: 999n + (150_000_000n * 1_000n * 2n * PERIOD) / DENOMINATOR,
    })
  })

  it('says a payment is due now, and since when, once an instalment date has passed unpaid', () => {
    const state = loan({ outstanding: 250_000_000n })
    const now = T0 + 2n * PERIOD + 86_400n
    const position = loanPosition(state, now)

    expect(position.next).toEqual({
      kind: 'due-now',
      since: T0 + PERIOD,
      principal: 250_000_000n - 100_000_000n,
      interest: accrueTo(state, now).accruedInterest,
    })
  })

  it('makes an instalment due at the very second its period ends', () => {
    expect(loanPosition(loan(), T0 + PERIOD).next).toMatchObject({
      kind: 'due-now',
      since: T0 + PERIOD,
      principal: 100_000_000n,
    })
  })

  it('wants everything owed once the term is over', () => {
    const state = loan({ outstanding: 120_000_000n, accruedInterest: 3_000n })
    const now = T0 + 3n * PERIOD + 10n * 86_400n
    const position = loanPosition(state, now)

    expect(position.next).toEqual({
      kind: 'due-now',
      // The second instalment was only partly paid, so that is where the arrear began.
      since: T0 + 2n * PERIOD,
      principal: 120_000_000n,
      interest: position.interest,
    })
  })

  it('refuses a loan with no principal left, which the program has already closed', () => {
    expect(() => loanPosition(loan({ outstanding: 0n }), T0)).toThrow(RangeError)
  })
})

describe('operatorPosition', () => {
  it('owes nothing and has no next payment without open loans', () => {
    expect(operatorPosition([], T0)).toEqual({
      outstanding: 0n,
      interest: 0n,
      owed: 0n,
      next: null,
    })
  })

  it('adds up the debt of every open loan', () => {
    const now = T0 + 86_400n
    const a = loan()
    const b = loan({ principal: 50_000_000n, outstanding: 40_000_000n, accruedInterest: 7n })
    const position = operatorPosition([a, b], now)

    expect(position.owed).toBe(loanPosition(a, now).owed + loanPosition(b, now).owed)
    expect(position.outstanding).toBe(340_000_000n)
  })

  it('takes the earliest instalment, summing the loans that fall due on that date', () => {
    const now = T0 + 86_400n
    const first = loan({ openedAt: T0 - 86_400n, dueAt: T0 - 86_400n + 3n * PERIOD })
    const same = loan({ openedAt: T0 - 86_400n, dueAt: T0 - 86_400n + 3n * PERIOD })
    const later = loan()
    const position = operatorPosition([later, first, same], now)

    const one = loanPosition(first, now).next
    expect(position.next).toEqual({
      kind: 'instalment',
      dueAt: T0 - 86_400n + PERIOD,
      principal: 2n * 100_000_000n,
      interest: 2n * one.interest,
    })
  })

  it('puts what is due now ahead of any later instalment, since the oldest arrear', () => {
    const now = T0 + 2n * PERIOD + 86_400n
    const behind = loan({ outstanding: 250_000_000n })
    const older = loan({ openedAt: T0 - PERIOD, dueAt: T0 + 2n * PERIOD })
    const ahead = loan({ openedAt: now - 86_400n, dueAt: now - 86_400n + PERIOD })
    const position = operatorPosition([ahead, behind, older], now)

    const a = loanPosition(behind, now).next
    const b = loanPosition(older, now).next
    expect(position.next).toEqual({
      kind: 'due-now',
      since: T0,
      principal: a.principal + b.principal,
      interest: a.interest + b.interest,
    })
  })
})
