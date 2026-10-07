import type { RewardAccount } from '@drf/anchor-client'
import { REPAYMENT_PERIOD_SECONDS } from '@drf/shared/loan'
import { Keypair, type PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  delegationAfterRepayment,
  delegationFor,
  foreignDelegate,
  type MandateLoan,
  mandateState,
  manualRepaymentText,
  manualStopText,
} from './mandate'

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

describe('delegationAfterRepayment', () => {
  const AT = NOW + 10n * 86_400n
  const loans = [loan(HONEY, 100_000_000n), loan(HONEY, 50_000_000n), loan(HNT, 50_000_000n)]
  const DELEGATED = 60_000_000_000_000n
  const after = (
    perLoan: bigint[],
    overrides: Partial<{ account: RewardAccount; rate: bigint | null }> = {},
  ) =>
    delegationAfterRepayment({
      loans,
      perLoan,
      rewardMint: HONEY,
      account: account(OURS, DELEGATED),
      ours: OURS,
      rate: RATE,
      at: AT,
      ...overrides,
    })

  // FR-014a as a state: what the HONEY loans can still be owed, at the attested rate.
  it('sets the allowance to what the loans left on this token can still be owed', () => {
    expect(after([30_000_000n, 0n, 0n])).toEqual({
      kind: 'set',
      ceiling: 126_106_210n,
      allowance: 52_398_803_820_395n,
    })
  })

  it('may set it higher than it was: the allowance follows the debt, not the last one', () => {
    expect(after([30_000_000n, 0n, 0n], { account: account(OURS, 1n) })).toMatchObject({
      kind: 'set',
      allowance: 52_398_803_820_395n,
    })
  })

  // The ceiling within the term does not move with time, so the old allowance scaled by
  // it stays within the debt at whatever rate the operator agreed to.
  it('scales the allowance down with the debt when there is no rate', () => {
    expect(after([30_000_000n, 0n, 0n], { rate: null })).toEqual({
      kind: 'set',
      ceiling: 126_106_210n,
      allowance: 48_071_819_344_706n,
    })
  })

  it('revokes once no loan repaid from this token is left open', () => {
    expect(after([200_000_000n, 100_000_000n, 0n])).toEqual({ kind: 'revoke' })
    expect(after([200_000_000n, 100_000_000n, 0n], { rate: null })).toEqual({ kind: 'revoke' })
  })

  it('leaves the allowance alone when no loan on this token was repaid', () => {
    expect(after([0n, 0n, 50_000_000n])).toEqual({ kind: 'keep' })
  })

  // FR-014: a revoked permission is the operator's choice, and another protocol's
  // permission is not ours to touch.
  it('never touches a permission that is not ours and alive', () => {
    for (const other of [
      account(null, 0n),
      account(STRANGER, DELEGATED),
      account(OURS, 0n),
      { address: ACCOUNT, exists: false } as const,
    ]) {
      expect(after([200_000_000n, 100_000_000n, 0n], { account: other })).toEqual({ kind: 'keep' })
      expect(after([30_000_000n, 0n, 0n], { account: other })).toEqual({ kind: 'keep' })
    }
  })
})

describe('why a loan needs a manual repayment', () => {
  it('names each cause in its own words', () => {
    expect(manualRepaymentText('revoked')).toMatch(/permission .* was revoked/)
    expect(manualRepaymentText('allowanceShort')).toMatch(/permission left is too small/)
    expect(manualRepaymentText('withdrawnEarly')).toMatch(/left the reward account before/)
  })

  // Repaying by hand works whatever the cause; a repayment does not set a missing permission
  // again, so the two causes that took it away also point to where it is given.
  it('says what to do and what is blocked meanwhile, whatever the cause', () => {
    for (const reason of ['revoked', 'allowanceShort', 'withdrawnEarly'] as const) {
      expect(manualRepaymentText(reason)).toMatch(/Repay it below/)
      expect(manualRepaymentText(reason)).toMatch(/no new loan/)
    }
    expect(manualRepaymentText('revoked')).toMatch(/Mandate/)
    expect(manualRepaymentText('allowanceShort')).toMatch(/Mandate/)
    expect(manualRepaymentText('withdrawnEarly')).not.toMatch(/Mandate/)
  })
})

// The journal says when withholding stopped and why; what to do is on the loan itself.
describe('a flag in the withholdings journal', () => {
  it('names the cause the api reports in the words the loan uses', () => {
    expect(manualStopText('revoked')).toMatch(/^Automatic repayment stopped: .*was revoked\.$/)
    expect(manualStopText('allowance-short')).toMatch(/permission left is too small/)
    expect(manualStopText('withdrawn-early')).toMatch(/left the reward account before/)
  })

  it('leaves what to do to the loan, which knows whether it is still flagged', () => {
    for (const reason of ['revoked', 'allowance-short', 'withdrawn-early'] as const) {
      expect(manualStopText(reason)).not.toMatch(/Repay it below|Mandate/)
    }
  })
})
