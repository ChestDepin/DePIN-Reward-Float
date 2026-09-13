import { type Database, indexerCursors, payouts } from '@drf/db'
import type { SolanaAddress } from '@drf/shared/schemas'
import type { RecognisedPayout } from '@drf/shared/scoring'
import { eq } from 'drizzle-orm'
import type { TokenAccountCursor } from './payouts.ts'

export type IndexPass = {
  wallet: SolanaAddress
  payouts: readonly RecognisedPayout[]
  cursors: readonly TokenAccountCursor[]
}

// Курсори читаються всі разом: акаунти оператора знаходить сам прохід, і той,
// хто його починає, ще не знає, за якими акаунтами питати.
export async function readCursors(
  db: Database,
  wallet: SolanaAddress,
): Promise<Map<SolanaAddress, TokenAccountCursor>> {
  const rows = await db
    .select({
      tokenAccount: indexerCursors.tokenAccount,
      lastSignature: indexerCursors.lastSignature,
      lastSlot: indexerCursors.lastSlot,
    })
    .from(indexerCursors)
    .where(eq(indexerCursors.wallet, wallet))

  return new Map(rows.map((row) => [row.tokenAccount, row]))
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

    for (const cursor of pass.cursors) {
      await tx
        .insert(indexerCursors)
        .values({ wallet: pass.wallet, ...cursor })
        .onConflictDoUpdate({
          target: [indexerCursors.wallet, indexerCursors.tokenAccount],
          set: {
            lastSignature: cursor.lastSignature,
            lastSlot: cursor.lastSlot,
            updatedAt: new Date(),
          },
        })
    }
  })
}
