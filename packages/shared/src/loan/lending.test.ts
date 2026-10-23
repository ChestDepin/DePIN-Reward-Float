import { describe, expect, it } from 'vitest'
import { accrueTo, type LoanState } from './position.ts'
import { type PoolBook, quoteWithdrawal, unbookedInterest, valueOfShares } from './lending.ts'

const NOW = 1_790_157_600n
const YEAR = 365n * 86_400n
const U64_MAX = 2n ** 64n - 1n

function pool(overrides: Partial<PoolBook> = {}): PoolBook {
  return {
    totalShares: 0n,
    totalDeposits: 0n,
    totalBorrowed: 0n,
    accruedInterest: 0n,
    accrualRate: 0n,
    accrualRateTime: 0n,
    accrualRemainders: 0n,
    ...overrides,
  }
}

// Pool::track: what an open loan adds to the pool's accrual sums.
function track(book: PoolBook, loan: LoanState): PoolBook {
  const rate = loan.outstanding * BigInt(loan.aprBps)
  return {
    ...book,
    accrualRate: book.accrualRate + rate,
    accrualRateTime: book.accrualRateTime + rate * loan.lastAccrualAt,
    accrualRemainders: book.accrualRemainders + loan.interestRemainder,
  }
}

function loan(outstanding: bigint, aprBps: number, lastAccrualAt: bigint): LoanState {
  return {
    principal: outstanding,
    outstanding,
    accruedInterest: 0n,
    interestRemainder: 0n,
    openedAt: lastAccrualAt,
    dueAt: lastAccrualAt + 90n * 86_400n,
    lastAccrualAt,
    aprBps,
  }
}

// 1000 shares for 1250 units: 1.25 a share. The lender holds 400 of them, worth 500.
const priced = pool({ totalShares: 1_000n, totalDeposits: 1_000n, accruedInterest: 250n })

describe('unbookedInterest', () => {
  it('is what the open loans earned since they were last touched', () => {
    const book = track(pool(), loan(100_000_000n, 1_000, NOW))

    expect(unbookedInterest(book, NOW)).toBe(0n)
    // 10 % a year on 100 USDC.
    expect(unbookedInterest(book, NOW + YEAR)).toBe(10_000_000n)
  })

  it('is what the loans would book if each were touched now, give or take a unit each', () => {
    const loans = [
      { ...loan(123_456_789n, 1_317, NOW - 86_400n), interestRemainder: 10_000n * YEAR - 1n },
      { ...loan(7_654_321n, 2_799, NOW - 3_333n), interestRemainder: 12_345n },
      loan(1n, 801, NOW - 17n),
    ]
    const book = loans.reduce(track, pool())
    const later = NOW + 40n * 86_400n + 7n
    const booked = loans.reduce((sum, l) => sum + accrueTo(l, later).accruedInterest, 0n)
    const unbooked = unbookedInterest(book, later)

    expect(booked).toBeGreaterThan(0n)
    expect(unbooked >= booked && unbooked - booked < BigInt(loans.length)).toBe(true)
  })

  it('counts a clock behind the last accrual as nothing earned', () => {
    const book = track(pool(), loan(100_000_000n, 1_000, NOW))

    expect(unbookedInterest(book, NOW - 600n)).toBe(0n)
  })
})

describe('valueOfShares', () => {
  it('splits the interest between lenders by their shares without anyone acting', () => {
    const book = track(
      pool({ totalShares: 100_000_000n, totalDeposits: 100_000_000n, totalBorrowed: 100_000_000n }),
      loan(100_000_000n, 1_000, NOW),
    )

    expect(valueOfShares(book, 75_000_000n, NOW)).toBe(75_000_000n)
    expect(valueOfShares(book, 75_000_000n, NOW + YEAR)).toBe(82_500_000n)
    expect(valueOfShares(book, 25_000_000n, NOW + YEAR)).toBe(27_500_000n)
  })

  it('shares booked interest like unbooked interest', () => {
    expect(
      valueOfShares(pool({ totalShares: 4n, totalDeposits: 1_000n, accruedInterest: 200n }), 1n, NOW),
    ).toBe(300n)
  })

  it('rounds down, so a lender is never shown more than the program would pay', () => {
    const book = pool({ totalShares: 3n, totalDeposits: 4n })

    expect(valueOfShares(book, 1n, NOW)).toBe(1n)
    expect(valueOfShares(book, 3n, NOW)).toBe(4n)
  })

  it('is nothing for no shares, in an empty pool too', () => {
    expect(valueOfShares(pool(), 0n, NOW)).toBe(0n)
    expect(valueOfShares(pool({ totalShares: 10n, totalDeposits: 10n }), 0n, NOW)).toBe(0n)
  })

  it('does not lose the last digits in the largest pool', () => {
    const book = pool({ totalShares: U64_MAX, totalDeposits: U64_MAX, accruedInterest: U64_MAX })

    expect(valueOfShares(book, U64_MAX / 2n, NOW)).toBe(U64_MAX - 1n)
  })

  it('refuses more shares than the pool issued instead of valuing them', () => {
    expect(() =>
      valueOfShares(pool({ totalShares: 10n, totalDeposits: 10n }), 11n, NOW),
    ).toThrow(RangeError)
    expect(() => valueOfShares(pool(), 1n, NOW)).toThrow(RangeError)
  })
})

