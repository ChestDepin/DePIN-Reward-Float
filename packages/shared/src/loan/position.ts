// Where an operator stands on their open loans right now (FR-010). The program books
// interest only when a transaction touches the loan, so the stored numbers lag; the
// same accrual is run here up to the moment the page is looking at.

import { REPAYMENT_PERIOD_SECONDS } from './cost.ts'

const ACCRUAL_DENOMINATOR = 10_000n * 365n * 86_400n

// The fields of the on-chain `Loan` this arithmetic reads.
export type LoanState = {
  principal: bigint
  outstanding: bigint
  accruedInterest: bigint
  interestRemainder: bigint
  openedAt: bigint
  dueAt: bigint
  lastAccrualAt: bigint
  aprBps: number
}

export type NextPayment =
  | { kind: 'instalment'; dueAt: bigint; principal: bigint; interest: bigint }
  | { kind: 'due-now'; since: bigint; principal: bigint; interest: bigint }

export type LoanPosition = {
  outstanding: bigint
  interest: bigint
  owed: bigint
  next: NextPayment
}

export type OperatorPosition = {
  outstanding: bigint
  interest: bigint
  owed: bigint
  next: NextPayment | null
}

// Loan::accrue, without writing anything back.
export function accrueTo(
  loan: LoanState,
  at: bigint,
): { accruedInterest: bigint; interestRemainder: bigint } {
  if (at <= loan.lastAccrualAt) {
    return { accruedInterest: loan.accruedInterest, interestRemainder: loan.interestRemainder }
  }
  const numerator =
    loan.outstanding * BigInt(loan.aprBps) * (at - loan.lastAccrualAt) + loan.interestRemainder
  return {
    accruedInterest: loan.accruedInterest + numerator / ACCRUAL_DENOMINATOR,
    interestRemainder: numerator % ACCRUAL_DENOMINATOR,
  }
}

// Loan::principal_due_by at the end of period k.
function principalDueAfter(loan: LoanState, periods: bigint, k: bigint): bigint {
  return (loan.principal * k + periods - 1n) / periods
}

// The schedule is not stored: it follows from the principal and the two dates, and what
// has been repaid says how far along it the operator is. Paying ahead moves the next
// date out; falling behind makes the oldest unpaid instalment the date the debt is due.
export function loanPosition(loan: LoanState, now: bigint): LoanPosition {
  if (loan.outstanding <= 0n) {
    throw new RangeError('a loan with no principal left is repaid, not open')
  }
  const interest = accrueTo(loan, now).accruedInterest
  const repaid = loan.principal - loan.outstanding
  const periods = (loan.dueAt - loan.openedAt) / REPAYMENT_PERIOD_SECONDS

  let next: NextPayment | null = null
  for (let k = 1n; k <= periods && next === null; k++) {
    const dueBy = principalDueAfter(loan, periods, k)
    if (dueBy <= repaid) continue
    const dueAt = loan.openedAt + k * REPAYMENT_PERIOD_SECONDS
    if (dueAt > now) {
      next = {
        kind: 'instalment',
        dueAt,
        principal: dueBy - repaid,
        interest: accrueTo(loan, dueAt).accruedInterest,
      }
    } else {
      const passed = (now - loan.openedAt) / REPAYMENT_PERIOD_SECONDS
      const owedBy = principalDueAfter(loan, periods, passed < periods ? passed : periods)
      next = { kind: 'due-now', since: dueAt, principal: owedBy - repaid, interest }
    }
  }
  if (next === null) {
    throw new RangeError('the loan has principal outstanding but no instalment left for it')
  }

  return { outstanding: loan.outstanding, interest, owed: loan.outstanding + interest, next }
}

function earlier(a: NextPayment, b: NextPayment): NextPayment {
  if (a.kind !== b.kind) return a.kind === 'due-now' ? a : b
  const at = (payment: NextPayment) => (payment.kind === 'due-now' ? payment.since : payment.dueAt)
  return at(b) < at(a) ? b : a
}

// Everything due now is one payment, dated by the oldest arrear. Otherwise the next
// payment is the earliest instalment, together with any other loan due the same second.
export function operatorPosition(loans: readonly LoanState[], now: bigint): OperatorPosition {
  const positions = loans.map((loan) => loanPosition(loan, now))
  const total = { outstanding: 0n, interest: 0n, owed: 0n }
  let first: NextPayment | null = null
  for (const position of positions) {
    total.outstanding += position.outstanding
    total.interest += position.interest
    total.owed += position.owed
    first = first === null ? position.next : earlier(first, position.next)
  }
  if (first === null) return { ...total, next: null }

  const lead = first
  const together = positions
    .map((position) => position.next)
    .filter((payment) =>
      lead.kind === 'due-now'
        ? payment.kind === 'due-now'
        : payment.kind === 'instalment' && payment.dueAt === lead.dueAt,
    )
  const next: NextPayment = {
    ...lead,
    principal: together.reduce((sum, payment) => sum + payment.principal, 0n),
    interest: together.reduce((sum, payment) => sum + payment.interest, 0n),
  }
  return { ...total, next }
}
