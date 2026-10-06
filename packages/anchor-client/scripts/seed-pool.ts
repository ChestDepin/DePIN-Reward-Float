// Puts lender liquidity into the devnet pool through the program's own `deposit`, so that
// borrowing on devnet has something to lend and every unit of it is on the share books
// (SC-007). Creates whatever is missing on the way: a test stablecoin, the pool, tokens
// in the wallet. Deploying the program itself stays a separate step.
//
//   SEED_KEYPAIR=<path to keypair json> SEED_AMOUNT=<whole tokens> pnpm seed:pool
//
// DEVNET_RPC_URL, STABLE_MINT and ATTESTOR_PUBLIC_KEY are read from .env as the api and
// the keeper read them. With STABLE_MINT unset, a new mint is created and printed.
import { readFileSync } from 'node:fs'
import { utils } from '@coral-xyz/anchor'
import { solanaAddressSchema } from '@drf/shared/schemas'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import { z } from 'zod'
import { fetchPool } from '../src/accounts.ts'
import { depositInstruction } from '../src/deposit.ts'
import { rewardFloatProgram } from '../src/index.ts'
import { poolAddress, rewardFloatProgramId, vaultAddress } from '../src/pda.ts'
import {
  createAssociatedTokenAccountIdempotent,
  fetchStableBalance,
  mintToInstruction,
} from '../src/token.ts'

const TOKEN_PROGRAM_ID = utils.token.TOKEN_PROGRAM_ID
const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
export const MINT_SIZE = 82
const INITIALIZE_MINT_2 = 20
// What USDC has, so amounts read the same on devnet as they would on mainnet.
const STABLE_DECIMALS = 6

export type SeedConfig = {
  keypairPath: string
  rpcUrl: string
  stableMint: PublicKey | null
  attestor: PublicKey | null
  amount: string
  baseAprBps: number
  slopeAprBps: number
}
export type MintState = { address: PublicKey; decimals: number; mintAuthority: PublicKey | null }
export type SeedState = { mint: MintState | null; poolExists: boolean; balance: bigint }
export type SeedStep =
  | { kind: 'create-mint' }
  | { kind: 'initialize-pool'; attestor: PublicKey }
  | { kind: 'mint-to'; amount: bigint }
  | { kind: 'deposit'; amount: bigint }

// An .env line left as `STABLE_MINT=` means "not set", the same as in the web build.
function unsetWhenEmpty<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema)
}

const bps = (fallback: number) =>
  unsetWhenEmpty(z.coerce.number().int().min(0).max(65_535).default(fallback))

const seedEnvSchema = z.object({
  SEED_KEYPAIR: z.string().min(1),
  SEED_AMOUNT: z.string().regex(/^\d+(\.\d+)?$/, 'expected a number of whole tokens'),
  DEVNET_RPC_URL: unsetWhenEmpty(
    z.url({ protocol: /^https?$/ }).default('https://api.devnet.solana.com'),
  ),
  STABLE_MINT: unsetWhenEmpty(solanaAddressSchema.optional()),
  ATTESTOR_PUBLIC_KEY: unsetWhenEmpty(solanaAddressSchema.optional()),
  SEED_BASE_APR_BPS: bps(800),
  SEED_SLOPE_APR_BPS: bps(2000),
})

export function parseSeedConfig(env: unknown): SeedConfig {
  const parsed = seedEnvSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`seed config: ${problems.join('; ')}`)
  }
  const values = parsed.data
  return {
    keypairPath: values.SEED_KEYPAIR,
    rpcUrl: values.DEVNET_RPC_URL,
    stableMint: values.STABLE_MINT === undefined ? null : new PublicKey(values.STABLE_MINT),
    attestor:
      values.ATTESTOR_PUBLIC_KEY === undefined ? null : new PublicKey(values.ATTESTOR_PUBLIC_KEY),
    amount: values.SEED_AMOUNT,
    baseAprBps: values.SEED_BASE_APR_BPS,
    slopeAprBps: values.SEED_SLOPE_APR_BPS,
  }
}

export function parseAmount(raw: string, decimals: number): bigint {
  const [whole = '', fraction = ''] = raw.split('.')
  if (fraction.length > decimals) {
    throw new Error(`${raw} has more than the mint's ${decimals} decimals`)
  }
  const amount = BigInt(whole + fraction.padEnd(decimals, '0'))
  if (amount === 0n) throw new Error('the amount must be greater than zero')
  return amount
}

export function decodeMint(
  address: PublicKey,
  account: { owner: PublicKey; data: Buffer },
): MintState {
  const { owner, data } = account
  if (!owner.equals(TOKEN_PROGRAM_ID) || data.length !== MINT_SIZE || data[45] !== 1) {
    throw new Error(`${address.toBase58()} is not a token mint`)
  }
  return {
    address,
    decimals: data.readUInt8(44),
    mintAuthority: data.readUInt32LE(0) === 1 ? new PublicKey(data.subarray(4, 36)) : null,
  }
}

