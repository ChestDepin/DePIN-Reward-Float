import type { ReactNode } from 'react'
import type { ApiFailure } from '../lib/api'

// Кожна відмова названа своїми словами, і жодна з них не є нулем: «не змогли
// прочитати» і «порахували нуль» — різні твердження (FR-025).
const SAID: Record<ApiFailure['kind'], { title: string; detail: string }> = {
  'invalid-address': {
    title: 'NOT A WALLET ADDRESS',
    detail: 'This is not a Solana address, so there is nothing to look up.',
  },
  'not-found': {
    title: 'NOTHING HERE',
    detail: 'The api has no such route. This is our fault, not yours.',
  },
  'data-unavailable': {
    title: 'PAYOUT DATA UNAVAILABLE',
    detail:
      'Could not read the payout history. This is not a statement about this operator — the limit is unknown, not zero.',
  },
  unreachable: {
    title: 'API NOT ANSWERING',
    detail: 'Nothing was read, so nothing below would be true.',
  },
  broken: {
    title: 'ANSWER COULD NOT BE READ',
    detail: 'The api answered something we do not understand. Showing none of it is the honest option.',
  },
}

export const Failed = ({ failure, onRetry }: { failure: ApiFailure; onRetry?: () => void }) => {
  const said = SAID[failure.kind]

  return (
    <div className="mt-10 border-t border-rule pt-10">
      <div className="text-[20px] sm:text-[26px] tracking-[0.06em]">{said.title}</div>
      <p className="mt-4 max-w-[52ch] text-[13px] sm:text-[15px] leading-relaxed text-dim">
        {said.detail}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 text-[13px] text-ink underline underline-offset-4"
        >
          retry
        </button>
      )}
    </div>
  )
}

export const Loading = ({ what }: { what: string }) => (
  <p className="mt-10 text-[13px] text-dim">reading {what}…</p>
)

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="mt-10 max-w-[52ch] text-[13px] sm:text-[15px] leading-relaxed text-dim">
    {children}
  </p>
)
