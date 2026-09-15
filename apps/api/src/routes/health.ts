import { type Database, networks as networksTable, payouts as payoutsTable } from '@drf/db'
import {
  type PayoutSourceKind,
  type RewardNetwork,
  rewardNetworkSchema,
  type SolanaAddress,
} from '@drf/shared/schemas'
import { max } from 'drizzle-orm'
import { Hono } from 'hono'
import { reading } from './errors.ts'

// Два пропущені тижневі цикли. Один пропуск буває від затримки самої мережі,
// два підряд — уже ні; для `on-demand` це не цикл, а просто тиша, за якої не
// зняв винагороду жоден оператор.
export const PAYOUT_SILENCE_DAYS = 14

const DAY_MS = 86_400_000

export type PayoutSourceActivity = {
  networkId: string
  source: SolanaAddress
  lastPayoutAt: Date
}

export type StoredPayoutActivity = {
  networks: readonly RewardNetwork[]
  activity: readonly PayoutSourceActivity[]
}

export type PayoutActivitySource = {
  read(): Promise<StoredPayoutActivity>
}

export type PayoutSourceState = 'paying' | 'silent' | 'unseen'

export type PayoutSourceReport = {
  networkId: string
  kind: PayoutSourceKind
  address: SolanaAddress
  lastPayoutAt: string | null
  state: PayoutSourceState
}

export type PayoutSourcesHealth = {
  status: 'ok' | 'alarm'
  checkedAt: string
  silenceDays: number
  sources: readonly PayoutSourceReport[]
}

function stateOf(lastPayoutAt: Date | undefined, silentBefore: Date): PayoutSourceState {
  if (lastPayoutAt === undefined) return 'unseen'

  return lastPayoutAt < silentBefore ? 'silent' : 'paying'
}

export function assessPayoutSources(input: {
  networks: readonly RewardNetwork[]
  activity: readonly PayoutSourceActivity[]
  now: Date
}): PayoutSourcesHealth {
  const { networks, activity, now } = input
  const silentBefore = new Date(now.getTime() - PAYOUT_SILENCE_DAYS * DAY_MS)

  // Ключ — пара «мережа й адреса», а не `payoutSourceKey`: виплата лягає в
  // базу самою адресою, без виду, тож джерело, оголошене і переказом, і
  // емісією за тією ж адресою, підтверджують ті самі рядки.
  const lastSeen = new Map(
    activity.map((entry) => [`${entry.networkId}/${entry.source}`, entry.lastPayoutAt]),
  )

  const sources = networks
    .flatMap((network) =>
      network.payoutSources.map((source) => {
        const lastPayoutAt = lastSeen.get(`${network.id}/${source.address}`)

        return {
          networkId: network.id,
          kind: source.kind,
          address: source.address,
          lastPayoutAt: lastPayoutAt?.toISOString() ?? null,
          state: stateOf(lastPayoutAt, silentBefore),
        }
      }),
    )
    .sort((left, right) => {
      if (left.networkId !== right.networkId) return left.networkId < right.networkId ? -1 : 1

      return left.address < right.address ? -1 : 1
    })

  return {
    // `unseen` тривогою не є: до першого проходу індексатора такими є всі
    // джерела, і тривога кричала б на кожному розгортанні.
    status: sources.some((source) => source.state === 'silent') ? 'alarm' : 'ok',
    checkedAt: now.toISOString(),
    silenceDays: PAYOUT_SILENCE_DAYS,
    sources,
  }
}

export function createDbPayoutActivitySource(db: Database): PayoutActivitySource {
  return {
    async read() {
      const networkRows = await reading('the supported networks', db.select().from(networksTable))

      const networks = networkRows.map((row) =>
        rewardNetworkSchema.parse({
          id: row.id,
          displayName: row.displayName,
          token: { mint: row.tokenMint, symbol: row.tokenSymbol, decimals: row.tokenDecimals },
          payoutSources: row.payoutSources,
          payoutCadence: row.payoutCadence,
        }),
      )

      // Розподільник змінюється для всіх операторів одночасно, тож питання не
      // «кому перестало приходити», а «чи прийшло хоч комусь» — гаманця в
      // запиті немає навмисно.
      const rows = await reading(
        'the payout activity',
        db
          .select({
            networkId: payoutsTable.networkId,
            source: payoutsTable.source,
            lastPayoutAt: max(payoutsTable.blockTime),
          })
          .from(payoutsTable)
          .groupBy(payoutsTable.networkId, payoutsTable.source),
      )

      const activity = rows.flatMap((row) =>
        row.lastPayoutAt === null
          ? []
          : [{ networkId: row.networkId, source: row.source, lastPayoutAt: row.lastPayoutAt }],
      )

      return { networks, activity }
    },
  }
}

export type HealthRoutesDeps = {
  activity: PayoutActivitySource
  now: () => Date
}

export function createHealthRoutes({ activity, now }: HealthRoutesDeps): Hono {
  const routes = new Hono()

  // Живучість не ходить у базу: інакше її блимання клало б пробу разом із
  // сервісом, який насправді відповідає.
  routes.get('/health', (c) => c.json({ status: 'ok' }))

  routes.get('/health/payout-sources', async (c) => {
    const stored = await activity.read()

    return c.json(assessPayoutSources({ ...stored, now: now() }))
  })

  return routes
}
