// The program's share arithmetic, off-chain: a lender is shown what their shares are
// worth and what a withdrawal would pay before they sign (FR-019, FR-020).

// The fields of the on-chain `Pool` this arithmetic reads.
export type PoolBook = {
  totalShares: bigint
  totalDeposits: bigint
  totalBorrowed: bigint
  accruedInterest: bigint
  accrualRate: bigint
  accrualRateTime: bigint
  accrualRemainders: bigint
}

export type WithdrawalLimit = 'position' | 'free-liquidity'

export type WithdrawalQuote =
  | { ok: true; paid: bigint; shares: bigint; limitedBy: WithdrawalLimit | null }
  | { ok: false; reason: 'nothing-to-withdraw' | 'no-free-liquidity' }

const ACCRUAL_DENOMINATOR = 10_000n * 365n * 86_400n

const min = (a: bigint, b: bigint) => (a < b ? a : b)

// Pool::unbooked_interest.
export function unbookedInterest(pool: PoolBook, now: bigint): bigint {
  const earned = pool.accrualRate * now + pool.accrualRemainders
  return earned > pool.accrualRateTime
    ? (earned - pool.accrualRateTime) / ACCRUAL_DENOMINATOR
    : 0n
}

function poolValue(pool: PoolBook, now: bigint): bigint {
  return pool.totalDeposits + pool.accruedInterest + unbookedInterest(pool, now)
}

// Pool::value_of_shares, rounded down as the program rounds it.
export function valueOfShares(pool: PoolBook, shares: bigint, now: bigint): bigint {
  if (shares > pool.totalShares) {
    throw new RangeError(`${shares} shares, the pool issued ${pool.totalShares}`)
  }
  if (shares === 0n) return 0n
  return (shares * poolValue(pool, now)) / pool.totalShares
}

// Pool::withdrawal. The two refusals are the program's NothingToWithdraw and
// NoFreeLiquidity: answers a lender gets, not broken books.
export function quoteWithdrawal(
  pool: PoolBook,
  shares: bigint,
  maxAmount: bigint,
  now: bigint,
): WithdrawalQuote {
  if (maxAmount <= 0n) throw new RangeError(`cannot withdraw ${maxAmount}`)
  const worth = valueOfShares(pool, shares, now)
  if (worth === 0n) return { ok: false, reason: 'nothing-to-withdraw' }
  const free = pool.totalDeposits - pool.totalBorrowed
  if (free <= 0n) return { ok: false, reason: 'no-free-liquidity' }

  const paid = min(min(maxAmount, worth), free)
  const limitedBy = paid === maxAmount ? null : paid === worth ? 'position' : 'free-liquidity'
  if (paid === worth) return { ok: true, paid, shares, limitedBy }
  const value = poolValue(pool, now)
  const burned = (paid * pool.totalShares + value - 1n) / value
  return { ok: true, paid, shares: burned, limitedBy }
}
