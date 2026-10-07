import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  associatedTokenAddress,
  borrowInstructions,
  createAssociatedTokenAccountIdempotent,
  decodeLoan,
  fetchPool,
  type LoanAccount,
  loanAddress,
  mintToInstruction,
  poolAddress,
  repayInstruction,
  rewardFloatProgram,
  rewardMintsSchema,
  sweepEvents,
} from '@drf/anchor-client'
import { issuedRateAttestationSchema } from '@drf/shared/api'
import { solanaAddressSchema } from '@drf/shared/schemas'
import { base58 } from '@scure/base'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { attestationFor } from './borrow-attestation.ts'
import { percentile, summarise } from './latency.ts'
import { pollUntil } from './poll.ts'

// SC-005: a reward is withheld within two minutes of arriving. Measured as the operator
// would see it: from the payout `confirmed` until a read of the loan shows less debt.
// The keeper is not started here: what is measured is the one already running, and every
// sweep must be signed by its key, or the run would count someone else's. Spends devnet
// SOL and tokens, so it runs on demand: `pnpm bench:sweep`.
const BUDGET_MS = 120_000
const SAMPLES = 10
const POLL_MS = 1_000
// Payouts back to back would each land on the keeper's tick at the same phase.
const SPACING_MS = 5_000
const AMOUNT = 1_000_000n
// Half of it is withheld per payout, about a cent at the stand-in's rate: ten of them
// leave the loan open, so every sample measures a withholding and not a closed loan.
const PAYOUT = 10_000_000_000n
const SWEEP_BPS = 5_000
const OPERATOR_LAMPORTS = 50_000_000
const INTEREST_FLOAT = 1_000_000n

const envFile = path.join(import.meta.dirname, '..', '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const seedSchema = z
  .string()
  .transform((value) => base58.decode(value))
  .refine((bytes) => bytes.length === 32, 'expected a base58 32-byte seed')

const benchEnvSchema = z.object({
  SEED_KEYPAIR: z.string().min(1),
  // The stand-in reward mint's authority: the payouts are minted, as a reward program
  // would send them.
  REWARD_KEYPAIR: z.string().min(1),
  STABLE_MINT: solanaAddressSchema,
  ATTESTOR_SECRET_KEY: z.string().min(1),
  ATTESTOR_PUBLIC_KEY: solanaAddressSchema,
  // Only its public key is used, to tell the keeper's sweeps from anyone else's.
  KEEPER_SECRET_KEY: seedSchema,
  VITE_REWARD_MINTS: rewardMintsSchema.refine((mints) => mints.size > 0, 'no reward mint'),
  VITE_DEVNET_RPC_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.url({ protocol: /^https?$/ }).default('https://api.devnet.solana.com'),
  ),
  // The keeper lives in the api process, so the deployed api is the system under test;
  // the borrow takes its rate from there too, the one the keeper sweeps at.
  VITE_API_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.url({ protocol: /^https?$/ }).default('https://depin-reward-float-api.onrender.com'),
  ),
})
const parsed = benchEnvSchema.safeParse(process.env)

const keypairSchema = z.array(z.number().int().min(0).max(255)).length(64)

function readKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(keypairSchema.parse(JSON.parse(readFileSync(file, 'utf8')))),
  )
}

const debt = (loan: LoanAccount) => loan.outstanding + loan.accruedInterest

