import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  parseRewardNetworks,
  rewardNetworkSchema,
  solanaAddressSchema,
  SUPPORTED_NETWORKS,
} from '@drf/shared/schemas'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from './index.ts'
import { networks } from './schema.ts'
import { seedNetworks, toNetworkRow } from './seed.ts'

function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL

  try {
    const file = readFileSync(path.join(import.meta.dirname, '..', '..', '..', '.env'), 'utf8')
    return file
      .split(/\r?\n/)
      .find((line) => line.startsWith('DATABASE_URL='))
      ?.slice('DATABASE_URL='.length)
  } catch {
    return undefined
  }
}

const url = databaseUrl()

// Адреси, звірені на мейннеті 2026-08-31. Тест на літерал навмисний: конфіг
// мереж — єдине місце, де одна змінена літера тихо переписує чужу історію
// виплат, і зміна має бути видимою в дифі тесту, а не тільки в дифі даних.
const HIVEMAPPER_MINT_AUTHORITY = '7VhQVr8M2Dpdwp4QzzQB7EpvANtMMjv7gwpBHCrV3U2A'
const HELIUM_DISTRIBUTOR = '73zsmmqCXjvHHhNSib26Y8p3jYiH3UUuyKv71RJDnctW'

describe('SUPPORTED_NETWORKS', () => {
  it('describes both networks the product reads today', () => {
    expect([...SUPPORTED_NETWORKS.keys()]).toEqual(['hivemapper', 'helium'])
  })

  it('survives the same checks a config file would face', () => {
    expect(() => parseRewardNetworks([...SUPPORTED_NETWORKS.values()])).not.toThrow()

    for (const network of SUPPORTED_NETWORKS.values()) {
      expect(rewardNetworkSchema.safeParse(network).success).toBe(true)
    }
  })

  // Hivemapper карбує винагороду в мить виплати, у нього немає розподільника
  // взагалі; Helium переказує її з акаунта circuit_breaker.
  it('names the mint authority for Hivemapper and the distributor for Helium', () => {
    expect(SUPPORTED_NETWORKS.get('hivemapper')?.payoutSources).toEqual([
      { kind: 'mint', address: HIVEMAPPER_MINT_AUTHORITY },
    ])
    expect(SUPPORTED_NETWORKS.get('helium')?.payoutSources).toEqual([
      { kind: 'transfer', address: HELIUM_DISTRIBUTOR },
    ])
  })

  it('carries the decimals of each mint, which the amounts are meaningless without', () => {
    expect(SUPPORTED_NETWORKS.get('hivemapper')?.token).toEqual({
      mint: '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy',
      symbol: 'HONEY',
      decimals: 9,
    })
    expect(SUPPORTED_NETWORKS.get('helium')?.token).toEqual({
      mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux',
      symbol: 'HNT',
      decimals: 8,
    })
  })

  // Виміряно 2026-08-31: Hivemapper розсилає всім разом раз на тиждень, а в
  // Helium один оператор знімає 24 рази на місяць, інший — раз на 460 днів.
  // Ритм там належить оператору, не мережі.
  it('says Hivemapper pays weekly and Helium pays on demand', () => {
    expect(SUPPORTED_NETWORKS.get('hivemapper')?.payoutCadence).toBe('weekly')
    expect(SUPPORTED_NETWORKS.get('helium')?.payoutCadence).toBe('on-demand')
  })
})

describe('toNetworkRow', () => {
  it('flattens the token into the columns that hold it', () => {
    const network = SUPPORTED_NETWORKS.get('hivemapper')
    if (network === undefined) throw new Error('hivemapper is missing from the seed')

    expect(toNetworkRow(network)).toEqual({
      id: 'hivemapper',
      displayName: 'Hivemapper',
      tokenMint: '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy',
      tokenSymbol: 'HONEY',
      tokenDecimals: 9,
      payoutSources: [{ kind: 'mint', address: HIVEMAPPER_MINT_AUTHORITY }],
      payoutCadence: 'weekly',
    })
  })
})

describe.skipIf(url === undefined)('seedNetworks against a live postgres', () => {
  let db: Database
  let close: () => Promise<void>

  beforeAll(() => {
    const handle = createDatabase(url ?? '')
    db = handle.db
    close = handle.close
  })

  afterAll(async () => {
    // Рядки навмисно лишаються: сід — це стан конфігурації, а не тимчасові дані
    // тесту. Останній прогін приводить таблицю до того, що описує код.
    await seedNetworks(db)
    await close()
  })

  it('writes a row for every supported network', async () => {
    await seedNetworks(db)

    const rows = await db.select().from(networks)
    const seeded = rows.filter((row) => SUPPORTED_NETWORKS.has(row.id))

    expect(seeded.map((row) => row.id).sort()).toEqual(['helium', 'hivemapper'])
  })

  it('reads back through the same schema the classifier uses', async () => {
    await seedNetworks(db)

    const [row] = await db.select().from(networks).where(eq(networks.id, 'hivemapper'))
    if (row === undefined) throw new Error('hivemapper was not seeded')

    const network = rewardNetworkSchema.parse({
      id: row.id,
      displayName: row.displayName,
      token: { mint: row.tokenMint, symbol: row.tokenSymbol, decimals: row.tokenDecimals },
      payoutSources: row.payoutSources,
      payoutCadence: row.payoutCadence,
    })

    expect(network.payoutSources).toEqual([{ kind: 'mint', address: HIVEMAPPER_MINT_AUTHORITY }])
  })

  it('runs twice without duplicating a network', async () => {
    await seedNetworks(db)
    await seedNetworks(db)

    const rows = await db.select().from(networks).where(eq(networks.id, 'helium'))

    expect(rows).toHaveLength(1)
  })

  // Розподільник змінюється — це передбачений випадок (T023b). Виправлення має
  // бути перезапуском сіду, а не запитом руками в базу.
  it('corrects a row whose payout source drifted', async () => {
    await seedNetworks(db)
    await db
      .update(networks)
      .set({
        payoutSources: [
          { kind: 'transfer', address: solanaAddressSchema.parse(HIVEMAPPER_MINT_AUTHORITY) },
        ],
      })
      .where(eq(networks.id, 'helium'))

    await seedNetworks(db)

    const [row] = await db.select().from(networks).where(eq(networks.id, 'helium'))

    expect(row?.payoutSources).toEqual([{ kind: 'transfer', address: HELIUM_DISTRIBUTOR }])
  })
})
