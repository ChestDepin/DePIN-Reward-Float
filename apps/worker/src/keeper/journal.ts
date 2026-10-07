import { rewardFloatProgramId, type SweepEvent, sweepEvents } from '@drf/anchor-client'
import { type Database, sweepEvents as sweepEventsTable, sweepJournalCursors } from '@drf/db'
import { solanaAddressSchema } from '@drf/shared/schemas'
import { Connection, type PublicKey } from '@solana/web3.js'
import { eq } from 'drizzle-orm'
import type { Logger } from 'pino'
import { z } from 'zod'
import { POLL_INTERVAL_MS, runKeeper } from './sweep.ts'

// getSignaturesForAddress answers at most this many per call.
const PAGE_SIZE = 1_000
const BATCH_SIZE = 100

export type JournalChain = {
  signatures(options: {
    before: string | undefined
    until: string | undefined
    limit: number
  }): Promise<unknown>
  transaction(signature: string): Promise<unknown>
}

export type JournalRow = typeof sweepEventsTable.$inferInsert

export type JournalBatch = {
  events: JournalRow[]
  cursor: { signature: string; slot: bigint }
}

export type JournalStore = {
  cursor(): Promise<string | null>
  record(batch: JournalBatch): Promise<void>
}

export type JournalDeps = {
  chain: JournalChain
  store: JournalStore
  logger: Logger
  pageSize?: number
  batchSize?: number
}

// `err` is null on success; optional, because Zod 4 fails an object on an absent key even
// for z.unknown().
const signaturesSchema = z.array(
  z.object({
    signature: z.string(),
    slot: z.number().int().nonnegative(),
    err: z.unknown().optional(),
  }),
)

const transactionSchema = z
  .object({
    slot: z.number().int().nonnegative(),
    blockTime: z.number().int(),
    meta: z.object({ err: z.unknown().optional(), logMessages: z.array(z.string()) }),
  })
  .nullable()

type Listed = z.infer<typeof signaturesSchema>[number]

const failed = (err: unknown) => err !== null && err !== undefined

const REASONS = {
  revoked: 'revoked',
  allowanceShort: 'allowance-short',
  withdrawnEarly: 'withdrawn-early',
} as const satisfies Record<
  Extract<SweepEvent, { kind: 'manual' }>['reason'],
  NonNullable<JournalRow['reason']>
>

function fieldsOf(event: SweepEvent) {
  const address = (key: PublicKey) => solanaAddressSchema.parse(key.toBase58())
  const common = { operator: address(event.operator), rewardMint: address(event.rewardMint) }
  switch (event.kind) {
    case 'swept':
      return {
        ...common,
        kind: event.kind,
        loan: address(event.loan),
        withheld: event.withheld,
        paid: event.paid,
        stablePerTrillionReward: event.stablePerTrillionReward,
        deviationBps: event.deviationBps,
        maxSlippageBps: null,
        remainingDebt: event.remainingDebt,
        reason: null,
        rewardDue: null,
      }
    case 'skipped':
      return {
        ...common,
        kind: event.kind,
        loan: null,
        withheld: event.withheld,
        paid: null,
        stablePerTrillionReward: event.stablePerTrillionReward,
        deviationBps: event.deviationBps,
        maxSlippageBps: event.maxSlippageBps,
        remainingDebt: null,
        reason: null,
        rewardDue: null,
      }
    case 'manual':
      return {
        ...common,
        kind: event.kind,
        loan: address(event.loan),
        withheld: null,
        paid: null,
        stablePerTrillionReward: null,
        deviationBps: null,
        maxSlippageBps: null,
        remainingDebt: null,
        reason: REASONS[event.reason],
        rewardDue: event.rewardDue,
      }
  }
}

function rowsOf(signature: string, slot: number, blockTime: number, logs: string[]): JournalRow[] {
  return sweepEvents(logs).map((event, eventIndex) => ({
    signature,
    eventIndex,
    ...fieldsOf(event),
    slot: BigInt(slot),
    blockTime: new Date(blockTime * 1000),
  }))
}

