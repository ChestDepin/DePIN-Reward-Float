// All figures are fixed mock data taken from the product brief.
// Nothing here is computed, fetched or signed.

export const HIVEMAPPER_ADDRESS = 'HvmDemo7xK2qF4b9WgQn3sT8yLcRzA1eU6dJ5mNpVe'
export const HELIUM_ADDRESS = 'He1iumDemo9pQ4rT7vXbN2kZmYs5wLgC8jEuA3fDhR'
export const DISTRIBUTOR_ADDRESS = 'HvmRwrdDistDemo4nQ8xT2cVbM6kLpZjR9sWyE3'

export type PayoutRow = {
  month: string
  honey: string | null
  price: string | null
  value: string | null
  valueNumber: number | null
}

export const PAYOUTS: PayoutRow[] = [
  { month: '2025-09', honey: '3,980', price: '$0.0412', value: '$163.98', valueNumber: 163.98 },
  { month: '2025-10', honey: '4,240', price: '$0.0388', value: '$164.51', valueNumber: 164.51 },
  { month: '2025-11', honey: '4,105', price: '$0.0451', value: '$185.14', valueNumber: 185.14 },
  { month: '2025-12', honey: '3,860', price: '$0.0523', value: '$201.88', valueNumber: 201.88 },
  { month: '2026-01', honey: '4,390', price: '$0.0498', value: '$218.62', valueNumber: 218.62 },
  { month: '2026-02', honey: '4,120', price: '$0.0441', value: '$181.69', valueNumber: 181.69 },
  { month: '2026-03', honey: null, price: null, value: null, valueNumber: null },
  { month: '2026-04', honey: '3,740', price: '$0.0356', value: '$133.14', valueNumber: 133.14 },
  { month: '2026-05', honey: '4,010', price: '$0.0402', value: '$161.20', valueNumber: 161.2 },
  { month: '2026-06', honey: '4,280', price: '$0.0437', value: '$187.04', valueNumber: 187.04 },
  { month: '2026-07', honey: '4,155', price: '$0.0469', value: '$194.87', valueNumber: 194.87 },
  { month: '2026-08', honey: '4,090', price: '$0.0424', value: '$173.42', valueNumber: 173.42 },
]

export const MAX_VALUE = 218.62

export type DerivationLine = {
  label: string
  clause: string[]
  operand: string | null
  result: string
}

export const DERIVATION: DerivationLine[] = [
  {
    label: 'median monthly flow',
    clause: ['middle of 12 observed months, in USD at payout time'],
    operand: null,
    result: '$177.56',
  },
  {
    label: 'advance period',
    clause: ['we lend four months of median flow, never more'],
    operand: '× 4 months',
    result: '$710.24',
  },
  {
    label: 'payout stability',
    clause: ['11 of 12 months had a payout; the March gap costs 8%'],
    operand: '× 0.92',
    result: '$653.42',
  },
  {
    label: 'HONEY volatility haircut',
    clause: ['90-day annualised volatility 78% — the token can fall', 'before the loan is repaid'],
    operand: '× 0.85',
    result: '$555.41',
  },
  {
    label: 'rounded down to nearest $5',
    clause: [],
    operand: null,
    result: '$555.00',
  },
]

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

export const REFUSED_FACTS: [string, string][] = [
  ['address', HELIUM_ADDRESS],
  ['network', 'Helium'],
  ['first payout', '2026-05-14'],
  ['observed', '4 complete months'],
  ['required', '6 complete months'],
]