export function seedPlan(input: {
  wallet: PublicKey
  attestor: PublicKey | null
  amount: bigint
  state: SeedState
}): SeedStep[] {
  const { wallet, attestor, amount, state } = input
  const steps: SeedStep[] = []
  if (state.mint === null) steps.push({ kind: 'create-mint' })
  if (!state.poolExists) {
    if (attestor === null) {
      throw new Error(
        'the pool does not exist yet, and creating it needs ATTESTOR_PUBLIC_KEY: the key the api signs credit limits with',
      )
    }
    steps.push({ kind: 'initialize-pool', attestor })
  }
  const shortfall = amount - state.balance
  if (shortfall > 0n) {
    const mayMint = state.mint === null || state.mint.mintAuthority?.equals(wallet) === true
    if (!mayMint) {
      throw new Error(
        `the wallet holds ${state.balance} base units of the stablecoin, ${amount} are needed, and it may not mint more`,
      )
    }
    steps.push({ kind: 'mint-to', amount: shortfall })
  }
  steps.push({ kind: 'deposit', amount })
  return steps
}

// Written out like the token instructions in src/token.ts rather than pulling in
// @solana/spl-token for a devnet script.
export function initializeMintInstruction(input: {
  mint: PublicKey
  decimals: number
  authority: PublicKey
}): TransactionInstruction {
  const noFreezeAuthority = 0
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: input.mint, isSigner: false, isWritable: true }],
    data: Buffer.from([
      INITIALIZE_MINT_2,
      input.decimals,
      ...input.authority.toBytes(),
      noFreezeAuthority,
    ]),
  })
}

const keypairSchema = z.array(z.number().int().min(0).max(255)).length(64)

export function readKeypair(path: string): Keypair {
  const bytes = keypairSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  return Keypair.fromSecretKey(Uint8Array.from(bytes))
}

async function main(): Promise<number> {
  const config = parseSeedConfig(process.env)
  const wallet = readKeypair(config.keypairPath)
  const connection = new Connection(config.rpcUrl, 'confirmed')
  const program = rewardFloatProgram(connection)
  const send = (instructions: TransactionInstruction[], signers: Keypair[] = []) =>
    sendAndConfirmTransaction(connection, new Transaction().add(...instructions), [
      wallet,
      ...signers,
    ])

  const deployed = await connection.getAccountInfo(rewardFloatProgramId)
  if (deployed === null || !deployed.executable) {
    throw new Error(
      `reward-float is not deployed at ${rewardFloatProgramId.toBase58()} on ${config.rpcUrl}`,
    )
  }

  let mint: MintState | null = null
  if (config.stableMint !== null) {
    const account = await connection.getAccountInfo(config.stableMint)
    if (account === null) throw new Error(`STABLE_MINT ${config.stableMint.toBase58()} not found`)
    mint = decodeMint(config.stableMint, account)
  }
  const amount = parseAmount(config.amount, mint?.decimals ?? STABLE_DECIMALS)
  const steps = seedPlan({
    wallet: wallet.publicKey,
    attestor: config.attestor,
    amount,
    state: {
      mint,
      poolExists:
        mint !== null && (await connection.getAccountInfo(poolAddress(mint.address))) !== null,
      balance:
        mint === null ? 0n : await fetchStableBalance(connection, wallet.publicKey, mint.address),
    },
  })

  let stableMint = mint?.address ?? null
  for (const step of steps) {
    if (step.kind === 'create-mint') {
      const created = Keypair.generate()
      await send(
        [
          SystemProgram.createAccount({
            fromPubkey: wallet.publicKey,
            newAccountPubkey: created.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
            space: MINT_SIZE,
            programId: TOKEN_PROGRAM_ID,
          }),
          initializeMintInstruction({
            mint: created.publicKey,
            decimals: STABLE_DECIMALS,
            authority: wallet.publicKey,
          }),
        ],
        [created],
      )
      stableMint = created.publicKey
      console.log(`created stablecoin ${stableMint.toBase58()}`)
      continue
    }
    if (stableMint === null) throw new Error('no stablecoin to seed the pool with')
    const pool = poolAddress(stableMint)
    if (step.kind === 'initialize-pool') {
      const [programData] = PublicKey.findProgramAddressSync(
        [rewardFloatProgramId.toBuffer()],
        BPF_LOADER_UPGRADEABLE,
      )
      const ix = await program.methods
        .initializePool(step.attestor, config.baseAprBps, config.slopeAprBps)
        .accountsStrict({
          authority: wallet.publicKey,
          pool,
          stableMint,
          vault: vaultAddress(pool),
          programData,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
      await send([ix])
      console.log(`created pool ${pool.toBase58()}`)
    } else if (step.kind === 'mint-to') {
      await send([
        createAssociatedTokenAccountIdempotent({
          payer: wallet.publicKey,
          owner: wallet.publicKey,
          mint: stableMint,
        }),
        mintToInstruction({
          mint: stableMint,
          destination: utils.token.associatedAddress({ mint: stableMint, owner: wallet.publicKey }),
          authority: wallet.publicKey,
          amount: step.amount,
        }),
      ])
      console.log(`minted ${step.amount} base units to the wallet`)
    } else {
      const ix = await depositInstruction(program, {
        lender: wallet.publicKey,
        pool: await fetchPool(connection, pool),
        amount: step.amount,
      })
      const signature = await send([ix])
      console.log(`deposited ${step.amount} base units: ${signature}`)
    }
  }

  if (stableMint !== null) {
    const { account } = await fetchPool(connection, poolAddress(stableMint))
    console.log(
      `pool ${poolAddress(stableMint).toBase58()}: ${account.totalDeposits} deposited, ${account.totalShares} shares, ${account.totalBorrowed} lent out`,
    )
    console.log(`VITE_STABLE_MINT=${stableMint.toBase58()}`)
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
