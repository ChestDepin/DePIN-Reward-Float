import { readFileSync } from 'node:fs'
import path from 'node:path'
import { rewardFloatProgramId } from '@drf/anchor-client'
import { key, sweepLogs } from '@drf/anchor-client/test-support'
import { createDatabase, type Database, sweepEvents, sweepJournalCursors } from '@drf/db'
import { solanaAddressSchema } from '@drf/shared/schemas'
import { eq, like } from 'drizzle-orm'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createDbJournalStore,
  createSweepJournal,
  type JournalBatch,
  type JournalChain,
  type JournalRow,
} from './journal.ts'

const H = 1_000_000_000n
const alice = key(1)
const honey = key(4)
const firstLoan = key(11)
const secondLoan = key(12)

const silent = pino({ level: 'silent' })

type Landed = {
  signature: string
  slot: number
  blockTime: number
  err?: unknown
  logs: string[]
}

const swept = (loan = firstLoan, withheld = 150n * H, remainingDebt = 603_338n) => ({
  name: 'swept' as const,
  data: {
    loan,
    operator: alice,
    rewardMint: honey,
    withheld,
    paid: 396_662n,
    stablePerTrillionReward: 2_406_662n,
    deviationBps: 31,
    remainingDebt,
  },
})

const skipped = {
  name: 'sweepSkipped' as const,
  data: {
    operator: alice,
    rewardMint: honey,
    withheld: 300n * H,
    stablePerTrillionReward: 2_406_662n,
    deviationBps: 140,
    maxSlippageBps: 100,
  },
}

const flagged = (reason: 'revoked' | 'allowanceShort' | 'withdrawnEarly' = 'allowanceShort') => ({
  name: 'manualRepaymentNeeded' as const,
  data: {
    loan: firstLoan,
    operator: alice,
    rewardMint: honey,
    reason: { [reason]: {} },
    rewardDue: 250n * H,
  },
})

// An RPC node over a fixed history: signatures newest first, `until` exclusive, `before`
// exclusive, at most `limit` per page.
function fakeChain(history: Landed[]) {
  const asked: { before: string | undefined; until: string | undefined }[] = []
  const fetched: string[] = []
  const chain: JournalChain = {
    async signatures({ before, until, limit }) {
      asked.push({ before, until })
      const newestFirst = [...history].reverse()
      const start =
        before === undefined ? 0 : newestFirst.findIndex((l) => l.signature === before) + 1
      const end =
        until === undefined
          ? newestFirst.length
          : newestFirst.findIndex((l) => l.signature === until)
      return newestFirst
        .slice(start, end === -1 ? newestFirst.length : end)
        .slice(0, limit)
        .map((l) => ({
          signature: l.signature,
          slot: l.slot,
          err: l.err ?? null,
          blockTime: l.blockTime,
        }))
    },
    async transaction(signature) {
      fetched.push(signature)
      const landed = history.find((l) => l.signature === signature)
      if (landed === undefined) return null
      return {
        slot: landed.slot,
        blockTime: landed.blockTime,
        meta: { err: landed.err ?? null, logMessages: landed.logs },
      }
    },
  }
  return { chain, asked, fetched }
}

function memoryStore(start: string | null = null) {
  const batches: JournalBatch[] = []
  let cursor = start
  return {
    batches,
    rows: () => batches.flatMap((batch) => batch.events),
    cursor: () => cursor,
    store: {
      async cursor() {
        return cursor
      },
      async record(batch: JournalBatch) {
        batches.push(batch)
        cursor = batch.cursor.signature
      },
    },
  }
}

const landed = (index: number, logs: string[], err?: unknown): Landed => ({
  signature: `sig${index}`,
  slot: 1_000 + index,
  blockTime: 1_791_000_000 + index,
  err,
  logs,
})

const borrowLogs = [
  `Program ${rewardFloatProgramId.toBase58()} invoke [1]`,
  'Program log: Instruction: Borrow',
  `Program ${rewardFloatProgramId.toBase58()} success`,
]

