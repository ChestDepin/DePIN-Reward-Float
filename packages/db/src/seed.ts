import { parseRewardNetworks, type RewardNetwork } from '@drf/shared/schemas'
import { sql } from 'drizzle-orm'
import type { Database } from './index.ts'
import { networks } from './schema.ts'

// Єдине місце, де підтримувані мережі існують як дані. Кожна адреса звірена на
// мейннеті 2026-08-31, і правильність доводить не цей файл, а T024: нуль
// помилок класифікації на реальних гаманцях.
export const SUPPORTED_NETWORKS = parseRewardNetworks([
  {
    id: 'hivemapper',
    displayName: 'Hivemapper',
    token: {
      mint: '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy',
      symbol: 'HONEY',
      decimals: 9,
    },
    // Розподільника не існує: винагорода створюється `mintTo` в мить виплати.
    // Адреса є полем `mintAuthority` самого мінта HONEY, тобто читається зі
    // стану ланцюга, а не виводиться зі спостережень.
    payoutSources: [{ kind: 'mint', address: '7VhQVr8M2Dpdwp4QzzQB7EpvANtMMjv7gwpBHCrV3U2A' }],
    // Мережа розсилає всім разом раз на тиждень, кластери лягають на четвер UTC.
    payoutCadence: 'weekly',
  },
  {
    id: 'helium',
    displayName: 'Helium',
    token: {
      mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux',
      symbol: 'HNT',
      decimals: 8,
    },
    // Акаунт circuit_breaker, власник ATA розподільника `lazy_distributor`:
    // саме його бачить класифікатор, бо звіряє власника акаунта-відправника.
    payoutSources: [{ kind: 'transfer', address: '73zsmmqCXjvHHhNSib26Y8p3jYiH3UUuyKv71RJDnctW' }],
    // Не ритм, а його відсутність: винагорода накопичується, і момент зняття
    // обирає оператор. Ончейн тут історія зняттів, а не заробітку (`FR-001a`).
    payoutCadence: 'on-demand',
  },
])

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
