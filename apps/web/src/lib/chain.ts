import { rewardMintsSchema } from '@drf/anchor-client'
import { solanaAddressSchema } from '@drf/shared/schemas'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'

// The Pages build hands over a repository variable that was never set as "", and a
// stablecoin of "" must mean "lending is not set up", not a page that fails to load.
function unsetWhenEmpty<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema)
}

const chainEnvSchema = z.object({
  VITE_DEVNET_RPC_URL: unsetWhenEmpty(
    z.url({ protocol: /^https?$/ }).default('https://api.devnet.solana.com'),
  ),
  VITE_STABLE_MINT: unsetWhenEmpty(solanaAddressSchema.optional()),
  VITE_REWARD_MINTS: rewardMintsSchema,
})

export type ChainConfig = {
  rpcUrl: string
  stableMint: PublicKey | null
  rewardMints: ReadonlyMap<string, PublicKey>
}

export function parseChainConfig(env: unknown): ChainConfig {
  const parsed = chainEnvSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`chain config: ${problems.join('; ')}`)
  }
  const { VITE_DEVNET_RPC_URL, VITE_STABLE_MINT, VITE_REWARD_MINTS } = parsed.data
  return {
    rpcUrl: VITE_DEVNET_RPC_URL,
    stableMint: VITE_STABLE_MINT === undefined ? null : new PublicKey(VITE_STABLE_MINT),
    rewardMints: VITE_REWARD_MINTS,
  }
}

export const chainConfig = parseChainConfig(import.meta.env)
