import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  decodeLoan,
  fetchPool,
  mintToInstruction,
  poolAddress,
  repayInstruction,
  rewardFloatProgram,
  rewardMintsSchema,
  sweepEvents,
} from '@drf/anchor-client'
import { createDatabase, type Database, networks as networksTable } from '@drf/db'
import { issuedRateAttestationSchema } from '@drf/shared/api'
import { rewardNetworkSchema, solanaAddressSchema } from '@drf/shared/schemas'
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
import { eq } from 'drizzle-orm'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { demoHistory, payoutToRepay, seedDemoHistory, wipeDemoHistory } from './demo-fixture.ts'
import { installDemoWallet } from './demo-wallet.ts'

// SC-008: the demo — connect a wallet, see a limit, borrow, a reward arrives, the loan is
// repaid by itself — in under three minutes, on the deployment as it is: the live site,
// the api and keeper on Render, devnet. Timed from opening the site until the position
// page shows the loan closed by the reward. The one stand-in is the operator's mainnet
// history (see demo-fixture.ts). Spends devnet SOL and tokens: `pnpm bench:demo`.
const BUDGET_MS = 180_000
const NETWORK = 'hivemapper'
const WALLET_NAME = 'DRF Demo Wallet'
const AMOUNT_TEXT = '1.00'
const SWEEP_BPS = 5_000
const OPERATOR_LAMPORTS = 50_000_000
const RELOAD_MS = 3_000
// Render's free plan sleeps; the keeper lives in that process. Waking it is not the demo.
const WAKE_MS = 180_000

const envFile = path.join(import.meta.dirname, '..', '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const seedSchema = z
  .string()
  .transform((value) => base58.decode(value))
  .refine((bytes) => bytes.length === 32, 'expected a base58 32-byte seed')

const unsetWhenEmpty = (value: unknown) => (value === '' ? undefined : value)

const demoEnvSchema = z.object({
  SEED_KEYPAIR: z.string().min(1),
  REWARD_KEYPAIR: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  STABLE_MINT: solanaAddressSchema,
  KEEPER_SECRET_KEY: seedSchema,
  VITE_REWARD_MINTS: rewardMintsSchema.refine((mints) => mints.has(NETWORK), `no ${NETWORK} mint`),
  VITE_DEVNET_RPC_URL: z.preprocess(
    unsetWhenEmpty,
    z.url({ protocol: /^https?$/ }).default('https://api.devnet.solana.com'),
  ),
  VITE_API_URL: z.preprocess(
    unsetWhenEmpty,
    z.url({ protocol: /^https?$/ }).default('https://depin-reward-float-api.onrender.com'),
  ),
  DEMO_SITE_URL: z.preprocess(
    unsetWhenEmpty,
    z.url({ protocol: /^https$/ }).default('https://chestdepin.github.io/DePIN-Reward-Float/app/'),
  ),
  // The landing's hero is a recording of this run; set, the browser films it here.
  DEMO_VIDEO_DIR: z.preprocess(unsetWhenEmpty, z.string().optional()),
})
const parsed = demoEnvSchema.safeParse(process.env)

const keypairSchema = z.array(z.number().int().min(0).max(255)).length(64)

function readKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(keypairSchema.parse(JSON.parse(readFileSync(file, 'utf8')))),
  )
}

const usdText = (text: string) => Number(text.replace(/[$,]/g, ''))

