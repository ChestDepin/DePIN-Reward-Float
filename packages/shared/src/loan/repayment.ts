// One amount repaid across an operator's open loans (FR-011), split into a ceiling per
// loan for the program's `repay`, which takes min(ceiling, debt) of each.

import { accrueTo, type LoanState, loanPosition, type NextPayment } from './position.ts'

// Interest keeps accruing between the signature and the slot the transaction lands in.
// Repaying everything asks for the debt as it will be this far ahead; the program takes
// no more than the debt, so the excess stays in the wallet and the loan does close.
export const REPAY_ALL_MARGIN_SECONDS = 600n

export type Allocation =
  | { ok: true; perLoan: bigint[] }
  | { ok: false; reason: 'nothing' }
  | { ok: false; reason: 'over-debt'; max: bigint }

function ceiling(loan: LoanState, now: bigint): bigint {
  return loan.outstanding + accrueTo(loan, now + REPAY_ALL_MARGIN_SECONDS).accruedInterest
}

function dueOrder(next: NextPayment): [number, bigint] {
  return next.kind === 'due-now' ? [0, next.since] : [1, next.dueAt]
}

export function repayAllAmount(loans: readonly LoanState[], now: bigint): bigint {
  return loans.reduce((total, loan) => total + ceiling(loan, now), 0n)
}

// The order the next payment is shown in: what is due now from the oldest arrear, then
// the nearest instalment. Every loan's next payment is met before any loan is paid
// ahead, so an amount equal to the next payment shown repays exactly that payment.
export function allocateRepayment(
  loans: readonly LoanState[],
  amount: bigint,
  now: bigint,
): Allocation {
  if (amount <= 0n) return { ok: false, reason: 'nothing' }
  const max = repayAllAmount(loans, now)
  if (amount > max) return { ok: false, reason: 'over-debt', max }

  const queue = loans
    .map((loan, index) => {
      const next = loanPosition(loan, now).next
      const cap = ceiling(loan, now)
      const due = next.principal + next.interest
      return { index, next, cap, due: due < cap ? due : cap }
    })
    .sort((a, b) => {
      const [kindA, atA] = dueOrder(a.next)
      const [kindB, atB] = dueOrder(b.next)
      return kindA - kindB || (atA < atB ? -1 : atA > atB ? 1 : 0)
    })

  const perLoan = loans.map(() => 0n)
  let left = amount
  for (const pass of ['due', 'cap'] as const) {
    for (const entry of queue) {
      const given = perLoan[entry.index] ?? 0n
      const room = entry[pass] - given
      const take = room < left ? room : left
      if (take <= 0n) continue
      perLoan[entry.index] = given + take
      left -= take
    }
  }
  return { ok: true, perLoan }
}