describe.skipIf(!parsed.success)('SC-005 — a reward withheld within 2 min of arriving', () => {
  const env = parsed.success ? parsed.data : undefined
  const operator = Keypair.generate()
  const loan = loanAddress(operator.publicKey, 1n)
  let connection: Connection
  let funder: Keypair
  let rewards: Keypair
  let keeper: PublicKey
  let rewardMint: PublicKey
  let borrowed = false

  const send = (instructions: TransactionInstruction[], signers: Keypair[]) =>
    sendAndConfirmTransaction(connection, new Transaction().add(...instructions), signers, {
      commitment: 'confirmed',
    })

  const readLoan = async () => {
    const account = await connection.getAccountInfo(loan, 'confirmed')
    if (account === null) throw new Error(`no loan at ${loan.toBase58()}`)
    return decodeLoan(account.data)
  }

  const fetchRate = async (mint: PublicKey) => {
    if (env === undefined) throw new Error('no environment')
    const response = await fetch(new URL('/v1/attestations/rate', env.VITE_API_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rewardMint: mint.toBase58() }),
    })
    if (response.status !== 201) throw new Error(`rate: ${response.status}`)
    return issuedRateAttestationSchema.parse(await response.json())
  }

  const transactionOf = async (signature: string) => {
    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    if (transaction === null) throw new Error(`no transaction ${signature}`)
    return transaction
  }

  beforeAll(async () => {
    if (env === undefined) return
    connection = new Connection(env.VITE_DEVNET_RPC_URL, 'confirmed')
    funder = readKeypair(env.SEED_KEYPAIR)
    rewards = readKeypair(env.REWARD_KEYPAIR)
    keeper = Keypair.fromSeed(env.KEEPER_SECRET_KEY).publicKey
    const [first] = [...env.VITE_REWARD_MINTS.values()]
    if (first === undefined) throw new Error('no reward mint')
    rewardMint = first

    const pool = await fetchPool(connection, poolAddress(new PublicKey(env.STABLE_MINT)))
    expect(pool.account.attestor.toBase58()).toBe(env.ATTESTOR_PUBLIC_KEY)
    expect(pool.account.totalDeposits - pool.account.totalBorrowed).toBeGreaterThanOrEqual(AMOUNT)

    const stable = pool.account.stableMint
    await send(
      [
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: operator.publicKey,
          lamports: OPERATOR_LAMPORTS,
        }),
        createAssociatedTokenAccountIdempotent({
          payer: funder.publicKey,
          owner: operator.publicKey,
          mint: stable,
        }),
        mintToInstruction({
          mint: stable,
          destination: associatedTokenAddress(stable, operator.publicKey),
          authority: funder.publicKey,
          amount: INTEREST_FLOAT,
        }),
        createAssociatedTokenAccountIdempotent({
          payer: funder.publicKey,
          owner: operator.publicKey,
          mint: rewardMint,
        }),
      ],
      [funder],
    )

    const attestor = {
      secretKey: base58.decode(env.ATTESTOR_SECRET_KEY),
      address: env.ATTESTOR_PUBLIC_KEY,
    }
    const instructions = await borrowInstructions(rewardFloatProgram(connection), {
      operator: operator.publicKey,
      pool,
      attestation: await attestationFor({
        operator: solanaAddressSchema.parse(operator.publicKey.toBase58()),
        attestor,
        limitBaseUnits: AMOUNT,
        nonce: 1n,
        at: new Date(),
      }),
      rate: await fetchRate(rewardMint),
      openLoans: [],
      rewardMint,
      amount: AMOUNT,
      termPeriods: 1,
      sweepBps: SWEEP_BPS,
      maxAprBps: 65_535,
    })
    await send(instructions, [operator])
    borrowed = true
  })

  afterAll(async () => {
    if (env === undefined) return
    // The loan is closed whatever the run did, so no keeper keeps sweeping into it.
    if (borrowed) {
      const pool = await fetchPool(connection, poolAddress(new PublicKey(env.STABLE_MINT)))
      await send(
        [
          await repayInstruction(rewardFloatProgram(connection), {
            payer: operator.publicKey,
            pool,
            loan: { address: loan, account: await readLoan() },
            maxAmount: AMOUNT + INTEREST_FLOAT,
          }),
        ],
        [operator],
      )
    }
    const left = await connection.getBalance(operator.publicKey)
    const fee = 5_000
    if (left > fee) {
      await send(
        [
          SystemProgram.transfer({
            fromPubkey: operator.publicKey,
            toPubkey: funder.publicKey,
            lamports: left - fee,
          }),
        ],
        [operator],
      )
    }
  })

  it(
    'withholds every payout within the budget, each sweep the keeper’s',
    async () => {
      if (env === undefined) return
      const rewardAccount = associatedTokenAddress(rewardMint, operator.publicKey)
      const seen: number[] = []
      const onChain: number[] = []

      for (let sample = 1; sample <= SAMPLES; sample += 1) {
        const before = debt(await readLoan())
        const payout = await send(
          [
            mintToInstruction({
              mint: rewardMint,
              destination: rewardAccount,
              authority: rewards.publicKey,
              amount: PAYOUT,
            }),
          ],
          [funder, rewards],
        )
        const arrivedAt = performance.now()

        const drop = await pollUntil({
          read: readLoan,
          done: (current) => debt(current) < before,
          since: arrivedAt,
          intervalMs: POLL_MS,
          timeoutMs: BUDGET_MS,
          now: () => performance.now(),
          sleep: (ms) => sleep(ms),
        })
        if (drop === null) {
          throw new Error(`sample ${sample}: payout ${payout} not withheld within ${BUDGET_MS} ms`)
        }
        seen.push(drop.at - arrivedAt)

        // Nothing but a sweep writes to the loan between payouts, so the newest signature
        // on it is the one that lowered the debt.
        const [newest] = await connection.getSignaturesForAddress(loan, { limit: 1 }, 'confirmed')
        if (newest === undefined) throw new Error(`sample ${sample}: no signature on the loan`)
        const sweep = await transactionOf(newest.signature)
        expect(sweep.transaction.message.staticAccountKeys[0]?.toBase58()).toBe(keeper.toBase58())
        const swept = sweepEvents(sweep.meta?.logMessages ?? [])
          .filter((event) => event.kind === 'swept')
          .find((event) => event.loan.equals(loan))
        expect(swept?.withheld).toBeGreaterThan(0n)

        const arrived = await transactionOf(payout)
        if (typeof sweep.blockTime === 'number' && typeof arrived.blockTime === 'number') {
          onChain.push((sweep.blockTime - arrived.blockTime) * 1_000)
        }

        if (sample < SAMPLES) await sleep(SPACING_MS)
      }

      console.log(`rpc: ${new URL(env.VITE_DEVNET_RPC_URL).host}, keeper: ${keeper.toBase58()}`)
      console.log(summarise('SC-005 payout confirmed → lower debt read', seen))
      if (onChain.length > 0) {
        console.log(summarise('SC-005 block time payout → sweep (reference)', onChain))
      }
      expect(percentile(seen, 1)).toBeLessThan(BUDGET_MS)
    },
    SAMPLES * (BUDGET_MS + SPACING_MS) + 120_000,
  )
})