describe('createSweepJournal', () => {
  it('records each Swept of a transaction as its own row, in the order emitted', async () => {
    const { chain } = fakeChain([
      landed(1, sweepLogs([swept(firstLoan), swept(secondLoan, 78n * H, 0n)])),
    ])
    const memory = memoryStore()

    await createSweepJournal({ chain, store: memory.store, logger: silent }).tick()

    expect(memory.rows()).toEqual([
      {
        signature: 'sig1',
        eventIndex: 0,
        kind: 'swept',
        operator: alice.toBase58(),
        rewardMint: honey.toBase58(),
        loan: firstLoan.toBase58(),
        withheld: 150n * H,
        paid: 396_662n,
        stablePerTrillionReward: 2_406_662n,
        deviationBps: 31,
        maxSlippageBps: null,
        remainingDebt: 603_338n,
        reason: null,
        rewardDue: null,
        slot: 1_001n,
        blockTime: new Date(1_791_000_001 * 1000),
      },
      expect.objectContaining({
        eventIndex: 1,
        loan: secondLoan.toBase58(),
        withheld: 78n * H,
        remainingDebt: 0n,
      }),
    ])
    expect(memory.cursor()).toBe('sig1')
  })

  it('records a skip with its tolerance and without a loan, a payment or a debt', async () => {
    const { chain } = fakeChain([landed(1, sweepLogs([skipped]))])
    const memory = memoryStore()

    await createSweepJournal({ chain, store: memory.store, logger: silent }).tick()

    expect(memory.rows()).toEqual([
      expect.objectContaining({
        kind: 'skipped',
        loan: null,
        paid: null,
        remainingDebt: null,
        reason: null,
        rewardDue: null,
        withheld: 300n * H,
        deviationBps: 140,
        maxSlippageBps: 100,
      }),
    ])
  })

  it('records a flagged loan with its reason and what it is owed, after the withholdings', async () => {
    const { chain } = fakeChain([landed(1, sweepLogs([swept(), flagged()]))])
    const memory = memoryStore()

    await createSweepJournal({ chain, store: memory.store, logger: silent }).tick()

    expect(memory.rows()).toEqual([
      expect.objectContaining({ eventIndex: 0, kind: 'swept' }),
      {
        signature: 'sig1',
        eventIndex: 1,
        kind: 'manual',
        operator: alice.toBase58(),
        rewardMint: honey.toBase58(),
        loan: firstLoan.toBase58(),
        withheld: null,
        paid: null,
        stablePerTrillionReward: null,
        deviationBps: null,
        maxSlippageBps: null,
        remainingDebt: null,
        reason: 'allowance-short',
        rewardDue: 250n * H,
        slot: 1_001n,
        blockTime: new Date(1_791_000_001 * 1000),
      },
    ])
  })

  it('writes each reason in the words the api uses', async () => {
    const { chain } = fakeChain([
      landed(1, sweepLogs([flagged('revoked')])),
      landed(2, sweepLogs([flagged('allowanceShort')])),
      landed(3, sweepLogs([flagged('withdrawnEarly')])),
    ])
    const memory = memoryStore()

    await createSweepJournal({ chain, store: memory.store, logger: silent }).tick()

    expect(memory.rows().map((row) => row.reason)).toEqual([
      'revoked',
      'allowance-short',
      'withdrawn-early',
    ])
  })

  // Anchor writes an event into the logs when it is emitted, and the logs of a failed
  // transaction are still returned: a sweep that failed after its emit withheld nothing.
  it('takes nothing from a failed transaction and does not fetch it', async () => {
    const { chain, fetched } = fakeChain([
      landed(1, sweepLogs([swept()]), { InstructionError: [1, { Custom: 6000 }] }),
      landed(2, sweepLogs([skipped])),
    ])
    const memory = memoryStore()

    await createSweepJournal({ chain, store: memory.store, logger: silent }).tick()

    expect(memory.rows().map((row) => row.signature)).toEqual(['sig2'])
    expect(fetched).toEqual(['sig2'])
    expect(memory.cursor()).toBe('sig2')
  })

  it('walks back through every page on the first pass and records oldest first', async () => {
    const history = Array.from({ length: 7 }, (_, index) => landed(index + 1, sweepLogs([swept()])))
    const { chain, asked } = fakeChain(history)
    const memory = memoryStore()

    await createSweepJournal({
      chain,
      store: memory.store,
      logger: silent,
      pageSize: 3,
      batchSize: 2,
    }).tick()

    expect(asked).toEqual([
      { before: undefined, until: undefined },
      { before: 'sig5', until: undefined },
      { before: 'sig2', until: undefined },
    ])
    expect(memory.rows().map((row) => row.signature)).toEqual([
      'sig1',
      'sig2',
      'sig3',
      'sig4',
      'sig5',
      'sig6',
      'sig7',
    ])
    // Each batch moves the cursor, so a pass cut short resumes where it stopped.
    expect(memory.batches.map((batch) => batch.cursor)).toEqual([
      { signature: 'sig2', slot: 1_002n },
      { signature: 'sig4', slot: 1_004n },
      { signature: 'sig6', slot: 1_006n },
      { signature: 'sig7', slot: 1_007n },
    ])
  })

  it('reads only what landed after the cursor', async () => {
    const { chain, asked, fetched } = fakeChain([
      landed(1, sweepLogs([swept()])),
      landed(2, sweepLogs([skipped])),
    ])
    const memory = memoryStore('sig1')

    await createSweepJournal({ chain, store: memory.store, logger: silent }).tick()

    expect(asked).toEqual([{ before: undefined, until: 'sig1' }])
    expect(fetched).toEqual(['sig2'])
    expect(memory.rows().map((row) => row.kind)).toEqual(['skipped'])
  })

  it('moves the cursor past transactions of the program that are not sweeps', async () => {
    const { chain } = fakeChain([landed(1, borrowLogs)])
    const memory = memoryStore()

    await createSweepJournal({ chain, store: memory.store, logger: silent }).tick()

    expect(memory.batches).toEqual([{ events: [], cursor: { signature: 'sig1', slot: 1_001n } }])
  })

  it('writes nothing when nothing landed', async () => {
    const { chain } = fakeChain([landed(1, sweepLogs([swept()]))])
    const memory = memoryStore('sig1')

    await createSweepJournal({ chain, store: memory.store, logger: silent }).tick()

    expect(memory.batches).toEqual([])
  })

  // At finalized a listed signature has a transaction; one that does not answer is the
  // node's gap, and skipping it would lose a withholding for good.
  it('stops before a transaction the node does not return, keeping what came before', async () => {
    const { chain } = fakeChain([landed(1, sweepLogs([swept()])), landed(2, sweepLogs([skipped]))])
    const transaction = chain.transaction
    chain.transaction = async (signature) => (signature === 'sig2' ? null : transaction(signature))
    const memory = memoryStore()

    await expect(
      createSweepJournal({ chain, store: memory.store, logger: silent, batchSize: 1 }).tick(),
    ).rejects.toThrow('sig2')

    expect(memory.cursor()).toBe('sig1')
  })

  it('refuses an RPC answer of the wrong shape', async () => {
    const memory = memoryStore()
    const chain: JournalChain = {
      async signatures() {
        return [{ signature: 'sig1', slot: 'soon' }]
      },
      async transaction() {
        return null
      },
    }

    await expect(
      createSweepJournal({ chain, store: memory.store, logger: silent }).tick(),
    ).rejects.toThrow()
    expect(memory.batches).toEqual([])
  })
})

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL

  try {
    const file = readFileSync(
      path.join(import.meta.dirname, '..', '..', '..', '..', '.env'),
      'utf8',
    )
    return file
      .split(/\r?\n/)
      .find((line) => line.startsWith('DATABASE_URL='))
      ?.slice('DATABASE_URL='.length)
  } catch {
    return undefined
  }
}

