import type { RewardAccount } from '@drf/anchor-client'
import { REPAYMENT_PERIOD_SECONDS } from '@drf/shared/loan'
import { Keypair, type PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { delegationFor, foreignDelegate, type MandateLoan, mandateState } from './mandate'

function key(seed: number): PublicKey {
  return Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey
}

const NOW = 1_791_288_000n
const HONEY = key(1)
const HNT = key(2)
const OURS = key(3)
const STRANGER = key(4)
const ACCOUNT = key(5)
// 1000 HONEY for 2.406662 USDC.
const RATE = 2_406_662n

const loan = (rewardMint: PublicKey, outstanding: bigint): MandateLoan => ({
  rewardMint,
  principal: outstanding,
  outstanding,
  accruedInterest: 0n,
  interestRemainder: 0n,
  openedAt: NOW,
  dueAt: NOW + 3n * REPAYMENT_PERIOD_SECONDS,
  lastAccrualAt: NOW,
  aprBps: 2000,
})

const account = (delegate: PublicKey | null, delegatedAmount: bigint): RewardAccount => ({
  address: ACCOUNT,
  exists: true,
  amount: 0n,
  delegate,
  delegatedAmount,
})

describe('delegationFor', () => {
  it('covers the new loan to its due date at the attested rate', () => {
    const delegation = delegationFor({
      loans: [],
      rewardMint: HONEY,
      newLoan: { principal: 100_000_000n, aprBps: 2000, termPeriods: 3 },
      rate: RATE,
      now: NOW,
    })

    expect(delegation).toEqual({ ceiling: 104_931_506n, allowance: 43_600_433_297_239n })
  })

  // One account, one delegate: the allowance has to cover every loan repaid from it.
  it('adds the open loans repaid from the same token, and only those', () => {
    const delegation = delegationFor({
      loans: [loan(HONEY, 100_000_000n), loan(HNT, 50_000_000n)],
      rewardMint: HONEY,
      newLoan: { principal: 100_000_000n, aprBps: 2000, termPeriods: 3 },
      rate: RATE,
      now: NOW,
    })

    expect(delegation.ceiling).toBe(2n * 104_931_506n)
  })

  it('is what the open loans need when there is no new loan', () => {
    expect(
      delegationFor({ loans: [loan(HONEY, 100_000_000n)], rewardMint: HONEY, rate: RATE, now: NOW })
        .ceiling,
    ).toBe(104_931_506n)
  })
})

describe('foreignDelegate', () => {
  it('names another protocol that may still take from the account', () => {
    expect(foreignDelegate(account(STRANGER, 9n), OURS)).toEqual({
      delegate: STRANGER,
      delegatedAmount: 9n,
    })
  })

  it('ignores our own delegation, a spent one and an account with none', () => {
    expect(foreignDelegate(account(OURS, 9n), OURS)).toBeNull()
    expect(foreignDelegate(account(STRANGER, 0n), OURS)).toBeNull()
    expect(foreignDelegate(account(null, 0n), OURS)).toBeNull()
    expect(foreignDelegate({ address: ACCOUNT, exists: false }, OURS)).toBeNull()
  })
})

describe('mandateState', () => {
  it('is nothing to do with no debt and no delegation to us', () => {
    expect(
      mandateState({ account: account(STRANGER, 9n), ours: OURS, owed: false, target: 0n }),
    ).toEqual({
      kind: 'none',
    })
  })

  // FR-014a: with nothing owed, any allowance is more than the debt.
  it('flags a delegation left behind after the debt is gone', () => {
    expect(
      mandateState({ account: account(OURS, 9n), ours: OURS, owed: false, target: 0n }),
    ).toEqual({
      kind: 'idle',
      delegatedAmount: 9n,
    })
  })

  // FR-017: no allowance means the loan is repaid by hand.
  it('says the debt is not covered when nothing is delegated to us', () => {
    expect(
      mandateState({ account: account(null, 0n), ours: OURS, owed: true, target: 5n }),
    ).toEqual({
      kind: 'missing',
      foreign: null,
      target: 5n,
    })
    expect(
      mandateState({ account: account(STRANGER, 9n), ours: OURS, owed: true, target: 5n }),
    ).toEqual({
      kind: 'missing',
      foreign: { delegate: STRANGER, delegatedAmount: 9n },
      target: 5n,
    })
    expect(
      mandateState({ account: account(OURS, 0n), ours: OURS, owed: true, target: 5n }),
    ).toMatchObject({
      kind: 'missing',
    })
  })

  // Without a rate the target in reward units is unknown, but what is delegated is not,
  // and revoking needs no rate at all.
  it('still tells covered from uncovered debt when the rate is unknown', () => {
    expect(
      mandateState({ account: account(OURS, 4n), ours: OURS, owed: true, target: null }),
    ).toEqual({ kind: 'active', delegatedAmount: 4n, target: null })
    expect(
      mandateState({ account: account(null, 0n), ours: OURS, owed: true, target: null }),
    ).toEqual({ kind: 'missing', foreign: null, target: null })
  })

  it('shows what is delegated against what the debt needs', () => {
    expect(
      mandateState({ account: account(OURS, 4n), ours: OURS, owed: true, target: 5n }),
    ).toEqual({
      kind: 'active',
      delegatedAmount: 4n,
      target: 5n,
    })
  })
})
