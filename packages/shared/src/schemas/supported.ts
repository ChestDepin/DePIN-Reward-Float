import { parseRewardNetworks } from './network.ts'

// Єдине місце, де підтримувані мережі існують як дані. Кожна адреса звірена на
// мейннеті 2026-08-31, і правильність доводить не цей файл, а `classify.spec.ts`:
// нуль помилок класифікації на реальних гаманцях.
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
