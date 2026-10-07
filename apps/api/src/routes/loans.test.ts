import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createDatabase, type Database, sweepEvents } from '@drf/db'
import { withholdingsSchema } from '@drf/shared/api'
import { type SolanaAddress, solanaAddressSchema } from '@drf/shared/schemas'
import { like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DataUnavailable } from './errors.ts'
import {
  buildWithholdings,
  createDbWithholdingSource,
  createLoanRoutes,
  type StoredSweepEvent,
  type WithholdingSource,
} from './loans.ts'

const OPERATOR = solanaAddressSchema.parse('7n1QAhcPgHbhFUj5fUh6AUThGsjqMw9FFuHpvBcgNjDE')
const OTHER = solanaAddressSchema.parse('5WdZCZ6RfaHGLrfhB64uhNAsoEVkgEMC2Nu6X5ExpaA8')
const HONEY = solanaAddressSchema.parse('2RZMt9LwzUzSUNfprdLSUF33gS2Y3EJL3jqN6g6a9oP1')
const HNT = solanaAddressSchema.parse('3mqvZ478SVFftqm6Pmh14SdUhUHuaG7KkKqaBDqNZADs')
const LOAN = solanaAddressSchema.parse('CTpuM8TMCd1nufP4xPRoocUEVf7ZY8Y94rGw8UfCHCAp')
const H = 1_000_000_000n

const at = (minute: number) => new Date(Date.UTC(2026, 9, 7, 12, minute))

const swept = (signature: string, slot: number, mint: SolanaAddress = HONEY): StoredSweepEvent => ({
  signature,
  eventIndex: 0,
  kind: 'swept',
  rewardMint: mint,
  loan: LOAN,
  withheld: 150n * H,
  paid: 396_662n,
  stablePerTrillionReward: 2_406_662n,
  deviationBps: 31,
  maxSlippageBps: null,
  remainingDebt: 603_338n,
  reason: null,
  rewardDue: null,
  slot: BigInt(slot),
  blockTime: at(slot),
})

const skipped = (
  signature: string,
  slot: number,
  deviationBps: number,
  mint: SolanaAddress = HONEY,
): StoredSweepEvent => ({
  signature,
  eventIndex: 0,
  kind: 'skipped',
  rewardMint: mint,
  loan: null,
  withheld: 300n * H,
  stablePerTrillionReward: BigInt(2_400_000 + slot),
  deviationBps,
  maxSlippageBps: 100,
  paid: null,
  remainingDebt: null,
  reason: null,
  rewardDue: null,
  slot: BigInt(slot),
  blockTime: at(slot),
})

const flagged = (signature: string, slot: number, eventIndex = 0): StoredSweepEvent => ({
  signature,
  eventIndex,
  kind: 'manual',
  rewardMint: HONEY,
  loan: LOAN,
  withheld: null,
  paid: null,
  stablePerTrillionReward: null,
  deviationBps: null,
  maxSlippageBps: null,
  remainingDebt: null,
  reason: 'allowance-short',
  rewardDue: 250n * H,
  slot: BigInt(slot),
  blockTime: at(slot),
})

