import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  creditProfiles,
  type Database,
  networks as networksTable,
  payouts as payoutsTable,
  pricePoints,
} from '@drf/db'
import { rewardNetworkSchema, solanaAddressSchema } from '@drf/shared/schemas'
import { eq } from 'drizzle-orm'

// Спільна історія обох замірів: один і той самий оператор, той самий обсяг
// даних. Два різні набори давали б два числа, які нема з чим порівняти.
export const NOW = new Date('2026-08-31T12:00:00.000Z')
const HISTORY_START = new Date('2025-09-01T00:00:00.000Z')

export const WALLET = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')

const HONEY_MINT = solanaAddressSchema.parse('2RZMt9LwzUzSUNfprdLSUF33gS2Y3EJL3jqN6g6a9oP1')
const HNT_MINT = solanaAddressSchema.parse('3mqvZ478SVFftqm6Pmh14SdUhUHuaG7KkKqaBDqNZADs')
const HONEY_SOURCE = solanaAddressSchema.parse('G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7')
const HNT_SOURCE = solanaAddressSchema.parse('9axh44i2g6U3q4KZxG9ieH4Z8Khx4N8npn4hWotr8zeZ')

export const HIVEMAPPER = rewardNetworkSchema.parse({
  id: 'test-latency-hivemapper',
  displayName: 'Hivemapper',
  token: { mint: HONEY_MINT, symbol: 'HONEY', decimals: 9 },
  payoutSources: [{ kind: 'mint', address: HONEY_SOURCE }],
  payoutCadence: 'weekly',
})

// Мережа з `on-demand` ліміту не отримає, але її виплати однаково читаються і
// однаково коштують: історія оператора рідко буває на одній мережі.
export const HELIUM = rewardNetworkSchema.parse({
  id: 'test-latency-helium',
  displayName: 'Helium',
  token: { mint: HNT_MINT, symbol: 'HNT', decimals: 8 },
  payoutSources: [{ kind: 'transfer', address: HNT_SOURCE }],
  payoutCadence: 'on-demand',
})

const DAY_MS = 86_400_000
const CHUNK = 200

const day = (offset: number) => new Date(HISTORY_START.getTime() + offset * DAY_MS)

const HISTORY_DAYS = Math.round((NOW.getTime() - HISTORY_START.getTime()) / DAY_MS)

type PayoutRow = typeof payoutsTable.$inferInsert
type PriceRow = typeof pricePoints.$inferInsert

// Форма справжніх даних, зміряна в T023a: Hivemapper карбує щотижня, а Helium
// оператор знімає сам, 12–13 разів на місяць. Замір на трьох виплатах був би
// заміром порожньої бази.
export function payoutRows(): PayoutRow[] {
  const rows: PayoutRow[] = []

  for (let offset = 3; offset < HISTORY_DAYS; offset += 7) {
    rows.push({
      signature: `latency-honey-${offset}`,
      wallet: WALLET,
      networkId: HIVEMAPPER.id,
      source: HONEY_SOURCE,
      amount: BigInt(400_000_000_000 + offset * 1_000_000_000),
      slot: BigInt(442_000_000 + offset),
      blockTime: day(offset),
      valueUsd: null,
    })
  }

  for (let index = 0; index < 152; index += 1) {
    const offset = Math.floor((index * HISTORY_DAYS) / 152)
    rows.push({
      signature: `latency-hnt-${index}`,
      wallet: WALLET,
      networkId: HELIUM.id,
      source: HNT_SOURCE,
      amount: BigInt(120_000_000 + index * 1_000_000),
      slot: BigInt(443_000_000 + index),
      blockTime: day(offset),
      valueUsd: null,
    })
  }

  return rows
}

export function priceRows(): PriceRow[] {
  const rows: PriceRow[] = []

  for (let offset = 0; offset < HISTORY_DAYS; offset += 1) {
    const wobble = 1 + Math.sin(offset / 30) / 4
    rows.push({
      mint: HONEY_MINT,
      day: day(offset).toISOString().slice(0, 10),
      priceUsd: (0.02 * wobble).toFixed(18),
      source: 'latency-fixture',
    })
    rows.push({
      mint: HNT_MINT,
      day: day(offset).toISOString().slice(0, 10),
      priceUsd: (3.5 * wobble).toFixed(18),
      source: 'latency-fixture',
    })
  }

  return rows
}

async function insertAll<T>(rows: readonly T[], write: (batch: T[]) => Promise<unknown>) {
  for (let start = 0; start < rows.length; start += CHUNK) {
    await write(rows.slice(start, start + CHUNK))
  }
}

export async function clearCachedProfiles(db: Database): Promise<void> {
  await db.delete(creditProfiles).where(eq(creditProfiles.wallet, WALLET))
}

export async function wipeHistory(db: Database): Promise<void> {
  await db.delete(payoutsTable).where(eq(payoutsTable.wallet, WALLET))
  await clearCachedProfiles(db)

  for (const mint of [HONEY_MINT, HNT_MINT]) {
    await db.delete(pricePoints).where(eq(pricePoints.mint, mint))
  }
}

export async function wipeNetworks(db: Database): Promise<void> {
  for (const network of [HIVEMAPPER, HELIUM]) {
    await db.delete(networksTable).where(eq(networksTable.id, network.id))
  }
}

export async function seedHistory(db: Database): Promise<void> {
  await wipeHistory(db)
  await wipeNetworks(db)

  for (const network of [HIVEMAPPER, HELIUM]) {
    await db.insert(networksTable).values({
      id: network.id,
      displayName: network.displayName,
      tokenMint: network.token.mint,
      tokenSymbol: network.token.symbol,
      tokenDecimals: network.token.decimals,
      payoutSources: [...network.payoutSources],
      payoutCadence: network.payoutCadence,
    })
  }

  await insertAll(payoutRows(), (batch) => db.insert(payoutsTable).values(batch))
  await insertAll(priceRows(), (batch) => db.insert(pricePoints).values(batch))
}

export function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL

  try {
    const file = readFileSync(path.join(import.meta.dirname, '..', '.env'), 'utf8')
    return file
      .split(/\r?\n/)
      .find((line) => line.startsWith('DATABASE_URL='))
      ?.slice('DATABASE_URL='.length)
  } catch {
    return undefined
  }
}
