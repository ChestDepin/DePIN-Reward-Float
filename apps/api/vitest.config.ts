import { defineConfig } from 'vitest/config'

// Живі набори `operators.test.ts` і `health.test.ts` сідають на ті самі рядки
// однієї бази — той самий гаманець, ті самі таблиці — і кожен прибирає за
// собою видаленням по ньому. Паралельно вони стирають дані одне одному, і
// набір бачить чужу мережу замість своєї.
export default defineConfig({
  test: { fileParallelism: false },
})
