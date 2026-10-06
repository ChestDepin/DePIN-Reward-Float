// Creates the devnet stand-ins for HONEY and HNT that loans are tied to and that the demo
// pays rewards in. Each gets the decimals of its mainnet token, so amounts read the same.
//
//   SEED_KEYPAIR=<path to keypair json> REWARD_MINT_AUTHORITY=<public key> pnpm seed:reward-mints
//
// The payer only pays rent. Minting belongs to a key of its own: the demo and the keeper
// need it to pay rewards, and the deployer key would hand them program upgrades as well.
// Mints already in VITE_REWARD_MINTS are checked and kept, never replaced.
import { utils } from '@coral-xyz/anchor'
import { SUPPORTED_NETWORKS, solanaAddressSchema } from '@drf/shared/schemas'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js'
import { z } from 'zod'
import { formatRewardMints, rewardMintsSchema } from '../src/reward-mints.ts'
import {
  decodeMint,
  initializeMintInstruction,
  MINT_SIZE,
  type MintState,
  readKeypair,
} from './seed-pool.ts'

export type RewardMintConfig = {
  keypairPath: string
  rpcUrl: string
  authority: PublicKey
  existing: ReadonlyMap<string, PublicKey>
}
export type RewardMintStep =
  | { kind: 'keep'; networkId: string; mint: PublicKey }
  | { kind: 'create'; networkId: string; decimals: number }

function unsetWhenEmpty<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema)
}

const rewardMintEnvSchema = z.object({
  SEED_KEYPAIR: z.string().min(1),
  DEVNET_RPC_URL: unsetWhenEmpty(
    z.url({ protocol: /^https?$/ }).default('https://api.devnet.solana.com'),
  ),
  REWARD_MINT_AUTHORITY: solanaAddressSchema,
  VITE_REWARD_MINTS: rewardMintsSchema,
})

export function parseRewardMintConfig(env: unknown): RewardMintConfig {
  const parsed = rewardMintEnvSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`reward mint config: ${problems.join('; ')}`)
  }
  const values = parsed.data
  return {
    keypairPath: values.SEED_KEYPAIR,
    rpcUrl: values.DEVNET_RPC_URL,
    authority: new PublicKey(values.REWARD_MINT_AUTHORITY),
    existing: values.VITE_REWARD_MINTS,
  }
}

export function rewardMintPlan(input: {
  networks: readonly { id: string; decimals: number }[]
  authority: PublicKey
  existing: ReadonlyMap<string, MintState | null>
}): RewardMintStep[] {
  const { networks, authority, existing } = input
  for (const networkId of existing.keys()) {
    if (!networks.some((network) => network.id === networkId)) {
      throw new Error(`VITE_REWARD_MINTS lists ${networkId}, which is not a supported network`)
    }
  }
  return networks.map((network): RewardMintStep => {
    if (!existing.has(network.id)) {
      return { kind: 'create', networkId: network.id, decimals: network.decimals }
    }
    const mint = existing.get(network.id) ?? null
    if (mint === null) {
      throw new Error(`the ${network.id} mint in VITE_REWARD_MINTS was not found on chain`)
    }
    if (mint.decimals !== network.decimals) {
      throw new Error(
        `the ${network.id} mint has ${mint.decimals} decimals, its mainnet token has ${network.decimals} decimals`,
      )
    }
    if (mint.mintAuthority?.equals(authority) !== true) {
      throw new Error(
        `the ${network.id} mint has another mint authority than REWARD_MINT_AUTHORITY ${authority.toBase58()}`,
      )
    }
    return { kind: 'keep', networkId: network.id, mint: mint.address }
  })
}

async function main(): Promise<number> {
  const config = parseRewardMintConfig(process.env)
  const payer = readKeypair(config.keypairPath)
  const connection = new Connection(config.rpcUrl, 'confirmed')

  const existing = new Map<string, MintState | null>()
  for (const [networkId, address] of config.existing) {
    const account = await connection.getAccountInfo(address)
    existing.set(networkId, account === null ? null : decodeMint(address, account))
  }
  const steps = rewardMintPlan({
    networks: [...SUPPORTED_NETWORKS.values()].map((network) => ({
      id: network.id,
      decimals: network.token.decimals,
    })),
    authority: config.authority,
    existing,
  })

  const mints = new Map<string, PublicKey>()
  for (const step of steps) {
    if (step.kind === 'keep') {
      mints.set(step.networkId, step.mint)
      console.log(`kept ${step.networkId} mint ${step.mint.toBase58()}`)
      continue
    }
    const created = Keypair.generate()
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: created.publicKey,
          lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
          space: MINT_SIZE,
          programId: utils.token.TOKEN_PROGRAM_ID,
        }),
        initializeMintInstruction({
          mint: created.publicKey,
          decimals: step.decimals,
          authority: config.authority,
        }),
      ),
      [payer, created],
    )
    mints.set(step.networkId, created.publicKey)
    console.log(`created ${step.networkId} mint ${created.publicKey.toBase58()}`)
  }
  console.log(`VITE_REWARD_MINTS=${formatRewardMints(mints)}`)
  return 0
}

if (import.meta.main) {
  // process.exit after RPC traffic trips a libuv assertion on Windows under Node 26.
  process.exitCode = await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    return 1
  })
}
