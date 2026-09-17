import { describe, expect, it } from 'vitest'
import { formatTokens, formatUsd } from './format'

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
