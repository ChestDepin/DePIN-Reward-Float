import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createDatabase, type Database, indexerCursors, networks, payouts } from '@drf/db'
import { solanaAddressSchema } from '@drf/shared/schemas'
import type { RecognisedPayout } from '@drf/shared/scoring'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readCursors, recordPass } from './cursor.ts'

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

const HONEY_MINT = 'B55r1aQEJhL8xba9ncHHrY7w2tsykbtewac2uYUmgLyP'
const DISTRIBUTOR = 'G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7'
const WALLET = solanaAddressSchema.parse('61G2U72VLHjSsAvTArQwb2Wg7vaVkVoEzPN8sdgxBLde')
const MINT = solanaAddressSchema.parse(HONEY_MINT)
const SENDER = solanaAddressSchema.parse(DISTRIBUTOR)

const HONEY_ACCOUNT = solanaAddressSchema.parse('FxeY8wpN4MSo44Fap18JefRHm2EfLVsCUVenwk2zB8ef')
const HNT_ACCOUNT = solanaAddressSchema.parse('BDs6RPnpJNzmuMNv1z8cDh9cxKFgCxEVDaCfoHZWyvqJ')

const FIRST =
  'mHhyPe2Am14FUfW89ak1Hut2cALVwKTtK3iKxomPkpamC7B17HTknFAgoSwT7zpz3shFoXhugio8pjPb9eRS6Ca'
const SECOND =
  '2WMyoJh7W6GFmv4dA8yiv62VXZSZKUcysyVVGAEp4pYgJsA4yK4mcT8w4QZmeGWExdX1EuNq9gGeMbSGmU6pUaZM'

const ONE = 'test-cursor-one'

const payout = (signature: string, networkId: string, amount: bigint): RecognisedPayout => ({
  signature,
  wallet: WALLET,
  networkId,
  source: SENDER,
  amount,
  slot: 442_918_004n,
  blockTime: new Date('2026-08-29T00:00:00.000Z'),
})

