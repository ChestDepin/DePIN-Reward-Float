import { type Database, indexerCursors, payouts } from '@drf/db'
import type { SolanaAddress } from '@drf/shared/schemas'
import type { RecognisedPayout } from '@drf/shared/scoring'
import { and, eq } from 'drizzle-orm'

export type IndexerCursor = {
  lastSignature: string | null
  lastSlot: bigint | null
}

export type IndexPass = {
  wallet: SolanaAddress
  // Сигнатури гаманця — один потік на всі мережі, тож прохід зсуває курсор
  // кожної мережі, яку він покривав, а не тільки тієї, де знайшлась виплата.
  networkIds: readonly string[]
  payouts: readonly RecognisedPayout[]
  lastSignature: string | null
  lastSlot: bigint | null
}

export async function readCursor(
  db: Database,
  wallet: SolanaAddress,
  networkId: string,
): Promise<IndexerCursor | null> {
  const [row] = await db
    .select({ lastSignature: indexerCursors.lastSignature, lastSlot: indexerCursors.lastSlot })
    .from(indexerCursors)
    .where(and(eq(indexerCursors.wallet, wallet), eq(indexerCursors.networkId, networkId)))
    .limit(1)

  return row ?? null
}

export async function recordPass(db: Database, pass: IndexPass): Promise<void> {
  await db.transaction(async (tx) => {
    if (pass.payouts.length > 0) {
      // Сигнатура вже записана — значить, її прочитали з того самого ланцюга,
      // і другий прохід не має чого виправляти.
      await tx
        .insert(payouts)
        .values(pass.payouts.map((payout) => ({ ...payout })))
        .onConflictDoNothing()
    }

    for (const networkId of pass.networkIds) {
      await tx
        .insert(indexerCursors)
        .values({
          wallet: pass.wallet,
          networkId,
          lastSignature: pass.lastSignature,
          lastSlot: pass.lastSlot,
        })
        .onConflictDoUpdate({
          target: [indexerCursors.wallet, indexerCursors.networkId],
          set: {
            lastSignature: pass.lastSignature,
            lastSlot: pass.lastSlot,
            updatedAt: new Date(),
          },
        })
    }
  })
}
