// The program's loan arithmetic, off-chain: the page has to show what a loan costs
// before it is signed (FR-009a), and the numbers must be the ones the program books.

export const REPAYMENT_PERIOD_SECONDS = 30n * 86_400n
export const MAX_TERM_PERIODS = 6

const SECONDS_PER_DAY = 86_400n
const SECONDS_PER_YEAR = 365n * SECONDS_PER_DAY
const ACCRUAL_DENOMINATOR = 10_000n * SECONDS_PER_YEAR
const U64_MAX = 2n ** 64n - 1n
const U16_MAX = 65_535

export type PoolTerms = {
  baseAprBps: number
  slopeAprBps: number
  totalBorrowed: bigint
  totalDeposits: bigint
}

export type AprQuote =
  | { ok: true; aprBps: number }
  | { ok: false; reason: 'insufficient-liquidity' }

function divCeil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

// The rate a loan of `amount` would be fixed at: the curve is read at the utilisation
// after this loan, not before it.
export function quoteAprBps(pool: PoolTerms, amount: bigint): AprQuote {
  const borrowed = pool.totalBorrowed + amount
  if (pool.totalDeposits <= 0n || borrowed > pool.totalDeposits) {
    return { ok: false, reason: 'insufficient-liquidity' }
  }
  const premium = divCeil(BigInt(pool.slopeAprBps) * borrowed, pool.totalDeposits)
  return { ok: true, aprBps: pool.baseAprBps + Number(premium) }
}

export type LoanTerms = { principal: bigint; aprBps: number; termPeriods: number }

export type ScheduleRow = {
  period: number
  dueAfterSeconds: bigint
  principal: bigint
  interest: bigint
}

export type LoanCost = {
  interestIfHeldToTerm: bigint
  totalIfHeldToTerm: bigint
  schedule: ScheduleRow[]
  interestOnSchedule: bigint
  totalOnSchedule: bigint
  interestPerDayPastDue: bigint
}

function checkTerms({ principal, aprBps, termPeriods }: LoanTerms): void {
  if (principal <= 0n || principal > U64_MAX) {
    throw new RangeError(`a principal of ${principal} is outside 1..u64`)
  }
  if (!Number.isInteger(aprBps) || aprBps < 0 || aprBps > U16_MAX) {
    throw new RangeError(`a rate of ${aprBps} bps is outside u16`)
  }
  if (!Number.isInteger(termPeriods) || termPeriods < 1 || termPeriods > MAX_TERM_PERIODS) {
    throw new RangeError(`a term of ${termPeriods} periods is outside 1..${MAX_TERM_PERIODS}`)
  }
}

// Interest is simple, by the second, on what is outstanding. The fraction of a unit is
// carried rather than dropped, so whatever the accrual steps, the interest booked by a
// moment is the floor of everything accrued until then.
export function loanCost(terms: LoanTerms): LoanCost {
  checkTerms(terms)
  const { principal, termPeriods } = terms
  const apr = BigInt(terms.aprBps)
  const periods = BigInt(termPeriods)

  const interestIfHeldToTerm =
    (principal * apr * REPAYMENT_PERIOD_SECONDS * periods) / ACCRUAL_DENOMINATOR

  const schedule: ScheduleRow[] = []
  let accrued = 0n
  let booked = 0n
  let repaid = 0n
  for (let k = 1n; k <= periods; k++) {
    accrued += (principal - repaid) * apr * REPAYMENT_PERIOD_SECONDS
    const interest = accrued / ACCRUAL_DENOMINATOR - booked
    booked += interest
    // Loan::principal_due_by: what is due by the end of period k, rounded up.
    const dueBy = divCeil(principal * k, periods)
    schedule.push({
      period: Number(k),
      dueAfterSeconds: k * REPAYMENT_PERIOD_SECONDS,
      principal: dueBy - repaid,
      interest,
    })
    repaid = dueBy
  }

  return {
    interestIfHeldToTerm,
    totalIfHeldToTerm: principal + interestIfHeldToTerm,
    schedule,
    interestOnSchedule: booked,
    totalOnSchedule: principal + booked,
    interestPerDayPastDue: divCeil(principal * apr * SECONDS_PER_DAY, ACCRUAL_DENOMINATOR),
  }
}
