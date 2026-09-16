import { defineConfig } from 'vitest/config'

// Замір затримки не належить `pnpm gate`: він наповнює живу базу сотнями
// рядків і додає десятки секунд до кожного коміта. Запускається окремо —
// `pnpm bench:limit`.
export default defineConfig({
  test: { exclude: ['**/node_modules/**', '**/*-latency.spec.ts'] },
})
