import { z } from 'zod'
import { solanaAddressSchema } from './primitives.ts'

// `on-demand` — не ритм, а його відсутність: мережа накопичує винагороду, і
// момент виплати обирає оператор (Helium через `lazy_distributor`). Ончейн у
// такої мережі лежить історія зняттів, а не заробітку — застереження `FR-001a`.
export const PAYOUT_CADENCES = ['daily', 'weekly', 'monthly', 'on-demand'] as const

// Винагорода доходить до оператора двома різними способами, і адреси самої
// замало, щоб їх розрізнити. `transfer` — переказ від розподільника, власника
// токен-акаунта (Helium). `mint` — емісія авторитетом мінта: у Hivemapper
// розподільника не існує взагалі, токен створюється в мить виплати, і жодного
// акаунта-відправника в транзакції немає.
export const PAYOUT_SOURCE_KINDS = ['transfer', 'mint'] as const

export const payoutSourceSchema = z.object({
  kind: z.enum(PAYOUT_SOURCE_KINDS),
  address: solanaAddressSchema,
})

export type PayoutSource = z.infer<typeof payoutSourceSchema>

export type PayoutSourceKind = PayoutSource['kind']

// Ключ розпізнавання — пара, а не адреса: той самий ключ може і переказувати
// токен, і бути авторитетом емісії, і це два різні надходження.
export function payoutSourceKey(source: PayoutSource): string {
  return `${source.kind}:${source.address}`
}

export const rewardNetworkSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'expected a lowercase slug'),
  displayName: z.string().min(1),
  token: z.object({
    mint: solanaAddressSchema,
    symbol: z.string().min(1).max(16),
    decimals: z.number().int().min(0).max(18),
  }),
  payoutSources: z
    .array(payoutSourceSchema)
    .min(1, 'a network with no payout source cannot have its payouts recognised')
    .refine(
      (list) => new Set(list.map(payoutSourceKey)).size === list.length,
      'duplicate payout source',
    ),
  payoutCadence: z.enum(PAYOUT_CADENCES),
})

export type RewardNetwork = z.infer<typeof rewardNetworkSchema>

export type PayoutCadence = RewardNetwork['payoutCadence']

const rewardNetworkListSchema = z.array(rewardNetworkSchema).min(1)

export function parseRewardNetworks(input: unknown): ReadonlyMap<string, RewardNetwork> {
  const networks = rewardNetworkListSchema.parse(input)
  const byId = new Map<string, RewardNetwork>()
  const owners = new Map<string, string>()

  for (const network of networks) {
    if (byId.has(network.id)) throw new Error(`duplicate network id: ${network.id}`)
    byId.set(network.id, network)

    for (const source of network.payoutSources) {
      // FR-002 розпізнає виплату за джерелом надходження. Якщо одне джерело
      // числиться за двома мережами, виплата від нього не належить жодній
      // однозначно — і мовчки потрапить не в ту історію.
      const key = payoutSourceKey(source)
      const owner = owners.get(key)
      if (owner !== undefined) {
        throw new Error(`payout source ${key} claimed by both ${owner} and ${network.id}`)
      }
      owners.set(key, network.id)
    }
  }

  return byId
}
