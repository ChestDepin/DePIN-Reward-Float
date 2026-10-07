import { creditProfiles, type Database, payouts as payoutsTable, pricePoints } from '@drf/db'
import type { RewardNetwork, SolanaAddress } from '@drf/shared/schemas'
import { eq, inArray, like } from 'drizzle-orm'

// The demo needs a limit, and a limit needs a year of mainnet payouts to a wallet whose
// key the test holds; no such wallet exists. These rows stand in for that history and
// only for it: they go into the live database, so every one carries a mark to be found
// and removed by, and the rest of the run is the deployment as it is.
export const DEMO_PAYOUT_PREFIX = 'demo-fixture-'
export const DEMO_PRICE_SOURCE = 'demo-fixture'

type PayoutRow = typeof payoutsTable.$inferInsert
type PriceRow = typeof pricePoints.$inferInsert

const DAY_MS = 86_400_000
const HISTORY_MONTHS = 12
const WEEKLY_PAYOUT = 2_000n
const PRICE_USD = '0.0025'
const TRILLION = 1_000_000_000_000n
const BASIS_POINTS = 10_000n

const ceilDiv = (numerator: bigint, denominator: bigint) =>
  (numerator + denominator - 1n) / denominator

export function demoHistory(input: { wallet: SolanaAddress; network: RewardNetwork; now: Date }): {
  payouts: PayoutRow[]
  prices: PriceRow[]
} {
  const { wallet, network, now } = input
  const [source] = network.payoutSources
  if (source === undefined) throw new Error(`${network.id} has no payout source`)

  const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (HISTORY_MONTHS - 1), 1)
  const unit = 10n ** BigInt(network.token.decimals)

  const payouts: PayoutRow[] = []
  // Counted back from an hour ago, so the current month is paid too and nothing lands
  // after the moment the api computes the limit.
  for (let at = now.getTime() - 3_600_000, week = 0; at >= first; at -= 7 * DAY_MS, week += 1) {
    payouts.push({
      signature: `${DEMO_PAYOUT_PREFIX}${wallet}-${week}`,
      wallet,
      networkId: network.id,
      source: source.address,
      amount: WEEKLY_PAYOUT * unit,
      slot: BigInt(week),
      blockTime: new Date(at),
      valueUsd: null,
    })
  }

  const prices: PriceRow[] = []
  for (let at = first; at <= now.getTime(); at += DAY_MS) {
    prices.push({
      mint: network.token.mint,
      day: new Date(at).toISOString().slice(0, 10),
      priceUsd: PRICE_USD,
      source: DEMO_PRICE_SOURCE,
    })
  }

  return { payouts, prices }
}

// A rate moves between the borrow and the keeper's sweep, and interest runs meanwhile:
// twice the debt is what lets one payout close the loan whatever the drift.
export function payoutToRepay(input: {
  debt: bigint
  stablePerTrillionReward: bigint
  sweepBps: number
}): bigint {
  const { debt, stablePerTrillionReward, sweepBps } = input
  if (stablePerTrillionReward <= 0n) throw new Error('a rate of zero repays nothing')
  if (sweepBps <= 0) throw new Error('a share of zero withholds nothing')

  const withheld = ceilDiv(2n * debt * TRILLION, stablePerTrillionReward)

  return ceilDiv(withheld * BASIS_POINTS, BigInt(sweepBps))
}

const CHUNK = 200

// Also whatever an earlier run left behind when it died before its own cleanup.
export async function wipeDemoHistory(db: Database): Promise<void> {
  const marked = like(payoutsTable.signature, `${DEMO_PAYOUT_PREFIX}%`)
  await db
    .delete(creditProfiles)
    .where(
      inArray(
        creditProfiles.wallet,
        db.selectDistinct({ wallet: payoutsTable.wallet }).from(payoutsTable).where(marked),
      ),
    )
  await db.delete(payoutsTable).where(marked)
  await db.delete(pricePoints).where(eq(pricePoints.source, DEMO_PRICE_SOURCE))
}

export async function seedDemoHistory(
  db: Database,
  history: { payouts: readonly PayoutRow[]; prices: readonly PriceRow[] },
): Promise<void> {
  for (let start = 0; start < history.payouts.length; start += CHUNK) {
    await db.insert(payoutsTable).values(history.payouts.slice(start, start + CHUNK))
  }
  // A day the worker has already priced keeps its real quote.
  for (let start = 0; start < history.prices.length; start += CHUNK) {
    await db
      .insert(pricePoints)
      .values(history.prices.slice(start, start + CHUNK))
      .onConflictDoNothing()
  }
}
