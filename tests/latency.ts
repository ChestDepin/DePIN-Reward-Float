// Найближчий ранг, без інтерполяції: p95 має бути числом, яке справді
// заміряли, інакше бюджет проходить значення, якого жоден запит не показав.
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) throw new Error('percentile of no samples')
  if (fraction <= 0 || fraction > 1) throw new Error(`fraction out of range: ${fraction}`)

  const sorted = [...samples].sort((left, right) => left - right)
  const rank = Math.ceil(fraction * sorted.length) - 1
  const value = sorted[rank]

  if (value === undefined) throw new Error(`rank ${rank} outside ${sorted.length} samples`)

  return value
}
