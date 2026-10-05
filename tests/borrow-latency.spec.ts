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
  loanAddress,
  mintToInstruction,
  type OnChain,
  type PoolAccount,
  poolAddress,
  repayInstruction,
  rewardFloatProgram,
} from '@drf/anchor-client'
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

// SC-004: a loan is one transaction, confirmed in under five seconds. Measured from the
// moment the signed transaction is sent until devnet reports it `confirmed`, the way the
// borrow page waits for it; what comes before (attestation, reads, building) is printed
// for reference only. Spends devnet SOL, so it runs on demand: `pnpm bench:borrow`.
const BUDGET_MS = 5_000
const SAMPLES = 20
// Every sample is a borrow and a repay from one IP. Back to back, the public endpoint
// starts answering 429 to our own burst, and the run would measure its rate limit.
const SPACING_MS = 10_000
const AMOUNT = 10_000_000n
const OPERATOR_LAMPORTS = 100_000_000
// Interest on AMOUNT for the seconds a sample stays open is far below one cent; this is
// what lets every repay close its loan in full.
const INTEREST_FLOAT = 1_000_000n

const envFile = path.join(import.meta.dirname, '..', '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const benchEnvSchema = z.object({
  SEED_KEYPAIR: z.string().min(1),
  STABLE_MINT: solanaAddressSchema,
  ATTESTOR_SECRET_KEY: z.string().min(1),
  ATTESTOR_PUBLIC_KEY: solanaAddressSchema,
  // The endpoint the borrow page itself uses unless a build sets another.
  VITE_DEVNET_RPC_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.url({ protocol: /^https?$/ }).default('https://api.devnet.solana.com'),
  ),
})
const parsed = benchEnvSchema.safeParse(process.env)

const keypairSchema = z.array(z.number().int().min(0).max(255)).length(64)

function readKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(keypairSchema.parse(JSON.parse(readFileSync(file, 'utf8')))),
  )
}

describe.skipIf(!parsed.success)(
  'SC-004 — a loan in one transaction, confirmed in under 5 s',
  () => {
    const env = parsed.success ? parsed.data : undefined
    const operator = Keypair.generate()
    let connection: Connection
    let funder: Keypair
    let pool: OnChain<PoolAccount>

    const send = (instructions: TransactionInstruction[], signers: Keypair[]) =>
      sendAndConfirmTransaction(connection, new Transaction().add(...instructions), signers, {
        commitment: 'confirmed',
      })

    beforeAll(async () => {
      if (env === undefined) return
      connection = new Connection(env.VITE_DEVNET_RPC_URL, 'confirmed')
      funder = readKeypair(env.SEED_KEYPAIR)
      pool = await fetchPool(connection, poolAddress(new PublicKey(env.STABLE_MINT)))
      expect(pool.account.attestor.toBase58()).toBe(env.ATTESTOR_PUBLIC_KEY)
      expect(pool.account.totalDeposits - pool.account.totalBorrowed).toBeGreaterThanOrEqual(AMOUNT)

      // Borrow creates the operator's stablecoin account itself, idempotently; it is made
      // here first only so that the float for interest has somewhere to go.
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
        ],
        [funder],
      )
    })

    afterAll(async () => {
      if (env === undefined) return
      // Whatever the run did not spend goes back; loans keep their rent, they are never
      // closed (a repaid loan's address is what stops its nonce from being used twice).
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

    it('confirms a borrow within the budget at p95, every one a single transaction', async () => {
      if (env === undefined) return
      const program = rewardFloatProgram(connection)
      const attestor = {
        secretKey: base58.decode(env.ATTESTOR_SECRET_KEY),
        address: env.ATTESTOR_PUBLIC_KEY,
      }
      const operatorAddress = solanaAddressSchema.parse(operator.publicKey.toBase58())
      const confirmed: number[] = []
      const prepared: number[] = []

      for (let sample = 1; sample <= SAMPLES; sample += 1) {
        const nonce = BigInt(sample)
        const startedAt = performance.now()
        const attestation = await attestationFor({
          operator: operatorAddress,
          attestor,
          limitBaseUnits: AMOUNT,
          nonce,
          at: new Date(),
        })
        const current = await fetchPool(connection, pool.address)
        const instructions = await borrowInstructions(program, {
          operator: operator.publicKey,
          pool: current,
          attestation,
          // Every earlier sample was repaid in full, so nothing is open.
          openLoans: [],
          // The reward token only matters to a sweep, and these loans never see one.
          rewardMint: current.account.stableMint,
          amount: AMOUNT,
          termPeriods: 1,
          sweepBps: 5_000,
          maxAprBps: 65_535,
        })
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
        const transaction = new Transaction({
          feePayer: operator.publicKey,
          blockhash,
          lastValidBlockHeight,
        }).add(...instructions)
        transaction.sign(operator)
        const signed = transaction.serialize()

        const sentAt = performance.now()
        const signature = await connection.sendRawTransaction(signed)
        const confirmation = await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed',
        )
        const doneAt = performance.now()
        expect(confirmation.value.err).toBeNull()
        prepared.push(sentAt - startedAt)
        confirmed.push(doneAt - sentAt)

        // One transaction: the loan exists, and it is the one this signature opened.
        const loan = loanAddress(operator.publicKey, nonce)
        const account = await connection.getAccountInfo(loan, 'confirmed')
        if (account === null) throw new Error(`sample ${sample}: no loan at ${loan.toBase58()}`)
        const opened = decodeLoan(account.data)
        expect(opened.principal).toBe(AMOUNT)

        await send(
          [
            await repayInstruction(program, {
              payer: operator.publicKey,
              pool: current,
              loan: { address: loan, account: opened },
              maxAmount: AMOUNT + INTEREST_FLOAT,
            }),
          ],
          [operator],
        )
        if (sample < SAMPLES) await sleep(Math.max(0, SPACING_MS - (performance.now() - startedAt)))
      }

      console.log(`rpc: ${new URL(env.VITE_DEVNET_RPC_URL).host}`)
      console.log(summarise('SC-004 prepare (reference)', prepared))
      console.log(summarise('SC-004 send → confirmed', confirmed))
      expect(percentile(confirmed, 0.95)).toBeLessThan(BUDGET_MS)
    })
  },
)
