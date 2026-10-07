import { rewardNetworkSchema, solanaAddressSchema } from '@drf/shared/schemas'
import {
  aggregateMonthlyPayouts,
  assessEligibility,
  calendarDaySchema,
  computeCreditLimit,
  type MonthRange,
  type PriceSeries,
  priceUsdSchema,
  toCalendarMonth,
} from '@drf/shared/scoring'
import { describe, expect, it } from 'vitest'
import {
  DEMO_PAYOUT_PREFIX,
  DEMO_PRICE_SOURCE,
  demoHistory,
  payoutToRepay,
} from './demo-fixture.ts'

const WALLET = solanaAddressSchema.parse('4q79Ukx3tWbZ6ZCgdHnc5mxpU7v3KT2wGfGzCMUWTCvG')
const HIVEMAPPER = rewardNetworkSchema.parse({
  id: 'hivemapper',
  displayName: 'Hivemapper',
  token: { mint: '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy', symbol: 'HONEY', decimals: 9 },
  payoutSources: [{ kind: 'mint', address: 'G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7' }],
  payoutCadence: 'weekly',
})

// The api's own period: twelve calendar months ending with the current one.
function periodAt(now: Date): MonthRange {
  return {
    from: toCalendarMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))),
    to: toCalendarMonth(now),
  }
}

// The same steps as the limit route, over rows instead of the tables they go into.
function limitOf(now: Date) {
  const { payouts, prices } = demoHistory({ wallet: WALLET, network: HIVEMAPPER, now })
  const series: PriceSeries = new Map(
    prices.map((row) => [calendarDaySchema.parse(row.day), priceUsdSchema.parse(row.priceUsd)]),
  )
  const months = aggregateMonthlyPayouts({
    payouts: payouts.map((row) => ({ ...row, wallet: WALLET })),
    network: HIVEMAPPER,
    prices: series,
    period: periodAt(now),
  })
  return {
    eligibility: assessEligibility({ months, cadence: HIVEMAPPER.payoutCadence }),
    outcome: computeCreditLimit({ months, prices: series, decimals: HIVEMAPPER.token.decimals }),
  }
}

describe('demoHistory', () => {
  it('gives the wallet a limit of more than a dollar', () => {
    const { eligibility, outcome } = limitOf(new Date('2026-10-17T12:00:00.000Z'))

    expect(eligibility.kind).toBe('eligible')
    expect(outcome.kind).toBe('limit')
    if (outcome.kind === 'limit') expect(outcome.limitUsd).toBeGreaterThan(1_000_000n)
  })

  // The recent price window ends on the last day of the month, so a history that stops
  // today has only a day or two of it early in a month.
  it('still has a limit on the second day of a month', () => {
    const { outcome } = limitOf(new Date('2026-11-02T00:30:00.000Z'))

    expect(outcome.kind).toBe('limit')
  })

  it('stays in the past and in the period the api reads', () => {
    const now = new Date('2026-10-07T09:00:00.000Z')
    const { payouts, prices } = demoHistory({ wallet: WALLET, network: HIVEMAPPER, now })
    const firstDay = `${periodAt(now).from}-01`

    expect(payouts.length).toBeGreaterThan(0)
    expect(prices.length).toBeGreaterThan(0)
    for (const payout of payouts) {
      expect(payout.blockTime.getTime()).toBeLessThan(now.getTime())
      expect(payout.blockTime.toISOString().slice(0, 10) >= firstDay).toBe(true)
    }
    for (const price of prices) expect(price.day <= '2026-10-07').toBe(true)
  })

  // The rows go into the live database next to real ones, so cleaning up must find every
  // one of them by its mark and nothing else.
  it('marks every row it writes', () => {
    const { payouts, prices } = demoHistory({
      wallet: WALLET,
      network: HIVEMAPPER,
      now: new Date('2026-10-07T09:00:00.000Z'),
    })

    expect(payouts.length).toBeGreaterThan(0)
    for (const payout of payouts) {
      expect(payout.signature.startsWith(DEMO_PAYOUT_PREFIX)).toBe(true)
      expect(payout.wallet).toBe(WALLET)
      expect(payout.networkId).toBe(HIVEMAPPER.id)
      expect(payout.source).toBe('G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7')
    }
    expect(new Set(payouts.map((payout) => payout.signature)).size).toBe(payouts.length)
    for (const price of prices) {
      expect(price.source).toBe(DEMO_PRICE_SOURCE)
      expect(price.mint).toBe(HIVEMAPPER.token.mint)
    }
  })
})

describe('payoutToRepay', () => {
  // 2 406 662 stablecoin units per 10^12 HONEY units: about $0.0024 a HONEY.
  const RATE = 2_406_662n

  it('withholds, at its share and the rate, twice the debt', () => {
    const debt = 1_000_123n
    const payout = payoutToRepay({ debt, stablePerTrillionReward: RATE, sweepBps: 5_000 })
    const withheldWorth = (((payout * 5_000n) / 10_000n) * RATE) / 1_000_000_000_000n

    expect(withheldWorth).toBeGreaterThanOrEqual(2n * debt)
    expect(withheldWorth).toBeLessThan(2n * debt + 10n)
  })

  it('rounds up, so the smallest debt still gets a payout that covers it', () => {
    const payout = payoutToRepay({ debt: 1n, stablePerTrillionReward: RATE, sweepBps: 10_000 })

    expect((payout * RATE) / 1_000_000_000_000n).toBeGreaterThanOrEqual(2n)
  })

  it('refuses a rate or a share that could never repay anything', () => {
    expect(() => payoutToRepay({ debt: 1n, stablePerTrillionReward: 0n, sweepBps: 5_000 })).toThrow(
      /rate/,
    )
    expect(() => payoutToRepay({ debt: 1n, stablePerTrillionReward: RATE, sweepBps: 0 })).toThrow(
      /share/,
    )
  })
})
