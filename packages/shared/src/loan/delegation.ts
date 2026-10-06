import { REPAYMENT_PERIOD_SECONDS } from './cost.ts'
import { accrueTo, type LoanState } from './position.ts'

// How much of a reward token account the operator lets the protocol withhold from
// (FR-014). The allowance is in reward units while the debt is in the stablecoin, so it
// is the debt converted at an attested rate (FR-015b), and never worth more (FR-014a).

const RATE_UNIT = 1_000_000_000_000n

export function newLoanState(input: {
  principal: bigint
  aprBps: number
  termPeriods: number
  now: bigint
}): LoanState {
  return {
    principal: input.principal,
    outstanding: input.principal,
    accruedInterest: 0n,
    interestRemainder: 0n,
    openedAt: input.now,
    dueAt: input.now + BigInt(input.termPeriods) * REPAYMENT_PERIOD_SECONDS,
    lastAccrualAt: input.now,
    aprBps: input.aprBps,
  }
}

// The most the loans can be owed within their term: interest up to the due date on what
// is outstanding, as if nothing were repaid before it. More is never owed in the term,
// so the allowance lasts however the payouts come, and a sweep takes no more than the
// actual debt anyway. Past the due date the debt as it is now: tomorrow's would already
// be more than is owed.
export function debtCeiling(loans: readonly LoanState[], now: bigint): bigint {
  return loans.reduce((total, loan) => {
    const until = loan.dueAt > now ? loan.dueAt : now
    return total + loan.outstanding + accrueTo(loan, until).accruedInterest
  }, 0n)
}

// Rounded down: the value delegated may not exceed the debt (FR-014a).
export function rewardAllowance(ceiling: bigint, stablePerTrillionReward: bigint): bigint {
  if (stablePerTrillionReward <= 0n) throw new RangeError('a rate must be positive')
  return (ceiling * RATE_UNIT) / stablePerTrillionReward
}
