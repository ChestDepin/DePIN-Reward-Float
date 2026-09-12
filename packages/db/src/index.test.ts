import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDatabase, MIGRATIONS_FOLDER } from './index.ts'

const PASSWORD = 's3cret-pgpass'
const VALID_URL = `postgres://drf:${PASSWORD}@localhost:5432/depin_reward_float`

function messageOf(build: () => unknown): string {
  try {
    build()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  return ''
}

describe('createDatabase', () => {
  it('builds a handle without opening a connection', async () => {
    const handle = createDatabase(VALID_URL)

    expect(typeof handle.db.select).toBe('function')
    await handle.close()
  })

  it('accepts the postgresql:// spelling too', async () => {
    const handle = createDatabase(VALID_URL.replace('postgres://', 'postgresql://'))

    await handle.close()
  })

  it('rejects a connection string for another database', () => {
    expect(messageOf(() => createDatabase(`mysql://drf:${PASSWORD}@localhost:3306/drf`))).not.toBe(
      '',
    )
  })

  it('rejects something that is not a url at all', () => {
    expect(messageOf(() => createDatabase('depin_reward_float'))).not.toBe('')
  })

  it('keeps the password out of the failure message', () => {
    expect(
      messageOf(() => createDatabase(`mysql://drf:${PASSWORD}@localhost:3306/drf`)),
    ).not.toContain(PASSWORD)
  })
})

describe('migrations', () => {
  const initial = readFileSync(path.join(MIGRATIONS_FOLDER, '0000_init.sql'), 'utf8')

  it('creates every table the schema declares', () => {
    for (const table of [
      'networks',
      'payouts',
      'price_points',
      'credit_profiles',
      'attestations',
      'indexer_cursors',
    ]) {
      expect(initial).toContain(`CREATE TABLE "${table}"`)
    }
  })

  it('carries the constraints, not just the columns', () => {
    expect(initial).toContain('PRIMARY KEY("signature","wallet")')
    expect(initial).toContain('credit_profiles_limit_only_when_available')
    expect(initial).toContain('payouts_wallet_block_time_idx')
  })

  it('has a journal the migrator can replay', () => {
    const journal: unknown = JSON.parse(
      readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    )

    expect(journal).toMatchObject({
      dialect: 'postgresql',
      entries: [
        { idx: 0, tag: '0000_init' },
        { idx: 1, tag: '0001_payout_sources' },
        { idx: 2, tag: '0002_drop_distributors' },
      ],
    })
  })

  // Джерело виплати не перейменоване, а перестворене: колонки міняють і тип, і
  // сенс, а обидві таблиці порожні, тож переносити не було чого.
  it('replaces the payout source in two steps instead of renaming a column', () => {
    const added = readFileSync(path.join(MIGRATIONS_FOLDER, '0001_payout_sources.sql'), 'utf8')
    const dropped = readFileSync(path.join(MIGRATIONS_FOLDER, '0002_drop_distributors.sql'), 'utf8')

    expect(added).toContain('"payout_sources" jsonb NOT NULL')
    expect(added).toContain('"source" text NOT NULL')
    expect(dropped).toContain('DROP COLUMN "distributors"')
    expect(dropped).toContain('DROP COLUMN "distributor"')
  })
})
