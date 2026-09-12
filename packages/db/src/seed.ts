import { SUPPORTED_NETWORKS, type RewardNetwork } from '@drf/shared/schemas'
import { sql } from 'drizzle-orm'
import type { Database } from './index.ts'
import { networks } from './schema.ts'

export type NetworkRow = typeof networks.$inferInsert

export function toNetworkRow(network: RewardNetwork): NetworkRow {
  return {
    id: network.id,
    displayName: network.displayName,
    tokenMint: network.token.mint,
    tokenSymbol: network.token.symbol,
    tokenDecimals: network.token.decimals,
    payoutSources: [...network.payoutSources],
    payoutCadence: network.payoutCadence,
  }
}

export async function seedNetworks(db: Database): Promise<void> {
  const rows = [...SUPPORTED_NETWORKS.values()].map(toNetworkRow)

  // Наявний рядок переписується, а не пропускається: адреса розподільника може
  // змінитися (T023b), і виправлення має бути перезапуском сіду, а не запитом
  // руками в базу. Мережі, яких тут немає, не чіпаються — сід описує
  // підтримувані, а не всю таблицю.
  await db
    .insert(networks)
    .values(rows)
    .onConflictDoUpdate({
      target: networks.id,
      set: {
        displayName: sql`excluded.display_name`,
        tokenMint: sql`excluded.token_mint`,
        tokenSymbol: sql`excluded.token_symbol`,
        tokenDecimals: sql`excluded.token_decimals`,
        payoutSources: sql`excluded.payout_sources`,
        payoutCadence: sql`excluded.payout_cadence`,
      },
    })
}