describe('buildWithholdings', () => {
  it('turns each withholding into an entry, amounts as strings, newest first', () => {
    const built = buildWithholdings({
      operator: OPERATOR,
      rows: [swept('b', 9), swept('a', 3)],
      limit: 10,
    })

    expect(withholdingsSchema.parse(built)).toEqual(built)
    expect(built).toEqual({
      operator: OPERATOR,
      complete: true,
      entries: [
        {
          kind: 'withheld',
          signature: 'b',
          blockTime: at(9).toISOString(),
          loan: LOAN,
          rewardMint: HONEY,
          withheld: '150000000000',
          paid: '396662',
          stablePerTrillionReward: '2406662',
          deviationBps: 31,
          remainingDebt: '603338',
        },
        expect.objectContaining({ kind: 'withheld', signature: 'a' }),
      ],
    })
  })

  it('folds skips in a row on one mint into one entry: latest rate, worst deviation, the span', () => {
    const built = buildWithholdings({
      operator: OPERATOR,
      rows: [skipped('c', 9, 120), skipped('b', 7, 180), skipped('a', 5, 140)],
      limit: 10,
    })

    expect(built.entries).toEqual([
      {
        kind: 'skipped',
        signature: 'c',
        rewardMint: HONEY,
        attempts: 3,
        firstAt: at(5).toISOString(),
        lastAt: at(9).toISOString(),
        attempted: '300000000000',
        stablePerTrillionReward: '2400009',
        deviationBps: 120,
        worstDeviationBps: 180,
        maxSlippageBps: 100,
      },
    ])
  })

  it('starts a new run of skips after a withholding on the same mint', () => {
    const built = buildWithholdings({
      operator: OPERATOR,
      rows: [skipped('d', 9, 120), swept('c', 7), skipped('b', 5, 140), skipped('a', 3, 150)],
      limit: 10,
    })

    expect(built.entries.map((entry) => [entry.kind, entry.signature])).toEqual([
      ['skipped', 'd'],
      ['withheld', 'c'],
      ['skipped', 'b'],
    ])
    expect(built.entries[2]).toMatchObject({ attempts: 2, firstAt: at(3).toISOString() })
  })

  // Each mint has its own allowance and its own market: a HONEY withholding says nothing
  // about why HNT is still skipped.
  it('keeps a run of skips going across a withholding on another mint', () => {
    const built = buildWithholdings({
      operator: OPERATOR,
      rows: [skipped('c', 9, 120), swept('b', 7, HNT), skipped('a', 5, 140)],
      limit: 10,
    })

    expect(built.entries.map((entry) => [entry.kind, entry.signature])).toEqual([
      ['skipped', 'c'],
      ['withheld', 'b'],
    ])
    expect(built.entries[0]).toMatchObject({ attempts: 2, worstDeviationBps: 140 })
  })

  it('turns a loan flagged for a manual repayment into an entry with its reason', () => {
    const built = buildWithholdings({
      operator: OPERATOR,
      rows: [swept('a', 3), flagged('a', 3, 1)],
      limit: 10,
    })

    expect(withholdingsSchema.parse(built)).toEqual(built)
    expect(built.entries).toEqual([
      expect.objectContaining({ kind: 'withheld', signature: 'a' }),
      {
        kind: 'manual-repayment',
        signature: 'a',
        blockTime: at(3).toISOString(),
        loan: LOAN,
        rewardMint: HONEY,
        reason: 'allowance-short',
        rewardDue: '250000000000',
      },
    ])
  })

  // A flag withholds nothing, so the skips on either side of it are still one run.
  it('keeps a run of skips going across a flag on the same mint', () => {
    const built = buildWithholdings({
      operator: OPERATOR,
      rows: [skipped('c', 9, 120), flagged('b', 7), skipped('a', 5, 140)],
      limit: 10,
    })

    expect(built.entries.map((entry) => [entry.kind, entry.signature])).toEqual([
      ['skipped', 'c'],
      ['manual-repayment', 'b'],
    ])
    expect(built.entries[0]).toMatchObject({ attempts: 2 })
  })

  it('says the journal is cut short when as many rows came back as were asked for', () => {
    expect(
      buildWithholdings({ operator: OPERATOR, rows: [swept('b', 9), swept('a', 3)], limit: 2 })
        .complete,
    ).toBe(false)
    expect(buildWithholdings({ operator: OPERATOR, rows: [], limit: 2 })).toEqual({
      operator: OPERATOR,
      entries: [],
      complete: true,
    })
  })

  // The check constraint makes it impossible in the table; reaching here is our defect.
  it('refuses a withholding row without its loan', () => {
    expect(() =>
      buildWithholdings({
        operator: OPERATOR,
        rows: [{ ...swept('orphan', 1), loan: null }],
        limit: 10,
      }),
    ).toThrow('orphan')
  })

  it('refuses a flag row without its reason', () => {
    expect(() =>
      buildWithholdings({
        operator: OPERATOR,
        rows: [{ ...flagged('unexplained', 1), reason: null }],
        limit: 10,
      }),
    ).toThrow(/unexplained.* reason/)
  })
})