describe.skipIf(url === undefined)('cursor against a live postgres', () => {
  let db: Database
  let close: () => Promise<void>

  const wipe = async () => {
    await db.delete(payouts).where(eq(payouts.wallet, WALLET))
    await db.delete(indexerCursors).where(eq(indexerCursors.wallet, WALLET))
  }

  beforeAll(async () => {
    const handle = createDatabase(url ?? '')
    db = handle.db
    close = handle.close

    await wipe()
    await db.delete(networks).where(eq(networks.id, ONE))
    await db.insert(networks).values({
      id: ONE,
      displayName: ONE,
      tokenMint: MINT,
      tokenSymbol: 'HONEY',
      tokenDecimals: 9,
      payoutSources: [{ kind: 'transfer' as const, address: SENDER }],
      payoutCadence: 'weekly' as const,
    })
  })

  afterAll(async () => {
    await wipe()
    await db.delete(networks).where(eq(networks.id, ONE))
    await close()
  })

  it('has no cursor for a wallet that was never indexed', async () => {
    await wipe()

    expect(await readCursors(db, WALLET)).toEqual(new Map())
  })

  it('writes the payouts and the cursor of the pass that found them', async () => {
    await wipe()

    await recordPass(db, {
      wallet: WALLET,
      payouts: [payout(FIRST, ONE, 4000n)],
      cursors: [{ tokenAccount: HONEY_ACCOUNT, lastSignature: FIRST, lastSlot: 442_918_004n }],
    })

    const stored = await db.select().from(payouts).where(eq(payouts.wallet, WALLET))

    expect(stored).toHaveLength(1)
    expect(stored[0]?.amount).toBe(4000n)
    expect(await readCursors(db, WALLET)).toEqual(
      new Map([
        [
          HONEY_ACCOUNT,
          { tokenAccount: HONEY_ACCOUNT, lastSignature: FIRST, lastSlot: 442_918_004n },
        ],
      ]),
    )
  })

  it('adds nothing on a repeat pass over the same signatures', async () => {
    await wipe()

    const pass = {
      wallet: WALLET,
      payouts: [payout(FIRST, ONE, 4000n), payout(SECOND, ONE, 500n)],
      cursors: [{ tokenAccount: HONEY_ACCOUNT, lastSignature: FIRST, lastSlot: 442_918_004n }],
    }

    await recordPass(db, pass)
    await recordPass(db, pass)

    expect(await db.select().from(payouts).where(eq(payouts.wallet, WALLET))).toHaveLength(2)
  })

  it('keeps the first reading of a signature: the chain cannot change it afterwards', async () => {
    await wipe()

    await recordPass(db, {
      wallet: WALLET,
      payouts: [payout(FIRST, ONE, 4000n)],
      cursors: [{ tokenAccount: HONEY_ACCOUNT, lastSignature: FIRST, lastSlot: 442_918_004n }],
    })
    await recordPass(db, {
      wallet: WALLET,
      payouts: [payout(FIRST, ONE, 999n)],
      cursors: [{ tokenAccount: HONEY_ACCOUNT, lastSignature: FIRST, lastSlot: 442_918_004n }],
    })

    const stored = await db.select().from(payouts).where(eq(payouts.wallet, WALLET))

    expect(stored).toHaveLength(1)
    expect(stored[0]?.amount).toBe(4000n)
  })

  it('moves each token account to its own signature, not to a shared one', async () => {
    await wipe()

    await recordPass(db, {
      wallet: WALLET,
      payouts: [],
      cursors: [
        { tokenAccount: HONEY_ACCOUNT, lastSignature: FIRST, lastSlot: 442_918_004n },
        { tokenAccount: HNT_ACCOUNT, lastSignature: SECOND, lastSlot: 442_919_000n },
      ],
    })

    const cursors = await readCursors(db, WALLET)

    expect(cursors.get(HONEY_ACCOUNT)?.lastSignature).toBe(FIRST)
    expect(cursors.get(HNT_ACCOUNT)?.lastSignature).toBe(SECOND)
  })

  // Акаунт, у якому нічого нового, курсора з проходу не повертає взагалі, і
  // збережений курсор має лишитись там, де стояв.
  it('leaves an account the pass says nothing about where it was', async () => {
    await wipe()

    await recordPass(db, {
      wallet: WALLET,
      payouts: [],
      cursors: [
        { tokenAccount: HONEY_ACCOUNT, lastSignature: FIRST, lastSlot: 442_918_004n },
        { tokenAccount: HNT_ACCOUNT, lastSignature: FIRST, lastSlot: 442_918_004n },
      ],
    })
    await recordPass(db, {
      wallet: WALLET,
      payouts: [],
      cursors: [{ tokenAccount: HONEY_ACCOUNT, lastSignature: SECOND, lastSlot: 442_919_000n }],
    })

    const cursors = await readCursors(db, WALLET)

    expect(cursors.get(HONEY_ACCOUNT)?.lastSlot).toBe(442_919_000n)
    expect(cursors.get(HNT_ACCOUNT)?.lastSlot).toBe(442_918_004n)
  })

  it('leaves the cursor where it was when a payout cannot be written', async () => {
    await wipe()

    await recordPass(db, {
      wallet: WALLET,
      payouts: [payout(FIRST, ONE, 4000n)],
      cursors: [{ tokenAccount: HONEY_ACCOUNT, lastSignature: FIRST, lastSlot: 442_918_004n }],
    })

    await expect(
      recordPass(db, {
        wallet: WALLET,
        payouts: [payout(SECOND, 'no-such-network', 500n)],
        cursors: [{ tokenAccount: HONEY_ACCOUNT, lastSignature: SECOND, lastSlot: 442_919_000n }],
      }),
    ).rejects.toThrow()

    expect((await readCursors(db, WALLET)).get(HONEY_ACCOUNT)?.lastSignature).toBe(FIRST)
    expect(await db.select().from(payouts).where(eq(payouts.wallet, WALLET))).toHaveLength(1)
  })

  it('keeps the cursors of two wallets apart', async () => {
    await wipe()

    const other = solanaAddressSchema.parse('9axh44i2g6U3q4KZxG9ieH4Z8Khx4N8npn4hWotr8zeZ')

    await recordPass(db, {
      wallet: WALLET,
      payouts: [],
      cursors: [{ tokenAccount: HONEY_ACCOUNT, lastSignature: FIRST, lastSlot: 442_918_004n }],
    })

    expect(await readCursors(db, other)).toEqual(new Map())

    await db
      .delete(indexerCursors)
      .where(and(eq(indexerCursors.wallet, WALLET), eq(indexerCursors.tokenAccount, HONEY_ACCOUNT)))
  })
})
