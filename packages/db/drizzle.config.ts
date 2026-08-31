import { defineConfig } from 'drizzle-kit'

// `generate` читає тільки схему і до бази не ходить, тому порожній url тут не
// ламає генерацію міграцій — він потрібен лише для `push` і `studio`, які без
// справжнього DATABASE_URL і не мають працювати.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
