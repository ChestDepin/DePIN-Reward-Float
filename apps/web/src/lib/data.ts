// Єдине, що лишилось від прототипу M0: макет умов позики. Позики ще немає —
// ані ендпоінта, ані грошей, — тож ці числа вигадані, і сторінка каже це вголос.
// Історія виплат і ліміт беруться з api і сюди більше не заглядають.

export const OFFER_TERMS: [string, string][] = [
  ['amount requested', '$500.00 USDC'],
  ['credit limit', '$555.00'],
  ['fixed rate', '18.0% APR, fixed at issue'],
  ['term', '180 days'],
  ['interest over full term', '$44.38'],
  ['total to repay', '$544.38'],
  ['withheld from each payout', '60%'],
]

export const REPAYMENT_ROWS: [string, string][] = [
  ['median monthly flow', '$177.56'],
  ['withheld per month', '$106.54'],
  ['months to clear', '5.1'],
  ['projected clear date', '2027-02-01   (25 days before term ends)'],
]
