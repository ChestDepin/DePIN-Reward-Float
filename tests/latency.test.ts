import { describe, expect, it } from 'vitest'
import { percentile } from './latency.ts'

describe('percentile', () => {
  it('takes the nearest rank, not an interpolated value between two samples', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20)
  })

  // Двадцять замірів — рівно один викид, який p95 має пробачити, і рівно один,
  // якого вже не пробачить.
  it('forgives exactly one outlier out of twenty', () => {
    const samples = [...Array(19).keys()].map((index) => index + 1)

    expect(percentile([...samples, 9_000], 0.95)).toBe(19)
    expect(percentile([...samples.slice(0, 18), 9_000, 9_001], 0.95)).toBe(9_000)
  })

  it('sorts the samples itself, because they arrive in the order they were measured', () => {
    expect(percentile([300, 100, 200], 0.5)).toBe(200)
  })

  it('answers the largest sample for the whole set', () => {
    expect(percentile([5, 1, 3], 1)).toBe(5)
  })

  it('answers the only sample there is', () => {
    expect(percentile([42], 0.95)).toBe(42)
  })

  // Порожній набір — не нуль: нуль пройшов би будь-який бюджет і оголосив
  // критерій виконаним на заміру, якого не було.
  it('refuses an empty set instead of answering zero', () => {
    expect(() => percentile([], 0.95)).toThrow(/no samples/)
  })

  it('refuses a fraction outside the set', () => {
    expect(() => percentile([1, 2], 0)).toThrow(/fraction/)
    expect(() => percentile([1, 2], 1.5)).toThrow(/fraction/)
  })
})
