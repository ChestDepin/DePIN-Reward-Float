import { defineConfig } from 'vitest/config'

const TEN_MINUTES = 600_000

export default defineConfig({
  test: {
    include: ['**/*-latency.spec.ts'],
    // Замір, чиїх чисел не видно, нічого не доводить: типовий репортер ховає
    // `console` за успішним тестом.
    reporters: ['verbose'],
    // Обидва заміри сідають на ті самі рядки живої бази і на ту саму машину.
    // Паралельно вони міряли б чергу одне до одного, а не себе.
    fileParallelism: false,
    // Двадцять холодних запитів плюс наповнення бази не вкладаються в
    // типовий бюджет vitest, і падіння за таймаутом читалося б як провал
    // критерію.
    testTimeout: TEN_MINUTES,
    hookTimeout: TEN_MINUTES,
  },
})
