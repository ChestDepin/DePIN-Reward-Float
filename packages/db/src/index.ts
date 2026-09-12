import path from 'node:path'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { z } from 'zod'
import * as schema from './schema.ts'

export * from './schema.ts'
export * from './seed.ts'

export type Database = PostgresJsDatabase<typeof schema>

export type DatabaseHandle = {
  db: Database
  close: () => Promise<void>
}

export const MIGRATIONS_FOLDER = path.join(import.meta.dirname, '..', 'migrations')

const databaseUrlSchema = z.url({ protocol: /^postgres(ql)?$/ })

export function createDatabase(databaseUrl: string): DatabaseHandle {
  if (!databaseUrlSchema.safeParse(databaseUrl).success) {
    // У рядку підключення їде пароль до бази, а падіння читають з логів,
    // тому сюди потрапляє тільки ім'я змінної.
    throw new Error('DATABASE_URL is not a postgres connection string')
  }

  const client = postgres(databaseUrl)

  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  }
}

export async function migrateToLatest(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
}
