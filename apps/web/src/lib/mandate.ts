import type { RewardAccount } from '@drf/anchor-client'
import {
  applyRepayment,
  debtCeiling,
  type LoanState,
  newLoanState,
  rewardAllowance,
} from '@drf/shared/loan'
import type { PublicKey } from '@solana/web3.js'

export type MandateLoan = LoanState & { rewardMint: PublicKey }
export type ForeignDelegate = { delegate: PublicKey; delegatedAmount: bigint }
export type MandateState =
  | { kind: 'none' }
  | { kind: 'idle'; delegatedAmount: bigint }
  // target: the allowance the debt needs, in reward units; null while there is no rate.
  | { kind: 'missing'; foreign: ForeignDelegate | null; target: bigint | null }
  | { kind: 'active'; delegatedAmount: bigint; target: bigint | null }
export type RepaymentDelegation =
  | { kind: 'keep' }
  | { kind: 'revoke' }
  | { kind: 'set'; ceiling: bigint; allowance: bigint }

// A token account has one delegate, so the allowance on it covers every open loan
// repaid from that token, the new one included.
export function delegationFor(input: {
  loans: readonly MandateLoan[]
  rewardMint: PublicKey
  newLoan?: { principal: bigint; aprBps: number; termPeriods: number }
  rate: bigint
  now: bigint
}): { ceiling: bigint; allowance: bigint } {
  const { loans, rewardMint, newLoan, rate, now } = input
  const covered: LoanState[] = loans.filter((loan) => loan.rewardMint.equals(rewardMint))
  if (newLoan !== undefined) covered.push(newLoanState({ ...newLoan, now }))
  const ceiling = debtCeiling(covered, now)
  return { ceiling, allowance: rewardAllowance(ceiling, rate) }
}

// Approving replaces whatever delegate the account had; a spent allowance takes nothing,
// so only one that can still take is worth asking the operator about.
export function foreignDelegate(account: RewardAccount, ours: PublicKey): ForeignDelegate | null {
  if (!account.exists || account.delegate === null || account.delegate.equals(ours)) return null
  if (account.delegatedAmount === 0n) return null
  return { delegate: account.delegate, delegatedAmount: account.delegatedAmount }
}

export function mandateState(input: {
  account: RewardAccount
  ours: PublicKey
  owed: boolean
  target: bigint | null
}): MandateState {
  const { account, ours, owed, target } = input
  const delegatedToUs =
    account.exists && account.delegate?.equals(ours) === true ? account.delegatedAmount : 0n
  if (!owed) {
    return delegatedToUs === 0n
      ? { kind: 'none' }
      : { kind: 'idle', delegatedAmount: delegatedToUs }
  }
  if (delegatedToUs === 0n) {
    return { kind: 'missing', foreign: foreignDelegate(account, ours), target }
  }
  return { kind: 'active', delegatedAmount: delegatedToUs, target }
}

// A repayment lowers the debt, so the allowance on that token moves with it in the same
// transaction (FR-014a). Only a live permission of ours is moved: one the operator
// revoked stays revoked (FR-014), and another delegate is not ours to touch. The loans
// are run forward to the signing moment; the slot lands later, with a little more
// interest taken and so a little more left owed, which keeps the allowance under it.
export function delegationAfterRepayment(input: {
  loans: readonly MandateLoan[]
  perLoan: readonly bigint[]
  rewardMint: PublicKey
  account: RewardAccount
  ours: PublicKey
  rate: bigint | null
  at: bigint
}): RepaymentDelegation {
  const { loans, perLoan, rewardMint, account, ours, rate, at } = input
  if (!account.exists || account.delegate?.equals(ours) !== true) return { kind: 'keep' }
  if (account.delegatedAmount === 0n) return { kind: 'keep' }
  const repaid = loans.map((loan, index) => ({ loan, paid: perLoan[index] ?? 0n }))
  const covered = repaid.filter(({ loan }) => loan.rewardMint.equals(rewardMint))
  if (covered.every(({ paid }) => paid === 0n)) return { kind: 'keep' }

  const left = covered.flatMap(({ loan, paid }) => applyRepayment(loan, paid, at) ?? [])
  const ceiling = debtCeiling(left, at)
  if (ceiling === 0n) return { kind: 'revoke' }
  // Without a rate the allowance shrinks with the debt: the ceiling within the term does
  // not move with time, so the share kept is the share of the debt still owed.
  const before = debtCeiling(
    covered.map(({ loan }) => loan),
    at,
  )
  const allowance =
    rate === null ? (account.delegatedAmount * ceiling) / before : rewardAllowance(ceiling, rate)
  return allowance === 0n ? { kind: 'revoke' } : { kind: 'set', ceiling, allowance }
}
