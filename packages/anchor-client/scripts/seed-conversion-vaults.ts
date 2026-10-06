// Opens the devnet conversion vault of every reward token in VITE_REWARD_MINTS and keeps
// its stablecoin topped up, so that a withholding has a market to sell into.
//
//   SEED_KEYPAIR=<path to keypair json> SEED_AMOUNT=<whole tokens> pnpm seed:conversion-vaults
//
// The wallet has to be the pool authority, and the mint authority of the test stablecoin
// to top a vault up. A vault already open is checked and kept: its spread and tolerance
// cannot be changed after creation, so a mismatch is an error rather than a silent keep.
import { utils } from '@coral-xyz/anchor'
import { solanaAddressSchema } from '@drf/shared/schemas'
import {
  Connection,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js'
import { z } from 'zod'
import { type ConversionVaultAccount, fetchConversionVault, fetchPool } from '../src/accounts.ts'
import { rewardFloatProgram } from '../src/index.ts'
import {
  conversionRewardVaultAddress,
  conversionStableVaultAddress,
  conversionVaultAddress,
  poolAddress,
  rewardFloatProgramId,
} from '../src/pda.ts'
import { rewardMintsSchema } from '../src/reward-mints.ts'
import { mintToInstruction } from '../src/token.ts'
import { decodeMint, type MintState, parseAmount, readKeypair } from './seed-pool.ts'

export type ConversionVaultConfig = {
  keypairPath: string
  rpcUrl: string
  stableMint: PublicKey
  rewardMints: ReadonlyMap<string, PublicKey>
  amount: string
  spreadBps: number
  maxSlippageBps: number
}
export type ConversionVaultState = {
  rewardMint: PublicKey
  vault: ConversionVaultAccount | null
  balance: bigint
}
export type ConversionVaultStep =
  | { kind: 'keep'; networkId: string; rewardMint: PublicKey }
  | { kind: 'create'; networkId: string; rewardMint: PublicKey }
  | { kind: 'top-up'; networkId: string; rewardMint: PublicKey; amount: bigint }

function unsetWhenEmpty<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema)
}

// Below 10 000, as init_conversion_vault requires: the program would refuse anything else.
const bps = (fallback: number) =>
  unsetWhenEmpty(z.coerce.number().int().min(0).max(9_999).default(fallback))

const conversionVaultEnvSchema = z.object({
  SEED_KEYPAIR: z.string().min(1),
  SEED_AMOUNT: z.string().regex(/^\d+(\.\d+)?$/, 'expected a number of whole tokens'),
  DEVNET_RPC_URL: unsetWhenEmpty(
    z.url({ protocol: /^https?$/ }).default('https://api.devnet.solana.com'),
  ),
  STABLE_MINT: solanaAddressSchema,
  VITE_REWARD_MINTS: rewardMintsSchema.pipe(
    z.custom<Map<string, PublicKey>>(
      (mints) => mints instanceof Map && mints.size > 0,
      'expected at least one network:mint pair',
    ),
  ),
  // About a DEX pool fee: a quote sits a little under the attested rate, as a market's
  // would, and well inside the tolerance.
  CONVERSION_SPREAD_BPS: bps(30),
  CONVERSION_MAX_SLIPPAGE_BPS: bps(100),
})

export function parseConversionVaultConfig(env: unknown): ConversionVaultConfig {
  const parsed = conversionVaultEnvSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`conversion vault config: ${problems.join('; ')}`)
  }
  const values = parsed.data
  return {
    keypairPath: values.SEED_KEYPAIR,
    rpcUrl: values.DEVNET_RPC_URL,
    stableMint: new PublicKey(values.STABLE_MINT),
    rewardMints: values.VITE_REWARD_MINTS,
    amount: values.SEED_AMOUNT,
    spreadBps: values.CONVERSION_SPREAD_BPS,
    maxSlippageBps: values.CONVERSION_MAX_SLIPPAGE_BPS,
  }
}

