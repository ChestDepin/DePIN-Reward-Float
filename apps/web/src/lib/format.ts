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
