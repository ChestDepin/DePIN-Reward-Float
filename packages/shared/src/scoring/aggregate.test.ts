import { describe, expect, it } from 'vitest'
import { parseRewardNetworks } from '../schemas/network.ts'
import { solanaAddressSchema } from '../schemas/primitives.ts'
import { aggregateMonthlyPayouts, calendarMonthSchema, payoutValueUsd } from './aggregate.ts'
import type { RecognisedPayout } from './classify.ts'
import { calendarDaySchema, type PriceSeries, priceUsdSchema } from './price.ts'

const HONEY_MINT = 'B55r1aQEJhL8xba9ncHHrY7w2tsykbtewac2uYUmgLyP'
const HNT_MINT = 'Da5nJidcBhY7Ae6qCJTkJ3yDeGJkMjhURA5Ny9QEDTne'
const HIVEMAPPER_AUTHORITY = 'G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7'
const HELIUM_DISTRIBUTOR = 'GqzFuskZTGHjVWKFid1J45FfbWYWCikuHnjP1viPrUx'
const OPERATOR = '61G2U72VLHjSsAvTArQwb2Wg7vaVkVoEzPN8sdgxBLde'

const networks = parseRewardNetworks([
  {
    id: 'hivemapper',
    displayName: 'Hivemapper',
    token: { mint: HONEY_MINT, symbol: 'HONEY', decimals: 9 },
    payoutSources: [{ kind: 'mint', address: HIVEMAPPER_AUTHORITY }],
    payoutCadence: 'weekly',
  },
  {
    id: 'helium',
    displayName: 'Helium',
    token: { mint: HNT_MINT, symbol: 'HNT', decimals: 8 },
    payoutSources: [{ kind: 'transfer', address: HELIUM_DISTRIBUTOR }],
    payoutCadence: 'daily',
  },
])

const hivemapper = networks.get('hivemapper')
if (hivemapper === undefined) throw new Error('fixture network is missing')

const wallet = solanaAddressSchema.parse(OPERATOR)
const source = solanaAddressSchema.parse(HIVEMAPPER_AUTHORITY)

let nextSignature = 0

const payout = (at: string, tokens: string, networkId = 'hivemapper'): RecognisedPayout => {
  nextSignature += 1
  return {
    signature: `signature-${nextSignature}`,
    wallet,
    networkId,
    source,
    amount: BigInt(tokens),
    slot: 442_918_004n,
    blockTime: new Date(at),
  }
}

const series = (quotes: Record<string, string>): PriceSeries =>
  new Map(
    Object.entries(quotes).map(([day, price]) => [
      calendarDaySchema.parse(day),
      priceUsdSchema.parse(price),
    ]),
  )

const period = (from: string, to: string) => ({
  from: calendarMonthSchema.parse(from),
  to: calendarMonthSchema.parse(to),
})

const prices = series({
  '2026-01-15': '0.05',
  '2026-01-31': '0.04',
  '2026-03-02': '0.06',
})

describe('payoutValueUsd', () => {
  it('converts token base units at a daily quote into whole micro-dollars', () => {
    expect(payoutValueUsd(4_090_000_000_000n, 9, priceUsdSchema.parse('0.052'))).toBe(212_680_000n)
  })

  it('truncates instead of rounding, so the value is never overstated', () => {
    expect(payoutValueUsd(1n, 9, priceUsdSchema.parse('0.05'))).toBe(0n)
    expect(payoutValueUsd(19_999n, 9, priceUsdSchema.parse('1'))).toBe(19n)
  })

  it('reads the decimals of the token it is given', () => {
    expect(payoutValueUsd(100_000_000n, 8, priceUsdSchema.parse('3.17'))).toBe(3_170_000n)
  })
})

describe('aggregateMonthlyPayouts', () => {
  const aggregate = (payouts: readonly RecognisedPayout[], from = '2026-01', to = '2026-03') =>
    aggregateMonthlyPayouts({
      payouts,
      network: hivemapper,
      prices,
      period: period(from, to),
    })

  it('sums the token amount of every payout of a month', () => {
    const months = aggregate([
      payout('2026-01-15T08:00:00Z', '1000000000'),
      payout('2026-01-31T08:00:00Z', '2000000000'),
    ])

    expect(months.map((month) => month.month)).toEqual(['2026-01', '2026-02', '2026-03'])
    expect(months[0]?.payoutCount).toBe(2)
    expect(months[0]?.amount).toBe(3_000_000_000n)
  })

  it('values each payout at the quote of its own day, not at one quote per month', () => {
    const months = aggregate([
      payout('2026-01-15T08:00:00Z', '1000000000'),
      payout('2026-01-31T08:00:00Z', '1000000000'),
    ])

    expect(months[0]?.valueUsd).toBe(90_000n)
  })

  it('reports a month without payouts as zero, so a gap in the history stays visible', () => {
    const months = aggregate([payout('2026-01-15T08:00:00Z', '1000000000')])

    expect(months[1]).toEqual({
      month: '2026-02',
      payoutCount: 0,
      amount: 0n,
      valueUsd: 0n,
      daysWithoutPrice: [],
    })
  })

  it('leaves the value of a month unknown when a payout day has no quote', () => {
    const months = aggregate([
      payout('2026-01-15T08:00:00Z', '1000000000'),
      payout('2026-01-20T08:00:00Z', '1000000000'),
    ])

    expect(months[0]?.valueUsd).toBeNull()
    expect(months[0]?.daysWithoutPrice).toEqual(['2026-01-20'])
  })

  it('still reports the token amount of a month whose value is unknown', () => {
    const months = aggregate([payout('2026-01-20T08:00:00Z', '1000000000')])

    expect(months[0]?.amount).toBe(1_000_000_000n)
    expect(months[0]?.valueUsd).toBeNull()
  })

  it('names a day without a quote once, however many payouts fell on it', () => {
    const months = aggregate([
      payout('2026-01-20T08:00:00Z', '1000000000'),
      payout('2026-01-20T19:00:00Z', '1000000000'),
    ])

    expect(months[0]?.daysWithoutPrice).toEqual(['2026-01-20'])
  })

  it('keeps a missing quote inside its own month', () => {
    const months = aggregate([
      payout('2026-01-20T08:00:00Z', '1000000000'),
      payout('2026-03-02T08:00:00Z', '1000000000'),
    ])

    expect(months[0]?.valueUsd).toBeNull()
    expect(months[2]?.valueUsd).toBe(60_000n)
  })

  it('puts a payout in the month it fell in UTC, not in the month of the local clock', () => {
    const months = aggregate([payout('2026-01-31T23:30:00Z', '1000000000')])

    expect(months[0]?.payoutCount).toBe(1)
    expect(months[1]?.payoutCount).toBe(0)
  })

  it('rejects a payout of another network, whose token has other decimals', () => {
    expect(() => aggregate([payout('2026-01-15T08:00:00Z', '1000000000', 'helium')])).toThrow(
      /helium/,
    )
  })

  it('rejects a payout outside the period, instead of dropping it silently', () => {
    expect(() => aggregate([payout('2025-12-31T23:30:00Z', '1000000000')])).toThrow(/2025-12/)
  })

  it('rejects a period that ends before it starts', () => {
    expect(() => aggregate([], '2026-03', '2026-01')).toThrow()
  })
})
