import { describe, expect, it } from 'vitest'
import { formatCents, formatCost, formatTokens, formatUsd, roundRowsToCents } from './format'

describe('formatUsd', () => {
  it('reads micro-dollars, the unit the api answers in', () => {
    expect(formatUsd('163980000')).toBe('$163.98')
  })

  it('groups thousands', () => {
    expect(formatUsd('1965490000')).toBe('$1,965.49')
  })

  it('keeps both cents when the second one is a zero', () => {
    expect(formatUsd('555000000')).toBe('$555.00')
  })

  // Округлення вгору показало б долар, якого розрахунок не давав, а ліміт —
  // це обіцянка суми, яку видадуть.
  it('rounds down, never up', () => {
    expect(formatUsd('163989999')).toBe('$163.98')
  })

  it('shows a real zero as a zero', () => {
    expect(formatUsd('0')).toBe('$0.00')
  })

  it('survives a number no double could hold', () => {
    expect(formatUsd('123456789012345678')).toBe('$123,456,789,012.34')
  })

  it('refuses anything that is not a whole number of micro-dollars', () => {
    expect(() => formatUsd('12.5')).toThrow()
    expect(() => formatUsd('')).toThrow()
  })
})

describe('formatTokens', () => {
  it('places the decimal point the network declares', () => {
    expect(formatTokens('4090000000000', 9)).toBe('4,090')
  })

  it('keeps two decimals when the amount has them', () => {
    expect(formatTokens('4090250000000', 9)).toBe('4,090.25')
  })

  it('drops a trailing zero instead of showing 4,090.20 as 4,090.2', () => {
    expect(formatTokens('4090200000000', 9)).toBe('4,090.2')
  })

  it('does not lie about a dust amount by rounding it to zero', () => {
    expect(formatTokens('1', 9)).toBe('< 0.01')
  })

  it('shows a true zero as a zero', () => {
    expect(formatTokens('0', 9)).toBe('0')
  })

  it('handles a token with no decimals at all', () => {
    expect(formatTokens('4090', 0)).toBe('4,090')
  })
})

describe('formatCost', () => {
  // A cost is a promise of what will be charged: shown short, it would be a lie.
  it('rounds a cost up to the cent', () => {
    expect(formatCost(2_958_904n)).toBe('$2.96')
    expect(formatCost(2_950_001n)).toBe('$2.96')
    expect(formatCost(1n)).toBe('$0.01')
  })

  it('leaves an exact cent and zero as they are', () => {
    expect(formatCost(102_950_000n)).toBe('$102.95')
    expect(formatCost(0n)).toBe('$0.00')
  })
})

describe('roundRowsToCents', () => {
  const CENT = 10_000n

  it('gives the cents left over to the rows that lost the most, so the rows add up', () => {
    expect(roundRowsToCents([66_666_667n, 66_666_667n, 66_666_666n])).toEqual([6667n, 6667n, 6666n])
  })

  it('adds up to the total rounded up, each row within a cent of what it is', () => {
    const rows = [2_301_370n, 1_534_246n, 767_123n, 5n, 0n, 9_999n]
    const cents = roundRowsToCents(rows)
    const total = rows.reduce((sum, row) => sum + row, 0n)

    expect(cents.reduce((sum, row) => sum + row, 0n)).toBe((total + CENT - 1n) / CENT)
    cents.forEach((cent, i) => {
      const exact = rows[i] ?? 0n
      expect(cent * CENT >= exact - CENT && cent * CENT <= exact + CENT).toBe(true)
    })
  })

  it('leaves whole cents alone and a zero at zero', () => {
    expect(roundRowsToCents([10_000n, 0n, 250_000n])).toEqual([1n, 0n, 25n])
    expect(roundRowsToCents([])).toEqual([])
  })
})

describe('formatCents', () => {
  it('writes cents as dollars', () => {
    expect(formatCents(20_000n)).toBe('$200.00')
    expect(formatCents(1_234_567n)).toBe('$12,345.67')
    expect(formatCents(5n)).toBe('$0.05')
  })
})
