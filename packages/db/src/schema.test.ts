import { PAYOUT_CADENCES } from '@drf/shared/schemas'
import type { PgTable } from 'drizzle-orm/pg-core'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  attestations,
  creditProfiles,
  indexerCursors,
  networks,
  payouts,
  pricePoints,
} from './schema.ts'

const TABLES = [networks, payouts, pricePoints, creditProfiles, attestations, indexerCursors]

function primaryKeyOf(table: PgTable): string[] {
  const config = getTableConfig(table)
  const composite = config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name))

  return composite.length > 0
    ? composite
    : config.columns.filter((column) => column.primary).map((column) => column.name)
}

function columnOf(table: PgTable, name: string) {
  const column = getTableConfig(table).columns.find((candidate) => candidate.name === name)
  if (column === undefined) throw new Error(`${getTableConfig(table).name} has no column ${name}`)

  return column
}

describe('schema', () => {
  it('declares the six tables the offchain side needs, and no others', () => {
    expect(TABLES.map((table) => getTableConfig(table).name)).toEqual([
      'networks',
      'payouts',
      'price_points',
      'credit_profiles',
      'attestations',
      'indexer_cursors',
    ])
  })

  it('keeps every amount and price out of floating point', () => {
    for (const table of TABLES) {
      for (const column of getTableConfig(table).columns) {
        expect(column.getSQLType()).not.toMatch(/real|double precision/)
      }
    }
  })
})

describe('networks', () => {
  it('describes a network as data: token, payout sources, cadence', () => {
    expect(primaryKeyOf(networks)).toEqual(['id'])
    expect(columnOf(networks, 'token_mint').notNull).toBe(true)
    // jsonb, а не text[]: у джерелі виплати є вид, і масив адрес його загубив би.
    expect(columnOf(networks, 'payout_sources').getSQLType()).toBe('jsonb')
  })

  it('takes the cadences from the shared description, not a second list', () => {
    expect(columnOf(networks, 'payout_cadence').enumValues).toEqual([...PAYOUT_CADENCES])
  })
})

describe('payouts', () => {
  it('is keyed by signature and wallet, so a repeated pass writes the same rows', () => {
    expect(primaryKeyOf(payouts)).toEqual(['signature', 'wallet'])
  })

  it('records the source of the arrival, which is what makes it a reward', () => {
    expect(columnOf(payouts, 'source').notNull).toBe(true)
    expect(columnOf(payouts, 'network_id').notNull).toBe(true)
  })

  it('holds the token amount in minimal units, never as a number', () => {
    expect(columnOf(payouts, 'amount').getSQLType()).toBe('numeric(20, 0)')
    expect(columnOf(payouts, 'amount').notNull).toBe(true)
  })

  it('leaves the stable value null when the price for that day is missing', () => {
    expect(columnOf(payouts, 'value_usd').notNull).toBe(false)
  })

  it('indexes the wallet history the way it is read: by wallet, in time order', () => {
    const indexed = getTableConfig(payouts).indexes.map((index) =>
      index.config.columns.map((column) => ('name' in column ? column.name : '')),
    )

    expect(indexed).toContainEqual(['wallet', 'block_time'])
  })
})

describe('price_points', () => {
  it('is one row per mint per day', () => {
    expect(primaryKeyOf(pricePoints)).toEqual(['mint', 'day'])
    expect(columnOf(pricePoints, 'day').getSQLType()).toBe('date')
  })

  it('remembers where the quote came from', () => {
    expect(columnOf(pricePoints, 'source').notNull).toBe(true)
    expect(columnOf(pricePoints, 'price_usd').notNull).toBe(true)
  })
})

describe('credit_profiles', () => {
  it('keeps the three unavailable states apart from a limit of zero', () => {
    expect(columnOf(creditProfiles, 'status').enumValues).toEqual([
      'available',
      'ineligible',
      'data_unavailable',
      'incomplete_prices',
    ])
  })

  it('refuses to carry a number unless the limit was actually computed', () => {
    expect(columnOf(creditProfiles, 'limit_usd').notNull).toBe(false)
    expect(getTableConfig(creditProfiles).checks.map((constraint) => constraint.name)).toEqual([
      'credit_profiles_limit_only_when_available',
    ])
  })

  it('carries the refusal date and the derivation next to the limit', () => {
    expect(columnOf(creditProfiles, 'eligible_at').notNull).toBe(false)
    expect(columnOf(creditProfiles, 'factors').getSQLType()).toBe('jsonb')
    expect(columnOf(creditProfiles, 'expires_at').notNull).toBe(true)
  })
})

describe('attestations', () => {
  it('is keyed by wallet and nonce, because the nonce is per operator onchain', () => {
    expect(primaryKeyOf(attestations)).toEqual(['wallet', 'nonce'])
  })

  it('records which key signed it, so a rotation does not orphan live attestations', () => {
    expect(columnOf(attestations, 'attestor').notNull).toBe(true)
    expect(columnOf(attestations, 'signature').notNull).toBe(true)
  })

  it('is unconsumed until a borrow spends it', () => {
    expect(columnOf(attestations, 'consumed_at').notNull).toBe(false)
    expect(columnOf(attestations, 'expires_at').notNull).toBe(true)
  })
})

describe('indexer_cursors', () => {
  // Акаунти перелічуються різними списками, і сигнатура, на якій скінчився
  // один, у списку іншого не буває.
  it('is one cursor per token account, not per network', () => {
    expect(primaryKeyOf(indexerCursors)).toEqual(['wallet', 'token_account'])
  })

  it('has no row without the signature it stopped at', () => {
    expect(columnOf(indexerCursors, 'last_signature').notNull).toBe(true)
    expect(columnOf(indexerCursors, 'last_slot').notNull).toBe(true)
  })
})