describe('quoteWithdrawal', () => {
  it('pays what was asked and burns the shares it is worth', () => {
    expect(quoteWithdrawal(priced, 400n, 125n, NOW)).toEqual({
      ok: true,
      paid: 125n,
      shares: 100n,
      limitedBy: null,
    })
  })

  it('burns whole shares, rounded up', () => {
    const quote = quoteWithdrawal(priced, 400n, 1n, NOW)

    expect(quote.ok && quote.shares).toBe(1n)
  })

  it('pays the whole position when asked for more, and says the position held it back', () => {
    expect(quoteWithdrawal(priced, 400n, U64_MAX, NOW)).toEqual({
      ok: true,
      paid: 500n,
      shares: 400n,
      limitedBy: 'position',
    })
  })

  it('burns every share when leaving the pool, even past the rounding', () => {
    // Six shares at 0.3 are worth 1.8 and pay 1, which is priced at 3.33 shares.
    expect(
      quoteWithdrawal(pool({ totalShares: 10n, totalDeposits: 3n }), 6n, U64_MAX, NOW),
    ).toEqual({ ok: true, paid: 1n, shares: 6n, limitedBy: 'position' })
  })

  it('pays what is free when asked for more, and says the free liquidity held it back', () => {
    expect(quoteWithdrawal({ ...priced, totalBorrowed: 700n }, 400n, 500n, NOW)).toEqual({
      ok: true,
      paid: 300n,
      shares: 240n,
      limitedBy: 'free-liquidity',
    })
  })

  it('names the position, not the free liquidity, when the two hold back the same amount', () => {
    // Exactly 500 free and a position worth 500: nothing of the lender's is left behind.
    expect(quoteWithdrawal({ ...priced, totalBorrowed: 500n }, 400n, U64_MAX, NOW)).toEqual({
      ok: true,
      paid: 500n,
      shares: 400n,
      limitedBy: 'position',
    })
  })

  it('prices the shares on interest earned up to this second', () => {
    const book = track(
      pool({ totalShares: 100_000_000n, totalDeposits: 100_000_000n, totalBorrowed: 50_000_000n }),
      loan(50_000_000n, 1_000, NOW),
    )

    expect(quoteWithdrawal(book, 40_000_000n, U64_MAX, NOW + YEAR)).toEqual({
      ok: true,
      paid: 42_000_000n,
      shares: 40_000_000n,
      limitedBy: 'position',
    })
  })

  it('explains a pool with nothing free instead of paying nothing', () => {
    expect(quoteWithdrawal({ ...priced, totalBorrowed: 1_000n }, 400n, 1n, NOW)).toEqual({
      ok: false,
      reason: 'no-free-liquidity',
    })
  })

  it('has nothing to pay a lender without shares, or with shares in a pool worth nothing', () => {
    expect(quoteWithdrawal(priced, 0n, 1n, NOW)).toEqual({
      ok: false,
      reason: 'nothing-to-withdraw',
    })
    expect(quoteWithdrawal(pool({ totalShares: 10n }), 10n, 1n, NOW)).toEqual({
      ok: false,
      reason: 'nothing-to-withdraw',
    })
  })

  it('refuses to quote nothing', () => {
    expect(() => quoteWithdrawal(priced, 400n, 0n, NOW)).toThrow(RangeError)
  })
})
