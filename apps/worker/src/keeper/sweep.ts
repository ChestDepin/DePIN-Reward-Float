import {
  associatedTokenAddress,
  type ChainReader,
  conversionVaultAddress,
  decodeOperatorAccount,
  fetchAllOpenLoans,
  fetchConversionVault,
  fetchPool,
  fetchRewardWatches,
  type LoanAccount,
  type OnChain,
  OpenLoansOutOfSync,
  type OperatorAccount,
  openLoansForBorrow,
  operatorAccountAddress,
  poolAddress,
  type RewardFloatProgram,
  type RewardWatchAccount,
  rewardFloatProgram,
  rewardFloatProgramId,
  sweepEvents,
  sweepInstructions,
  tokenAmount,
} from '@drf/anchor-client'
import type { IssuedRateAttestation } from '@drf/shared/api'
import {
  type AccountInfo,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import type { Logger } from 'pino'

// SC-005 gives two minutes from payout to a smaller debt; a payout waits at most one
// interval to be seen, and a tick is four reads however many operators there are.
export const POLL_INTERVAL_MS = 15_000

// One rate attestation's lifetime: the market gets as long to come back inside the
// tolerance as a rate is valid, and the reason lands on chain once per such window.
export const SKIP_PAUSE_MS = 2 * 60_000

// getMultipleAccounts answers at most this many addresses per call.
const MAX_ACCOUNTS_PER_READ = 100

export type Pause = { balance: bigint; until: number }

export type PlannedSweep = {
  watch: PublicKey
  operator: PublicKey
  rewardMint: PublicKey
  balance: bigint
  payout: bigint
  openLoans: PublicKey[]
}

export type Unsettled = { operator: PublicKey; reason: string }

export function planSweeps(input: {
  pool: PublicKey
  watches: readonly OnChain<RewardWatchAccount>[]
  // Reward balance by watch address; an account that does not exist holds nothing.
  balances: ReadonlyMap<string, bigint>
  operatorAccounts: ReadonlyMap<string, OperatorAccount | null>
  openLoans: readonly OnChain<LoanAccount>[]
  pauses: ReadonlyMap<string, Pause>
  now: number
}): { due: PlannedSweep[]; unsettled: Unsettled[] } {
  const due: PlannedSweep[] = []
  const unsettled: Unsettled[] = []

  for (const { address, account: watch } of input.watches) {
    const balance = input.balances.get(address.toBase58()) ?? 0n
    if (balance <= watch.balance) continue

    const loans = input.openLoans.filter((loan) => loan.account.operator.equals(watch.operator))
    if (!loans.some((loan) => loan.account.rewardMint.equals(watch.rewardMint))) continue

    const pause = input.pauses.get(address.toBase58())
    if (pause !== undefined && pause.balance === balance && input.now < pause.until) continue

    let openLoans: PublicKey[]
    try {
      openLoans = openLoansForBorrow({
        operatorAccount: input.operatorAccounts.get(watch.operator.toBase58()) ?? null,
        pool: input.pool,
        loans,
      })
    } catch (error) {
      if (!(error instanceof OpenLoansOutOfSync)) throw error
      unsettled.push({ operator: watch.operator, reason: error.message })
      continue
    }

    due.push({
      watch: address,
      operator: watch.operator,
      rewardMint: watch.rewardMint,
      balance,
      payout: balance - watch.balance,
      openLoans,
    })
  }

  return { due, unsettled }
}

export type KeeperChain = ChainReader & {
  getMultipleAccountsInfo(addresses: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]>
}

export type SentSweep = { signature: string; logs: readonly string[] }

export type KeeperDeps = {
  chain: KeeperChain
  program: RewardFloatProgram
  pool: PublicKey
  issueRate(rewardMint: string): Promise<IssuedRateAttestation>
  submit(instructions: TransactionInstruction[]): Promise<SentSweep>
  logger: Logger
  now(): number
}

export type SweepOutcome =
  | { watch: string; outcome: 'swept' | 'skipped' | 'nothing'; signature: string }
  | { watch: string; outcome: 'failed'; error: string }

export type Keeper = { tick(): Promise<SweepOutcome[]> }

async function readMany(
  chain: KeeperChain,
  addresses: PublicKey[],
): Promise<(AccountInfo<Buffer> | null)[]> {
  const found: (AccountInfo<Buffer> | null)[] = []
  for (let start = 0; start < addresses.length; start += MAX_ACCOUNTS_PER_READ) {
    found.push(
      ...(await chain.getMultipleAccountsInfo(
        addresses.slice(start, start + MAX_ACCOUNTS_PER_READ),
      )),
    )
  }
  return found
}

// A discriminator proves the shape, not the author: only the owner does.
function operatorAccountFrom(address: PublicKey, info: AccountInfo<Buffer> | null) {
  if (info === null) return null
  if (!info.owner.equals(rewardFloatProgramId)) {
    throw new Error(`${address.toBase58()} is not owned by the reward-float program`)
  }
  return decodeOperatorAccount(info.data)
}

export function createKeeper(deps: KeeperDeps): Keeper {
  const { chain, logger } = deps
  const pauses = new Map<string, Pause>()

  async function sweepOne(
    plan: PlannedSweep,
    pool: Awaited<ReturnType<typeof fetchPool>>,
    rates: Map<string, Promise<IssuedRateAttestation>>,
  ): Promise<SweepOutcome> {
    const watch = plan.watch.toBase58()
    const mint = plan.rewardMint.toBase58()
    try {
      const conversionAddress = conversionVaultAddress(pool.address, plan.rewardMint)
      const conversion = await fetchConversionVault(chain, conversionAddress)
      if (conversion === null) throw new Error(`the pool has no conversion vault for ${mint}`)

      // One rate per mint and tick: it is valid for two minutes, a tick takes seconds.
      let rate = rates.get(mint)
      if (rate === undefined) {
        rate = deps.issueRate(mint)
        rates.set(mint, rate)
      }

      const instructions = await sweepInstructions(deps.program, {
        operator: plan.operator,
        pool,
        conversionVault: { address: conversionAddress, account: conversion },
        rate: await rate,
        openLoans: plan.openLoans,
      })
      const { signature, logs } = await deps.submit(instructions)
      const events = sweepEvents(logs)

      if (events.some((event) => event.kind === 'skipped')) {
        pauses.set(watch, { balance: plan.balance, until: deps.now() + SKIP_PAUSE_MS })
        logger.warn({ watch, signature, events }, 'sweep skipped outside the tolerance')
        return { watch, outcome: 'skipped', signature }
      }
      if (events.some((event) => event.kind === 'swept')) {
        logger.info({ watch, signature, payout: plan.payout, events }, 'payout swept')
        return { watch, outcome: 'swept', signature }
      }
      // No allowance left, or the payout was spent before the sweep: the watch moved and
      // the program has nothing to say about it.
      logger.info({ watch, signature, payout: plan.payout }, 'sweep withheld nothing')
      return { watch, outcome: 'nothing', signature }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error({ watch, operator: plan.operator.toBase58(), err: error }, 'sweep failed')
      return { watch, outcome: 'failed', error: message }
    }
  }

  return {
    async tick() {
      const pool = await fetchPool(chain, deps.pool)
      const [watches, openLoans] = await Promise.all([
        fetchRewardWatches(chain),
        fetchAllOpenLoans(chain),
      ])

      const rewardAccounts = watches.map(({ account }) =>
        associatedTokenAddress(account.rewardMint, account.operator),
      )
      const operators = [...new Set(watches.map(({ account }) => account.operator.toBase58()))]
      const operatorAddresses = operators.map((operator) =>
        operatorAccountAddress(new PublicKey(operator)),
      )
      const found = await readMany(chain, [...rewardAccounts, ...operatorAddresses])

      const balances = new Map<string, bigint>()
      watches.forEach(({ address }, index) => {
        const account = rewardAccounts[index]
        if (account !== undefined) {
          balances.set(address.toBase58(), tokenAmount(account, found[index] ?? null))
        }
      })
      const operatorAccounts = new Map<string, OperatorAccount | null>()
      operators.forEach((operator, index) => {
        const address = operatorAddresses[index]
        if (address !== undefined) {
          operatorAccounts.set(
            operator,
            operatorAccountFrom(address, found[watches.length + index] ?? null),
          )
        }
      })

      const now = deps.now()
      for (const [watch, pause] of pauses) {
        if (pause.until <= now) pauses.delete(watch)
      }

      const { due, unsettled } = planSweeps({
        pool: pool.address,
        watches,
        balances,
        operatorAccounts,
        openLoans,
        pauses,
        now,
      })
      for (const { operator, reason } of unsettled) {
        logger.warn({ operator: operator.toBase58(), reason }, 'open loans out of sync, retrying')
      }

      const rates = new Map<string, Promise<IssuedRateAttestation>>()
      const outcomes: SweepOutcome[] = []
      for (const plan of due) outcomes.push(await sweepOne(plan, pool, rates))
      return outcomes
    },
  }
}

// The next tick is scheduled only after the last one ends, so two never overlap on the
// same watch and send it twice.
export function runKeeper(
  keeper: { tick(): Promise<unknown> },
  options: { intervalMs: number; logger: Logger },
): { stop(): void } {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const loop = async () => {
    try {
      await keeper.tick()
    } catch (error) {
      options.logger.error({ err: error }, 'keeper tick failed')
    }
    if (!stopped) timer = setTimeout(loop, options.intervalMs)
  }
  timer = setTimeout(loop, 0)

  return {
    // A sweep in flight is not waited for: it lands or it does not, and the watch on
    // chain tells the next keeper which.
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}

export type DevnetKeeperConfig = {
  rpcUrl: string
  // The fee payer's 32-byte ed25519 seed. It signs only fees: sweep takes no signer.
  secretKey: Uint8Array
  stableMint: string
  issueRate(rewardMint: string): Promise<IssuedRateAttestation>
  logger: Logger
}

export function startDevnetKeeper(config: DevnetKeeperConfig): { stop(): void } {
  const connection = new Connection(config.rpcUrl, 'confirmed')
  const payer = Keypair.fromSeed(config.secretKey)
  const program = rewardFloatProgram(connection)
  const pool = poolAddress(new PublicKey(config.stableMint))

  const keeper = createKeeper({
    chain: connection,
    program,
    pool,
    issueRate: config.issueRate,
    submit: async (instructions) => {
      const signature = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(...instructions),
        [payer],
        { commitment: 'confirmed' },
      )
      const landed = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      return { signature, logs: landed?.meta?.logMessages ?? [] }
    },
    logger: config.logger,
    now: () => Date.now(),
  })

  config.logger.info(
    { payer: payer.publicKey.toBase58(), pool: pool.toBase58(), intervalMs: POLL_INTERVAL_MS },
    'keeper started',
  )
  return runKeeper(keeper, { intervalMs: POLL_INTERVAL_MS, logger: config.logger })
}