export function conversionVaultPlan(input: {
  wallet: PublicKey
  poolAuthority: PublicKey | null
  stableMint: MintState
  target: bigint
  spreadBps: number
  maxSlippageBps: number
  vaults: ReadonlyMap<string, ConversionVaultState>
}): ConversionVaultStep[] {
  const { wallet, poolAuthority, stableMint, target, spreadBps, maxSlippageBps, vaults } = input
  if (vaults.size === 0) throw new Error('VITE_REWARD_MINTS lists no reward token')
  if (poolAuthority === null) {
    throw new Error(
      `there is no pool for ${stableMint.address.toBase58()} yet: run seed:pool first`,
    )
  }
  const steps: ConversionVaultStep[] = []
  for (const [networkId, { rewardMint, vault, balance }] of vaults) {
    if (vault === null) {
      if (!poolAuthority.equals(wallet)) {
        throw new Error(
          `opening the ${networkId} vault needs the pool authority ${poolAuthority.toBase58()}`,
        )
      }
      steps.push({ kind: 'create', networkId, rewardMint })
    } else if (vault.spreadBps !== spreadBps) {
      throw new Error(
        `the ${networkId} vault was opened with spread ${vault.spreadBps} bps, the config asks for ${spreadBps}`,
      )
    } else if (vault.maxSlippageBps !== maxSlippageBps) {
      throw new Error(
        `the ${networkId} vault was opened with tolerance ${vault.maxSlippageBps} bps, the config asks for ${maxSlippageBps}`,
      )
    }
    const shortfall = target - balance
    if (shortfall <= 0n) {
      steps.push({ kind: 'keep', networkId, rewardMint })
      continue
    }
    if (stableMint.mintAuthority?.equals(wallet) !== true) {
      throw new Error(
        `the ${networkId} vault holds ${balance} base units, ${target} are wanted, and the wallet may not mint the stablecoin`,
      )
    }
    steps.push({ kind: 'top-up', networkId, rewardMint, amount: shortfall })
  }
  return steps
}

async function main(): Promise<number> {
  const config = parseConversionVaultConfig(process.env)
  const wallet = readKeypair(config.keypairPath)
  const connection = new Connection(config.rpcUrl, 'confirmed')
  const program = rewardFloatProgram(connection)

  const deployed = await connection.getAccountInfo(rewardFloatProgramId)
  if (deployed === null || !deployed.executable) {
    throw new Error(
      `reward-float is not deployed at ${rewardFloatProgramId.toBase58()} on ${config.rpcUrl}`,
    )
  }
  const mintAccount = await connection.getAccountInfo(config.stableMint)
  if (mintAccount === null) {
    throw new Error(`STABLE_MINT ${config.stableMint.toBase58()} not found`)
  }
  const stableMint = decodeMint(config.stableMint, mintAccount)
  const pool = poolAddress(stableMint.address)
  const poolAuthority =
    (await connection.getAccountInfo(pool)) === null
      ? null
      : (await fetchPool(connection, pool)).account.authority

  const vaults = new Map<string, ConversionVaultState>()
  for (const [networkId, rewardMint] of config.rewardMints) {
    const vault = await fetchConversionVault(connection, conversionVaultAddress(pool, rewardMint))
    const balance =
      vault === null
        ? 0n
        : BigInt((await connection.getTokenAccountBalance(vault.stableVault)).value.amount)
    vaults.set(networkId, { rewardMint, vault, balance })
  }
  const steps = conversionVaultPlan({
    wallet: wallet.publicKey,
    poolAuthority,
    stableMint,
    target: parseAmount(config.amount, stableMint.decimals),
    spreadBps: config.spreadBps,
    maxSlippageBps: config.maxSlippageBps,
    vaults,
  })

  for (const step of steps) {
    const conversionVault = conversionVaultAddress(pool, step.rewardMint)
    if (step.kind === 'keep') {
      console.log(`kept ${step.networkId} vault ${conversionVault.toBase58()}`)
      continue
    }
    const ix =
      step.kind === 'create'
        ? await program.methods
            .initConversionVault(config.spreadBps, config.maxSlippageBps)
            .accountsStrict({
              authority: wallet.publicKey,
              pool,
              conversionVault,
              rewardMint: step.rewardMint,
              stableMint: stableMint.address,
              stableVault: conversionStableVaultAddress(conversionVault),
              rewardVault: conversionRewardVaultAddress(conversionVault),
              tokenProgram: utils.token.TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .instruction()
        : mintToInstruction({
            mint: stableMint.address,
            destination: conversionStableVaultAddress(conversionVault),
            authority: wallet.publicKey,
            amount: step.amount,
          })
    const signature = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [
      wallet,
    ])
    console.log(
      step.kind === 'create'
        ? `opened ${step.networkId} vault ${conversionVault.toBase58()}: ${signature}`
        : `topped up ${step.networkId} vault with ${step.amount} base units: ${signature}`,
    )
  }
  return 0
}

if (import.meta.main) {
  // process.exit after RPC traffic trips a libuv assertion on Windows under Node 26.
  process.exitCode = await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    return 1
  })
}
