import { type Database, sweepEvents } from '@drf/db'
import type { WithholdingEntry, Withholdings } from '@drf/shared/api'
import type { SolanaAddress } from '@drf/shared/schemas'
import { asc, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { DataUnavailable, errorBody, reading, walletParam } from './errors.ts'

// Enough for every withholding a devnet operator has, and a cap on a journal flooded with
// skips: the keeper sends one every two minutes while the market is outside the tolerance.
export const JOURNAL_ROWS = 1_000

export type StoredSweepEvent = {
  signature: string
  eventIndex: number
  kind: 'swept' | 'skipped'
  rewardMint: SolanaAddress
  loan: SolanaAddress | null
  withheld: bigint
  paid: bigint | null
  stablePerTrillionReward: bigint
  deviationBps: number
  maxSlippageBps: number | null
  remainingDebt: bigint | null
  slot: bigint
  blockTime: Date
}

export type WithholdingSource = {
  read(operator: SolanaAddress, limit: number): Promise<StoredSweepEvent[]>
}

type SkippedEntry = Extract<WithholdingEntry, { kind: 'skipped' }>

// Rows come newest first, so the first skip of a run is its latest attempt and each
// further one moves its start back.
export function buildWithholdings(input: {
  operator: SolanaAddress
  rows: readonly StoredSweepEvent[]
  limit: number
}): Withholdings {
  const entries: WithholdingEntry[] = []
  const runs = new Map<SolanaAddress, SkippedEntry>()

  for (const row of input.rows) {
    if (row.kind === 'swept') {
      if (row.loan === null || row.paid === null || row.remainingDebt === null) {
        throw new Error(`withholding ${row.signature}#${row.eventIndex} is missing its loan fields`)
      }
      runs.delete(row.rewardMint)
      entries.push({
        kind: 'withheld',
        signature: row.signature,
        blockTime: row.blockTime.toISOString(),
        loan: row.loan,
        rewardMint: row.rewardMint,
        withheld: row.withheld.toString(),
        paid: row.paid.toString(),
        stablePerTrillionReward: row.stablePerTrillionReward.toString(),
        deviationBps: row.deviationBps,
        remainingDebt: row.remainingDebt.toString(),
      })
      continue
    }

    if (row.maxSlippageBps === null) {
      throw new Error(`skip ${row.signature}#${row.eventIndex} is missing its tolerance`)
    }
    const run = runs.get(row.rewardMint)
    if (run !== undefined) {
      run.attempts += 1
      run.firstAt = row.blockTime.toISOString()
      run.worstDeviationBps = Math.max(run.worstDeviationBps, row.deviationBps)
      continue
    }
    const entry: SkippedEntry = {
      kind: 'skipped',
      signature: row.signature,
      rewardMint: row.rewardMint,
      attempts: 1,
      firstAt: row.blockTime.toISOString(),
      lastAt: row.blockTime.toISOString(),
      attempted: row.withheld.toString(),
      stablePerTrillionReward: row.stablePerTrillionReward.toString(),
      deviationBps: row.deviationBps,
      worstDeviationBps: row.deviationBps,
      maxSlippageBps: row.maxSlippageBps,
    }
    runs.set(row.rewardMint, entry)
    entries.push(entry)
  }

  return { operator: input.operator, entries, complete: input.rows.length < input.limit }
}

export function createDbWithholdingSource(db: Database): WithholdingSource {
  return {
    read: (operator, limit) =>
      reading(
        'the sweep journal',
        db
          .select({
            signature: sweepEvents.signature,
            eventIndex: sweepEvents.eventIndex,
            kind: sweepEvents.kind,
            rewardMint: sweepEvents.rewardMint,
            loan: sweepEvents.loan,
            withheld: sweepEvents.withheld,
            paid: sweepEvents.paid,
            stablePerTrillionReward: sweepEvents.stablePerTrillionReward,
            deviationBps: sweepEvents.deviationBps,
            maxSlippageBps: sweepEvents.maxSlippageBps,
            remainingDebt: sweepEvents.remainingDebt,
            slot: sweepEvents.slot,
            blockTime: sweepEvents.blockTime,
          })
          .from(sweepEvents)
          .where(eq(sweepEvents.operator, operator))
          .orderBy(desc(sweepEvents.slot), asc(sweepEvents.signature), asc(sweepEvents.eventIndex))
          .limit(limit),
      ),
  }
}

export function createLoanRoutes({ withholdings }: { withholdings: WithholdingSource }): Hono {
  const routes = new Hono()

  // FR-016: public, like the payouts the withholdings are taken from.
  routes.get('/operators/:address/withholdings', walletParam, async (c) => {
    const { address } = c.req.valid('param')
    try {
      const rows = await withholdings.read(address, JOURNAL_ROWS)
      return c.json(buildWithholdings({ operator: address, rows, limit: JOURNAL_ROWS }))
    } catch (error) {
      if (!(error instanceof DataUnavailable)) throw error
      return c.json(errorBody('DATA_UNAVAILABLE', 'the withholdings could not be read'), 503)
    }
  })

  return routes
}