describe.skipIf(!parsed.success)('SC-008 — the demo end to end in under 3 min', () => {
  const env = parsed.success ? parsed.data : undefined
  const operator = Keypair.generate()
  const address = operator.publicKey.toBase58()
  let connection: Connection
  let funder: Keypair
  let rewards: Keypair
  let keeper: PublicKey
  let rewardMint: PublicKey
  let db: Database
  let closeDb: () => Promise<void>
  let browser: Browser
  let page: Page
  let loan: PublicKey | null = null

  const send = (instructions: TransactionInstruction[], signers: Keypair[]) =>
    sendAndConfirmTransaction(connection, new Transaction().add(...instructions), signers, {
      commitment: 'confirmed',
    })

  const readLoan = async (at: PublicKey) => {
    const account = await connection.getAccountInfo(at, 'confirmed')
    if (account === null) throw new Error(`no loan at ${at.toBase58()}`)
    return decodeLoan(account.data)
  }

  const api = (route: string) => {
    if (env === undefined) throw new Error('no environment')
    return new URL(route, env.VITE_API_URL)
  }

  const nav = (label: string) => page.getByRole('link', { name: label, exact: true }).click()

  beforeAll(async () => {
    if (env === undefined) return
    connection = new Connection(env.VITE_DEVNET_RPC_URL, 'confirmed')
    funder = readKeypair(env.SEED_KEYPAIR)
    rewards = readKeypair(env.REWARD_KEYPAIR)
    keeper = Keypair.fromSeed(env.KEEPER_SECRET_KEY).publicKey
    const mint = env.VITE_REWARD_MINTS.get(NETWORK)
    if (mint === undefined) throw new Error(`no ${NETWORK} mint`)
    rewardMint = mint

    const handle = createDatabase(env.DATABASE_URL)
    db = handle.db
    closeDb = handle.close
    const [row] = await db.select().from(networksTable).where(eq(networksTable.id, NETWORK))
    if (row === undefined) throw new Error(`no ${NETWORK} network in the database`)
    const network = rewardNetworkSchema.parse({
      id: row.id,
      displayName: row.displayName,
      token: { mint: row.tokenMint, symbol: row.tokenSymbol, decimals: row.tokenDecimals },
      payoutSources: row.payoutSources,
      payoutCadence: row.payoutCadence,
    })
    await wipeDemoHistory(db)
    await seedDemoHistory(
      db,
      demoHistory({ wallet: solanaAddressSchema.parse(address), network, now: new Date() }),
    )

    // An operator who has SOL for fees and the account its rewards are paid into; the
    // stablecoin account is the borrow's to create.
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
          mint: rewardMint,
        }),
      ],
      [funder],
    )

    const wakeUntil = performance.now() + WAKE_MS
    for (;;) {
      const health = await fetch(api('/health')).catch(() => null)
      if (health?.ok === true) break
      if (performance.now() > wakeUntil) throw new Error('the api did not wake up')
      await sleep(5_000)
    }

    browser = await chromium.launch()
    const viewport = { width: 1280, height: 720 }
    const context = await browser.newContext(
      env.DEMO_VIDEO_DIR === undefined
        ? {}
        : { viewport, recordVideo: { dir: env.DEMO_VIDEO_DIR, size: viewport } },
    )
    await installDemoWallet(context, { wallet: operator, name: WALLET_NAME })
    page = await context.newPage()
  })

  afterAll(async () => {
    if (env === undefined) return
    await browser?.close()
    try {
      // A loan the reward did not close is closed by hand, so no keeper keeps sweeping
      // into it; interest is minted on top of what was borrowed.
      if (loan !== null && (await readLoan(loan)).status !== 'repaid') {
        const account = await readLoan(loan)
        const pool = await fetchPool(connection, poolAddress(new PublicKey(env.STABLE_MINT)))
        const stable = pool.account.stableMint
        const owed = account.outstanding + account.accruedInterest + 1_000_000n
        await send(
          [
            mintToInstruction({
              mint: stable,
              destination: associatedTokenAddress(stable, operator.publicKey),
              authority: funder.publicKey,
              amount: owed,
            }),
          ],
          [funder],
        )
        await send(
          [
            await repayInstruction(rewardFloatProgram(connection), {
              payer: operator.publicKey,
              pool,
              loan: { address: loan, account },
              maxAmount: owed,
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
    } finally {
      await wipeDemoHistory(db)
      await closeDb()
    }
  })

  it(
    'connects, borrows against the limit, and a reward repays the loan',
    async () => {
      if (env === undefined) return
      const steps: [string, number][] = []
      const started = performance.now()
      const mark = (step: string) => steps.push([step, performance.now() - started])
      const left = () => Math.max(1, BUDGET_MS - (performance.now() - started))

      await page.goto(env.DEMO_SITE_URL)
      await page.getByRole('button', { name: WALLET_NAME }).click({ timeout: left() })
      await page.getByRole('button', { name: address }).waitFor({ timeout: left() })
      mark('wallet connected')

      await nav('LIMIT')
      await page.getByText('AVAILABLE TO BORROW').waitFor({ timeout: left() })
      const limit = usdText(
        await page
          .getByText(/^\$[\d,]+\.\d{2}$/)
          .first()
          .innerText(),
      )
      expect(limit).toBeGreaterThan(Number(AMOUNT_TEXT))
      mark(`limit shown: $${limit}`)

      await nav('BORROW')
      await page.getByPlaceholder('0.00').fill(AMOUNT_TEXT)
      const sign = page.getByRole('button', { name: 'SIGN AND BORROW' })
      await expect.poll(() => sign.isEnabled(), { timeout: left() }).toBe(true)
      await sign.click()
      const borrowed = page.getByText(/^Borrowed\. Loan \w+\./)
      await borrowed.waitFor({ timeout: left() })
      const loanText = /Loan (\w+)\./.exec(await borrowed.innerText())?.[1]
      loan = new PublicKey(solanaAddressSchema.parse(loanText))
      mark('loan confirmed')

      // The reward, minted as a reward program would send it: enough for the share the
      // loan withholds to cover all of the debt.
      const opened = await readLoan(loan)
      const rate = await fetch(api('/v1/attestations/rate'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rewardMint: rewardMint.toBase58() }),
      })
      expect(rate.status).toBe(201)
      const payout = payoutToRepay({
        debt: opened.outstanding + opened.accruedInterest,
        stablePerTrillionReward: BigInt(
          issuedRateAttestationSchema.parse(await rate.json()).stablePerTrillionReward,
        ),
        sweepBps: SWEEP_BPS,
      })
      await send(
        [
          mintToInstruction({
            mint: rewardMint,
            destination: associatedTokenAddress(rewardMint, operator.publicKey),
            authority: rewards.publicKey,
            amount: payout,
          }),
        ],
        [funder, rewards],
      )
      mark('reward arrived')

      // The operator does nothing from here but look: the page is reopened the way a
      // person would refresh it.
      await nav('POSITION')
      const closed = page.getByText('No open loans.')
      const journalled = page.getByRole('cell', { name: 'repaid', exact: true })
      for (;;) {
        await page.getByRole('heading', { name: 'WITHHOLDINGS' }).waitFor({ timeout: left() })
        await page
          .getByText('reading open loans from devnet…')
          .waitFor({ state: 'detached', timeout: left() })
        await page
          .getByText('reading the withholdings…')
          .waitFor({ state: 'detached', timeout: left() })
        if ((await closed.isVisible()) && (await journalled.isVisible())) break
        if (left() <= 1) throw new Error('the loan was not shown repaid within the budget')
        await sleep(Math.min(RELOAD_MS, left()))
        await page.reload()
      }
      mark('position shows the loan repaid by the reward')
      const elapsed = performance.now() - started

      // Closed by the keeper's sweep of this loan, and by nothing the test did.
      const closedLoan = await readLoan(loan)
      expect(closedLoan.status).toBe('repaid')
      const [newest] = await connection.getSignaturesForAddress(loan, { limit: 1 }, 'confirmed')
      if (newest === undefined) throw new Error('no signature on the loan')
      const sweep = await connection.getTransaction(newest.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      expect(sweep?.transaction.message.staticAccountKeys[0]?.toBase58()).toBe(keeper.toBase58())
      const swept = sweepEvents(sweep?.meta?.logMessages ?? [])
        .filter((event) => event.kind === 'swept')
        .find((event) => loan !== null && event.loan.equals(loan))
      expect(swept?.withheld).toBeGreaterThan(0n)

      console.log(`site: ${env.DEMO_SITE_URL}, api: ${env.VITE_API_URL}, operator: ${address}`)
      for (const [step, at] of steps) console.log(`  ${(at / 1_000).toFixed(1)} s  ${step}`)
      console.log(`SC-008 total: ${(elapsed / 1_000).toFixed(1)} s (budget ${BUDGET_MS / 1_000} s)`)
      expect(elapsed).toBeLessThan(BUDGET_MS)
    },
    BUDGET_MS + 60_000,
  )
})