const url = databaseUrl()

describe.skipIf(url === undefined)('createDbJournalStore against a live postgres', () => {
  // A program of its own, so the test never moves the cursor of the real journal.
  const program = key(99)
  const PREFIX = 'test-journal-'
  let db: Database
  let close: () => Promise<void>

  const row = (signature: string, eventIndex: number): JournalRow => ({
    signature: `${PREFIX}${signature}`,
    eventIndex,
    kind: 'swept',
    operator: solanaAddressSchema.parse(alice.toBase58()),
    rewardMint: solanaAddressSchema.parse(honey.toBase58()),
    loan: solanaAddressSchema.parse(firstLoan.toBase58()),
    withheld: 150n * H,
    paid: 396_662n,
    stablePerTrillionReward: 2_406_662n,
    deviationBps: 31,
    maxSlippageBps: null,
    remainingDebt: 603_338n,
    slot: 1_001n,
    blockTime: new Date('2026-10-07T00:00:00.000Z'),
  })

  const wipe = async () => {
    await db.delete(sweepEvents).where(like(sweepEvents.signature, `${PREFIX}%`))
    await db
      .delete(sweepJournalCursors)
      .where(eq(sweepJournalCursors.program, solanaAddressSchema.parse(program.toBase58())))
  }

  beforeAll(async () => {
    const handle = createDatabase(url ?? '')
    db = handle.db
    close = handle.close
    await wipe()
  })

  afterAll(async () => {
    await wipe()
    await close()
  })

  it('starts without a cursor, then remembers the last signature recorded', async () => {
    const store = createDbJournalStore(db, program)
    expect(await store.cursor()).toBeNull()

    await store.record({ events: [row('a', 0), row('a', 1)], cursor: { signature: 'a', slot: 1n } })
    await store.record({ events: [], cursor: { signature: 'b', slot: 2n } })

    expect(await store.cursor()).toBe('b')
  })

  it('writes the same events once however often a pass repeats them', async () => {
    const store = createDbJournalStore(db, program)
    const batch = { events: [row('c', 0)], cursor: { signature: 'c', slot: 3n } }

    await store.record(batch)
    await store.record(batch)

    const stored = await db
      .select()
      .from(sweepEvents)
      .where(eq(sweepEvents.signature, `${PREFIX}c`))
    expect(stored).toHaveLength(1)
    expect(stored[0]?.withheld).toBe(150n * H)
  })

  it('takes a flagged loan without a withholding, a rate or a deviation', async () => {
    const store = createDbJournalStore(db, program)
    const flag: JournalRow = {
      ...row('e', 0),
      kind: 'manual',
      withheld: null,
      paid: null,
      stablePerTrillionReward: null,
      deviationBps: null,
      remainingDebt: null,
      reason: 'withdrawn-early',
      rewardDue: 250n * H,
    }

    await store.record({ events: [flag], cursor: { signature: 'e', slot: 5n } })

    const [stored] = await db
      .select()
      .from(sweepEvents)
      .where(eq(sweepEvents.signature, `${PREFIX}e`))
    expect(stored).toMatchObject({ kind: 'manual', reason: 'withdrawn-early', rewardDue: 250n * H })
  })

  it('refuses a flag without its reason, and a withholding that carries one', async () => {
    const store = createDbJournalStore(db, program)
    const flag: JournalRow = {
      ...row('f', 0),
      kind: 'manual',
      withheld: null,
      paid: null,
      stablePerTrillionReward: null,
      deviationBps: null,
      remainingDebt: null,
      reason: null,
      rewardDue: 250n * H,
    }

    await expect(
      store.record({ events: [flag], cursor: { signature: 'f', slot: 6n } }),
    ).rejects.toThrow()
    await expect(
      store.record({
        events: [{ ...row('g', 0), reason: 'revoked' }],
        cursor: { signature: 'g', slot: 7n },
      }),
    ).rejects.toThrow()
  })

  it('refuses a withholding without its loan, and keeps the cursor where it was', async () => {
    const store = createDbJournalStore(db, program)
    const before = await store.cursor()

    await expect(
      store.record({
        events: [{ ...row('d', 0), loan: null }],
        cursor: { signature: 'd', slot: 4n },
      }),
    ).rejects.toThrow()
    expect(await store.cursor()).toBe(before)
  })
})
