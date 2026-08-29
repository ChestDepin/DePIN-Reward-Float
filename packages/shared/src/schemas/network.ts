import { z } from 'zod'
import { solanaAddressSchema } from './primitives.ts'

export const PAYOUT_CADENCES = ['daily', 'weekly', 'monthly'] as const

export const rewardNetworkSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'expected a lowercase slug'),
  displayName: z.string().min(1),
  token: z.object({
    mint: solanaAddressSchema,
    symbol: z.string().min(1).max(16),
    decimals: z.number().int().min(0).max(18),
  }),
  distributors: z
    .array(solanaAddressSchema)
    .min(1, 'a network with no distributor cannot have its payouts recognised')
    .refine((list) => new Set(list).size === list.length, 'duplicate distributor'),
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

    for (const distributor of network.distributors) {
      // FR-002 розпізнає виплату за джерелом переказу. Якщо один розподільник
      // числиться за двома мережами, виплата від нього не належить жодній
      // однозначно — і мовчки потрапить не в ту історію.
      const owner = owners.get(distributor)
      if (owner !== undefined) {
        throw new Error(`distributor ${distributor} claimed by both ${owner} and ${network.id}`)
      }
      owners.set(distributor, network.id)
    }
  }

  return byId
}
