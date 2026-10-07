import { describe, expect, it } from 'vitest'
import { pollUntil } from './poll.ts'

function fakeClock(start = 0) {
  let now = start
  const slept: number[] = []
  return {
    slept,
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms)
      now += ms
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('pollUntil', () => {
  it('answers the first reading that is done, timed when that reading came back', async () => {
    const clock = fakeClock(1_000)
    const readings = [5, 5, 3, 2]
    const result = await pollUntil({
      read: async () => {
        clock.advance(200)
        return readings.shift() ?? 0
      },
      done: (value) => value < 5,
      since: 1_000,
      intervalMs: 1_000,
      timeoutMs: 120_000,
      ...clock,
    })

    expect(result).toEqual({ value: 3, at: 3_600 })
    expect(clock.slept).toEqual([1_000, 1_000])
  })

  it('does not sleep when the first reading is already done', async () => {
    const clock = fakeClock()
    const result = await pollUntil({
      read: async () => 'swept',
      done: () => true,
      since: 0,
      intervalMs: 1_000,
      timeoutMs: 120_000,
      ...clock,
    })

    expect(result).toEqual({ value: 'swept', at: 0 })
    expect(clock.slept).toEqual([])
  })

  // The deadline counts from the payout, not from the first read: time spent before the
  // poll began is part of what the operator waits.
  it('gives up once the deadline from `since` has passed, answering null', async () => {
    const clock = fakeClock(10_000)
    let reads = 0
    const result = await pollUntil({
      read: async () => {
        reads += 1
        return 5
      },
      done: (value) => value < 5,
      since: 5_000,
      intervalMs: 1_000,
      timeoutMs: 8_000,
      ...clock,
    })

    expect(result).toBeNull()
    expect(reads).toBe(4)
  })

  // A reading that came back done after the deadline still counts as late, so the
  // caller's budget check sees it rather than a result that only looks in time.
  it('answers a done reading that arrives past the deadline with its real time', async () => {
    const clock = fakeClock()
    const result = await pollUntil({
      read: async () => {
        clock.advance(3_000)
        return 'swept'
      },
      done: () => true,
      since: 0,
      intervalMs: 1_000,
      timeoutMs: 2_000,
      ...clock,
    })

    expect(result).toEqual({ value: 'swept', at: 3_000 })
  })

  it('lets a failed read fail the poll instead of reading it as not done', async () => {
    const clock = fakeClock()
    await expect(
      pollUntil({
        read: async () => {
          throw new Error('429 Too Many Requests')
        },
        done: () => true,
        since: 0,
        intervalMs: 1_000,
        timeoutMs: 120_000,
        ...clock,
      }),
    ).rejects.toThrow(/429/)
  })
})