function routes(read: WithholdingSource['read']) {
  const asked: { operator: string; limit: number }[] = []
  const app = createLoanRoutes({
    withholdings: {
      read: async (operator, limit) => {
        asked.push({ operator, limit })
        return read(operator, limit)
      },
    },
  })
  return { app, asked }
}

describe('GET /operators/:address/withholdings', () => {
  it('answers with the journal of that operator', async () => {
    const { app, asked } = routes(async () => [swept('a', 3)])

    const response = await app.request(`/operators/${OPERATOR}/withholdings`)

    expect(response.status).toBe(200)
    const body = withholdingsSchema.parse(await response.json())
    expect(body.entries.map((entry) => entry.signature)).toEqual(['a'])
    expect(asked).toEqual([{ operator: OPERATOR, limit: 1_000 }])
  })

  it('rejects an address that is not a wallet', async () => {
    const { app, asked } = routes(async () => [])

    const response = await app.request('/operators/not-an-address/withholdings')

    expect(response.status).toBe(400)
    expect(asked).toEqual([])
  })

  it('answers an unreadable journal with 503, not with an empty one', async () => {
    const { app } = routes(async () => {
      throw new DataUnavailable('the sweep journal', { cause: new Error('ECONNRESET') })
    })

    const response = await app.request(`/operators/${OPERATOR}/withholdings`)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'DATA_UNAVAILABLE', message: 'the withholdings could not be read' },
    })
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

describe.skipIf(url === undefined)('createDbWithholdingSource against a live postgres', () => {
  const PREFIX = 'test-withholdings-'
  let db: Database
  let close: () => Promise<void>

  const stored = (event: StoredSweepEvent, operator: SolanaAddress = OPERATOR) => ({
    ...event,
    signature: `${PREFIX}${event.signature}`,
    operator,
  })

  const wipe = () => db.delete(sweepEvents).where(like(sweepEvents.signature, `${PREFIX}%`))

  beforeAll(async () => {
    const handle = createDatabase(url ?? '')
    db = handle.db
    close = handle.close
    await wipe()
    await db
      .insert(sweepEvents)
      .values([
        stored(swept('a', 3)),
        stored({ ...swept('b', 7), eventIndex: 1 }),
        stored({ ...swept('b', 7), eventIndex: 0 }),
        stored(skipped('c', 9, 140)),
        stored(swept('d', 8), OTHER),
        stored(flagged('e', 1)),
      ])
  })

  afterAll(async () => {
    await wipe()
    await close()
  })

  it('reads one operator, newest slot first, the events of one sweep in the order emitted', async () => {
    const rows = await createDbWithholdingSource(db).read(OPERATOR, 10)

    expect(rows.map((row) => [row.signature.slice(PREFIX.length), row.eventIndex])).toEqual([
      ['c', 0],
      ['b', 0],
      ['b', 1],
      ['a', 0],
      ['e', 0],
    ])
    expect(rows[0]).toMatchObject({ kind: 'skipped', maxSlippageBps: 100, loan: null })
    expect(rows[1]).toMatchObject({ withheld: 150n * H, remainingDebt: 603_338n, loan: LOAN })
  })

  it('reads a flag back with its reason and what the loan is owed', async () => {
    const rows = await createDbWithholdingSource(db).read(OPERATOR, 10)

    expect(rows.at(-1)).toMatchObject({
      kind: 'manual',
      loan: LOAN,
      reason: 'allowance-short',
      rewardDue: 250n * H,
      withheld: null,
      stablePerTrillionReward: null,
      deviationBps: null,
    })
  })

  it('reads no more than it is asked for', async () => {
    expect(await createDbWithholdingSource(db).read(OPERATOR, 2)).toHaveLength(2)
  })
})
