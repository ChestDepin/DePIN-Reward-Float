const USD_DECIMALS = 6
const USD_FRACTION = 2
const TOKEN_FRACTION = 2

const wholeNumber = /^\d+$/

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Ділення цілих, а не число з комою: суми доходять до 10^18, де double вже
// втрачає останні цифри, і показане значення розійшлося б із порахованим.
function split(raw: string, decimals: number): { whole: string; fraction: string } {
  if (!wholeNumber.test(raw)) throw new Error(`not a whole number: ${raw}`)

  const padded = raw.padStart(decimals + 1, '0')
  const cut = padded.length - decimals

  return { whole: padded.slice(0, cut), fraction: padded.slice(cut) }
}

export function formatUsd(microUsd: string): string {
  const { whole, fraction } = split(microUsd, USD_DECIMALS)

  // Обрізаємо, а не округлюємо: показаний ліміт — обіцянка суми, яку видадуть,
  // і зайвий цент у ній береться нізвідки.
  return `$${group(whole)}.${fraction.slice(0, USD_FRACTION)}`
}

export function formatTokens(baseUnits: string, decimals: number): string {
  const { whole, fraction } = split(baseUnits, decimals)
  const shown = fraction.slice(0, TOKEN_FRACTION).replace(/0+$/, '')

  if (whole === '0' && shown === '') {
    // Пил існує, і нуль сказав би, що виплати не було взагалі.
    return /[1-9]/.test(fraction) ? '< 0.01' : '0'
  }

  return shown === '' ? group(whole) : `${group(whole)}.${shown}`
}

const CENT = 10_000n

// A cost is rounded up, the other way from a limit: the cost shown is what the operator
// agrees to pay, and a cent short of it is a cent they were not told about.
export function formatCost(baseUnits: bigint): string {
  return formatCents((baseUnits + CENT - 1n) / CENT)
}

export function formatCents(cents: bigint): string {
  return `$${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, '0')}`
}

// Rows of a table whose total is shown too. Rounding each row up on its own would make
// the rows add up to more than the total; here they add up to the total rounded up, and
// the extra cents go to the rows that lost the most to truncation.
export function roundRowsToCents(rows: readonly bigint[]): bigint[] {
  const cents = rows.map((row) => row / CENT)
  const total = rows.reduce((sum, row) => sum + row, 0n)
  let extra = (total + CENT - 1n) / CENT - cents.reduce((sum, cent) => sum + cent, 0n)
  const byRemainder = rows
    .map((row, index) => ({ index, remainder: row % CENT }))
    .sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : 0))
  for (const { index } of byRemainder) {
    if (extra === 0n) break
    cents[index] = (cents[index] ?? 0n) + 1n
    extra -= 1n
  }
  return cents
}