// The journal of FR-016 and FR-017: Swept, SweepSkipped and ManualRepaymentNeeded as the
// program emitted them, whoever sent the sweep. It walks the program's own signatures, the
// one address every sweep names.
export function createSweepJournal(deps: JournalDeps): { tick(): Promise<number> } {
  const { chain, store } = deps
  const pageSize = deps.pageSize ?? PAGE_SIZE
  const batchSize = deps.batchSize ?? BATCH_SIZE

  async function landedSince(until: string | undefined): Promise<Listed[]> {
    const newestFirst: Listed[] = []
    let before: string | undefined
    for (;;) {
      const page = signaturesSchema.parse(
        await chain.signatures({ before, until, limit: pageSize }),
      )
      newestFirst.push(...page)
      const last = page.at(-1)
      if (page.length < pageSize || last === undefined) return newestFirst.reverse()
      before = last.signature
    }
  }

  async function eventsOf(listed: Listed): Promise<JournalRow[]> {
    if (failed(listed.err)) return []
    const landed = transactionSchema.parse(await chain.transaction(listed.signature))
    if (landed === null) throw new Error(`the node returned no transaction for ${listed.signature}`)
    if (failed(landed.meta.err)) return []
    return rowsOf(listed.signature, landed.slot, landed.blockTime, landed.meta.logMessages)
  }

  return {
    async tick() {
      const landed = await landedSince((await store.cursor()) ?? undefined)
      let recorded = 0
      for (let start = 0; start < landed.length; start += batchSize) {
        const batch = landed.slice(start, start + batchSize)
        const last = batch.at(-1)
        if (last === undefined) break
        const events: JournalRow[] = []
        for (const listed of batch) events.push(...(await eventsOf(listed)))
        await store.record({
          events,
          cursor: { signature: last.signature, slot: BigInt(last.slot) },
        })
        recorded += events.length
      }
      if (recorded > 0) deps.logger.info({ recorded }, 'sweep events recorded')
      return recorded
    },
  }
}

export function createDbJournalStore(db: Database, program = rewardFloatProgramId): JournalStore {
  const key = solanaAddressSchema.parse(program.toBase58())
  return {
    async cursor() {
      const [row] = await db
        .select({ lastSignature: sweepJournalCursors.lastSignature })
        .from(sweepJournalCursors)
        .where(eq(sweepJournalCursors.program, key))
      return row?.lastSignature ?? null
    },
    async record({ events, cursor }) {
      await db.transaction(async (tx) => {
        if (events.length > 0) {
          await tx.insert(sweepEventsTable).values(events).onConflictDoNothing()
        }
        await tx
          .insert(sweepJournalCursors)
          .values({ program: key, lastSignature: cursor.signature, lastSlot: cursor.slot })
          .onConflictDoUpdate({
            target: sweepJournalCursors.program,
            set: { lastSignature: cursor.signature, lastSlot: cursor.slot, updatedAt: new Date() },
          })
      })
    },
  }
}

// Finalized, not confirmed: a journal row is not taken back, and a confirmed block can be.
export function startSweepJournal(config: { rpcUrl: string; db: Database; logger: Logger }): {
  stop(): void
} {
  const connection = new Connection(config.rpcUrl, 'finalized')
  const journal = createSweepJournal({
    chain: {
      signatures: ({ before, until, limit }) =>
        connection.getSignaturesForAddress(
          rewardFloatProgramId,
          {
            limit,
            ...(before === undefined ? {} : { before }),
            ...(until === undefined ? {} : { until }),
          },
          'finalized',
        ),
      transaction: (signature) =>
        connection.getTransaction(signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        }),
    },
    store: createDbJournalStore(config.db),
    logger: config.logger,
  })
  config.logger.info({ intervalMs: POLL_INTERVAL_MS }, 'sweep journal started')
  return runKeeper(journal, { intervalMs: POLL_INTERVAL_MS, logger: config.logger })
}
