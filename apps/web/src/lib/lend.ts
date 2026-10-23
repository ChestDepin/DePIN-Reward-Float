import type { WithdrawalLimit, WithdrawalQuote } from '@drf/shared/loan'
import type { BorrowFailure } from './borrow'
import { formatUsd } from './format'

// `wanted`: what the lender asked for, capped at what their position is worth.
export function withdrawalText(quote: WithdrawalQuote, wanted: bigint): string | null {
  if (!quote.ok) {
    return quote.reason === 'no-free-liquidity'
      ? 'Everything in the pool is lent out right now, so nothing can be withdrawn yet. Your position stays in and keeps earning; it can be withdrawn as the loans are repaid.'
      : 'You have nothing in this pool to withdraw.'
  }
  if (quote.limitedBy === 'free-liquidity') {
    return `Only ${formatUsd(quote.paid.toString())} is free right now; the rest is lent out. You get that, and the other ${formatUsd((wanted - quote.paid).toString())} stays in the pool, earning, until loans are repaid.`
  }
  if (quote.limitedBy === 'position') {
    return `That is more than you hold: you get all your position is worth, ${formatUsd(quote.paid.toString())}.`
  }
  return null
}

export function withdrawnText(event: { paid: bigint; limitedBy: WithdrawalLimit | null }): string {
  const paid = formatUsd(event.paid.toString())
  if (event.limitedBy === 'free-liquidity') {
    return `Withdrew ${paid}, all that was free in the pool; the rest of your position stays in and keeps earning.`
  }
  if (event.limitedBy === 'position') return `Withdrew ${paid}, all your position was worth.`
  return `Withdrew ${paid}.`
}

export function lendFailureText(action: 'deposit' | 'withdrawal', failure: BorrowFailure): string {
  if (failure.kind === 'rejected') return 'The wallet declined. Nothing was sent.'
  if (failure.kind === 'program') return `The program refused the ${action}: ${failure.message}.`
  return `The ${action} did not go through${failure.kind === 'unknown' ? `: ${failure.message}` : '.'}`
}
