import {
  type Database,
  networks as networksTable,
  payouts as payoutsTable,
  pricePoints,
} from '@drf/db'
import type { NetworkPayoutHistory, PayoutHistory } from '@drf/shared/api'
import { type RewardNetwork, rewardNetworkSchema, type SolanaAddress } from '@drf/shared/schemas'
import {
  aggregateMonthlyPayouts,
  type CalendarDay,
  calendarDaySchema,
  type MonthRange,
  monthRangeSchema,
  payoutValueUsd,
  type PriceSeries,
  type PriceUsd,
  priceUsdSchema,
  type RecognisedPayout,
  toCalendarDay,
  toCalendarMonth,
} from '@drf/shared/scoring'
import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm'
import { Hono } from 'hono'
import { reading, walletParam } from './errors.ts'

const HISTORY_MONTHS = 12

export type StoredHistory = {
  payouts: readonly RecognisedPayout[]
  networks: readonly RewardNetwork[]
  prices: ReadonlyMap<SolanaAddress, PriceSeries>
}

export type PayoutHistorySource = {
  read(wallet: SolanaAddress, period: MonthRange): Promise<StoredHistory>
}

const monthStart = (month: string, offset = 0) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + offset, 1))

export function historyPeriod(now: Date): MonthRange {
  const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (HISTORY_MONTHS - 1), 1)

  return monthRangeSchema.parse({
    from: toCalendarMonth(new Date(first)),
    to: toCalendarMonth(now),
  })
}

export function createDbPayoutHistorySource(db: Database): PayoutHistorySource {
  return {
    async read(wallet, period) {
      const from = monthStart(period.from)
      const until = monthStart(period.to, 1)

      const rows = await reading(
        'the payout history',
        db
          .select({
            signature: payoutsTable.signature,
            networkId: payoutsTable.networkId,
            source: payoutsTable.source,
            amount: payoutsTable.amount,
            slot: payoutsTable.slot,
            blockTime: payoutsTable.blockTime,
          })
          .from(payoutsTable)
          .where(
            and(
              eq(payoutsTable.wallet, wallet),
              gte(payoutsTable.blockTime, from),
              lt(payoutsTable.blockTime, until),
            ),
          )
          .orderBy(desc(payoutsTable.blockTime), asc(payoutsTable.signature)),
      )

      const payouts = rows.map((row) => ({ ...row, wallet }))
      const networkIds = [...new Set(payouts.map((payout) => payout.networkId))]
      if (networkIds.length === 0) return { payouts: [], networks: [], prices: new Map() }

      const networkRows = await reading(
        'the supported networks',
        db.select().from(networksTable).where(inArray(networksTable.id, networkIds)),
      )

      // Мережа приходить із таблиці як дані і перевіряється тією ж схемою, що й
      // конфіг: FR-001a обіцяє, що третя мережа не змінює код, і сід — єдине
      // місце, де ця обіцянка може зламатись мовчки.
      const networks = networkRows.map((row) =>
        rewardNetworkSchema.parse({
          id: row.id,
          displayName: row.displayName,
          token: { mint: row.tokenMint, symbol: row.tokenSymbol, decimals: row.tokenDecimals },
          payoutSources: row.payoutSources,
          payoutCadence: row.payoutCadence,
        }),
      )

      // Котирування читаються з кешу `price_points` і тільки звідти: запит
      // оператора не ходить у зовнішнє джерело цін, його наповнює воркер.
      const quotes = await reading(
        'the cached prices',
        db
          .select({ mint: pricePoints.mint, day: pricePoints.day, priceUsd: pricePoints.priceUsd })
          .from(pricePoints)
          .where(
            and(
              inArray(
                pricePoints.mint,
                networks.map((network) => network.token.mint),
              ),
              gte(pricePoints.day, `${period.from}-01`),
              lt(pricePoints.day, until.toISOString().slice(0, 10)),
            ),
          ),
      )

      const prices = new Map<SolanaAddress, Map<CalendarDay, PriceUsd>>()
      for (const quote of quotes) {
        const series = prices.get(quote.mint) ?? new Map<CalendarDay, PriceUsd>()
        series.set(calendarDaySchema.parse(quote.day), priceUsdSchema.parse(quote.priceUsd))
        prices.set(quote.mint, series)
      }

      return { payouts, networks, prices }
    },
  }
}

export function buildPayoutHistory(input: {
  wallet: SolanaAddress
  period: MonthRange
  stored: StoredHistory
}): PayoutHistory {
  const { wallet, period, stored } = input
  const byId = new Map(stored.networks.map((network) => [network.id, network]))
  const grouped = new Map<string, { network: RewardNetwork; entries: RecognisedPayout[] }>()

  for (const payout of stored.payouts) {
    const network = byId.get(payout.networkId)
    if (network === undefined) {
      throw new Error(`payout ${payout.signature} names ${payout.networkId}, which was not read`)
    }

    const bucket = grouped.get(network.id) ?? { network, entries: [] }
    bucket.entries.push(payout)
    grouped.set(network.id, bucket)
  }

  const networks: NetworkPayoutHistory[] = [...grouped.values()]
    .sort((left, right) => (left.network.id < right.network.id ? -1 : 1))
    .map(({ network, entries }) => {
      const prices = stored.prices.get(network.token.mint) ?? new Map<CalendarDay, PriceUsd>()
      const months = aggregateMonthlyPayouts({ payouts: entries, network, prices, period })

      return {
        networkId: network.id,
        displayName: network.displayName,
        token: { symbol: network.token.symbol, decimals: network.token.decimals },
        months: months.map((month) => ({
          month: month.month,
          payoutCount: month.payoutCount,
          amount: month.amount.toString(),
          valueUsd: month.valueUsd === null ? null : month.valueUsd.toString(),
          daysWithoutPrice: [...month.daysWithoutPrice],
        })),
        payouts: [...entries]
          .sort(
            (left, right) =>
              right.blockTime.getTime() - left.blockTime.getTime() ||
              (left.signature < right.signature ? -1 : 1),
          )
          .map((payout) => {
            const price = prices.get(toCalendarDay(payout.blockTime))

            return {
              signature: payout.signature,
              source: payout.source,
              amount: payout.amount.toString(),
              valueUsd:
                price === undefined
                  ? null
                  : payoutValueUsd(payout.amount, network.token.decimals, price).toString(),
              slot: payout.slot.toString(),
              blockTime: payout.blockTime.toISOString(),
            }
          }),
      }
    })

  return { wallet, period, networks }
}

export type OperatorRoutesDeps = {
  payouts: PayoutHistorySource
  now: () => Date
}

export function createOperatorRoutes({ payouts, now }: OperatorRoutesDeps): Hono {
  const routes = new Hono()

  // FR-024b: історія виплат публічна, і підпису тут не питають. Підпис
  // вимагається лише там, де рухаються кошти або видається дозвіл.
  routes.get('/operators/:address/payouts', walletParam, async (c) => {
    const { address } = c.req.valid('param')
    const period = historyPeriod(now())
    const stored = await payouts.read(address, period)

    return c.json(buildPayoutHistory({ wallet: address, period, stored }))
  })

  return routes
}
