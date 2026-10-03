import {
  borrowInstructions,
  fetchOpenLoans,
  fetchOperatorAccount,
  fetchPool,
  loanAddress,
  type OnChain,
  type OperatorAccount,
  openLoansForBorrow,
  type PoolAccount,
  poolAddress,
  rewardFloatProgram,
} from '@drf/anchor-client'
import { MAX_TERM_PERIODS, REPAYMENT_PERIOD_SECONDS, type ScheduleRow } from '@drf/shared/loan'
import type { SolanaAddress } from '@drf/shared/schemas'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey, Transaction } from '@solana/web3.js'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, useResource } from '../lib/api'
import {
  attestedLimit,
  type BorrowFailure,
  borrowableNetworks,
  describeBorrowFailure,
  parseStableAmount,
  quoteLoan,
} from '../lib/borrow'
import { chainConfig } from '../lib/chain'
import { formatCents, formatCost, formatUsd, roundRowsToCents } from '../lib/format'
import { useOperatorIdentity } from '../lib/wallet'

const DefRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-col gap-y-1 border-b border-rule py-3 text-[12px] sm:flex-row sm:items-baseline sm:justify-between sm:gap-x-6 sm:text-[14px]">
    <span className="text-dim sm:text-ink">{label}</span>
    <span className="text-right tnum">{value}</span>
  </div>
)

const Heading = ({ children }: { children: string }) => (
  <h2 className="mt-12 text-[11px] sm:text-[12px] tracking-[0.14em] text-dim">{children}</h2>
)

type ChainState =
  | { status: 'loading' }
  | { status: 'missing-pool' }
  | { status: 'unreachable'; message: string }
  | { status: 'ready'; pool: OnChain<PoolAccount>; operatorAccount: OperatorAccount | null }

type Stage =
  | { step: 'idle' }
  | { step: 'attesting' | 'preparing' | 'signing' | 'confirming' }
  | { step: 'done'; signature: string; loan: string }
  | { step: 'failed'; failure: BorrowFailure | { kind: 'attestation' } }

const STAGE_TEXT = {
  attesting: 'asking the api to sign your limit…',
  preparing: 'reading your open loans from the chain…',
  signing: 'waiting for the wallet…',
  confirming: 'waiting for devnet to confirm…',
} as const

function percent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`
}

function dueDate(afterSeconds: bigint): string {
  return new Date(Date.now() + Number(afterSeconds) * 1000).toISOString().slice(0, 10)
}

function failureText(failure: BorrowFailure | { kind: 'attestation' }): string {
  switch (failure.kind) {
    case 'attestation':
      return 'The api did not sign a limit for this wallet, so there is nothing to borrow against.'
    case 'rejected':
      return 'The wallet declined. Nothing was sent.'
    case 'rate-moved':
      return 'The pool moved between the quote and the signature, so the rate you saw no longer holds. Nothing was borrowed; the terms below are the new ones.'
    case 'program':
      return `The program refused the loan: ${failure.message}.`
    case 'unknown':
      return `The loan did not go through: ${failure.message}`
  }
}

const sum = (values: readonly bigint[]) => values.reduce((total, value) => total + value, 0n)

const Schedule = ({ rows }: { rows: readonly ScheduleRow[] }) => {
  const principal = roundRowsToCents(rows.map((row) => row.principal))
  const interest = roundRowsToCents(rows.map((row) => row.interest))
  const cell = 'py-2 text-right'

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full border-t border-rule text-[12px] sm:text-[13px] tnum">
        <thead className="text-dim">
          <tr className="border-b border-rule">
            <th className="py-2 text-left font-normal">due by</th>
            <th className={`${cell} font-normal`}>principal</th>
            <th className={`${cell} font-normal`}>interest</th>
            <th className={`${cell} font-normal`}>payment</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const p = principal[i] ?? 0n
            const r = interest[i] ?? 0n
            return (
              <tr key={row.period} className="border-b border-rule">
                <td className="py-2">{dueDate(row.dueAfterSeconds)}</td>
                <td className={cell}>{formatCents(p)}</td>
                <td className={cell}>{formatCents(r)}</td>
                <td className={cell}>{formatCents(p + r)}</td>
              </tr>
            )
          })}
          <tr className="border-b border-rule text-dim">
            <td className="py-2">total</td>
            <td className={cell}>{formatCents(sum(principal))}</td>
            <td className={cell}>{formatCents(sum(interest))}</td>
            <td className={cell}>{formatCents(sum(principal) + sum(interest))}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

const Borrow = () => {
  const identity = useOperatorIdentity()

  if (identity.status === 'connecting') {
    return <p className="text-[13px] text-dim">connecting the wallet…</p>
  }
  if (identity.status !== 'connected') {
    return (
      <p className="text-[13px] leading-relaxed text-dim">
        Borrowing is signed by the operator’s own wallet.{' '}
        <Link to="/lookup" className="text-ink underline underline-offset-4">
          Connect it
        </Link>{' '}
        first.
      </p>
    )
  }
  if (chainConfig.stableMint === null) {
    return (
      <p className="text-[13px] leading-relaxed text-dim">
        Lending is not set up on this deployment: it has no stablecoin to lend.
      </p>
    )
  }
  return <BorrowForm operator={identity.address} stableMint={chainConfig.stableMint} />
}

const BorrowForm = ({
  operator,
  stableMint,
}: {
  operator: SolanaAddress
  stableMint: PublicKey
}) => {
  const { connection } = useConnection()
  const { sendTransaction } = useWallet()
  const program = useMemo(() => rewardFloatProgram(connection), [connection])
  const operatorKey = useMemo(() => new PublicKey(operator), [operator])

  const loadLimit = useCallback(() => api.creditLimit(operator), [operator])
  const limit = useResource(loadLimit)

  const [chain, setChain] = useState<ChainState>({ status: 'loading' })
  const [reads, setReads] = useState(0)
  useEffect(() => {
    let live = true
    const pool = poolAddress(stableMint)
    // `reads` only restarts the effect: after a refused rate the quote must come from
    // the pool as it is now, not as it was.
    void reads
    Promise.all([fetchPool(connection, pool), fetchOperatorAccount(connection, operatorKey)])
      .then(([poolAccount, operatorAccount]) => {
        if (live) setChain({ status: 'ready', pool: poolAccount, operatorAccount })
      })
      .catch((error: unknown) => {
        if (!live) return
        const message = error instanceof Error ? error.message : String(error)
        setChain(
          /not found/.test(message)
            ? { status: 'missing-pool' }
            : { status: 'unreachable', message },
        )
      })
    return () => {
      live = false
    }
  }, [connection, operatorKey, stableMint, reads])

  const [amountText, setAmountText] = useState('')
  const [termPeriods, setTermPeriods] = useState(3)
  const [sweepText, setSweepText] = useState('50')
  const [chosenNetwork, setChosenNetwork] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>({ step: 'idle' })

  if (limit.status === 'loading' || chain.status === 'loading') {
    return <p className="text-[13px] text-dim">reading the limit and the pool…</p>
  }
  if (!limit.result.ok) {
    return (
      <p className="text-[13px] leading-relaxed text-dim">
        There is no limit to borrow against yet.{' '}
        <Link to={`/limit/${operator}`} className="text-ink underline underline-offset-4">
          See why
        </Link>
        .
      </p>
    )
  }
  if (chain.status === 'missing-pool') {
    return (
      <p className="text-[13px] leading-relaxed text-dim">
        The lending pool does not exist on devnet yet, so there is nothing to borrow from.
      </p>
    )
  }
  if (chain.status === 'unreachable') {
    return (
      <p className="text-[13px] leading-relaxed text-dim">
        Devnet could not be read: {chain.message}
      </p>
    )
  }

  const networks = borrowableNetworks(limit.result.value.networks, chainConfig.rewardMints)
  const network =
    networks.find((option) => option.networkId === chosenNetwork && option.unavailable === null) ??
    networks.find((option) => option.unavailable === null) ??
    null
  const limitUnits = attestedLimit(limit.result.value.networks)
  const debt = chain.operatorAccount?.totalDebt ?? 0n
  const { pool } = chain
  const amount = parseStableAmount(amountText)
  const sweepPercent = /^\d{1,3}$/.test(sweepText.trim()) ? Number(sweepText.trim()) : 0
  const sweepBps = sweepPercent >= 1 && sweepPercent <= 100 ? sweepPercent * 100 : null
  const quote = quoteLoan({ amount, termPeriods, limit: limitUnits, debt, pool: pool.account })
  const progress =
    stage.step === 'attesting' ||
    stage.step === 'preparing' ||
    stage.step === 'signing' ||
    stage.step === 'confirming'
      ? STAGE_TEXT[stage.step]
      : null
  const busy = progress !== null
  const canSign = quote.kind === 'quote' && network !== null && sweepBps !== null && !busy

  const sign = async () => {
    if (
      quote.kind !== 'quote' ||
      network?.rewardMint == null ||
      sweepBps === null ||
      amount === null
    )
      return
    try {
      setStage({ step: 'attesting' })
      const attestation = await api.issueLimitAttestation(operator)
      if (!attestation.ok) {
        setStage({ step: 'failed', failure: { kind: 'attestation' } })
        return
      }

      setStage({ step: 'preparing' })
      const [operatorAccount, loans] = await Promise.all([
        fetchOperatorAccount(connection, operatorKey),
        fetchOpenLoans(connection, operatorKey),
      ])
      const instructions = await borrowInstructions(program, {
        operator: operatorKey,
        pool,
        attestation: attestation.value,
        openLoans: openLoansForBorrow({ operatorAccount, pool: pool.address, loans }),
        rewardMint: network.rewardMint,
        amount,
        termPeriods,
        sweepBps,
        // Exactly the quoted rate: the cost on the screen is the cost signed (FR-009a).
        maxAprBps: quote.aprBps,
      })
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const transaction = new Transaction({
        feePayer: operatorKey,
        blockhash,
        lastValidBlockHeight,
      }).add(...instructions)

      setStage({ step: 'signing' })
      const signature = await sendTransaction(transaction, connection)

      setStage({ step: 'confirming' })
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      )
      if (confirmation.value.err !== null) {
        throw new Error(JSON.stringify(confirmation.value.err))
      }
      setStage({
        step: 'done',
        signature,
        loan: loanAddress(operatorKey, BigInt(attestation.value.nonce)).toBase58(),
      })
      setReads((n) => n + 1)
    } catch (error) {
      const failure = describeBorrowFailure(error)
      setStage({ step: 'failed', failure })
      if (failure.kind === 'rate-moved') setReads((n) => n + 1)
    }
  }

  const available = limitUnits > debt ? limitUnits - debt : 0n
  const free = pool.account.totalDeposits - pool.account.totalBorrowed

  return (
    <div>
      <h1 className="text-[13px] sm:text-[15px] tracking-[0.18em] text-dim">BORROW</h1>

      <div className="mt-8 border-t border-rule">
        <DefRow label="credit limit" value={formatUsd(limitUnits.toString())} />
        <DefRow label="already owed" value={formatCost(debt)} />
        <DefRow label="available to borrow" value={formatUsd(available.toString())} />
        <DefRow label="free in the pool" value={formatUsd((free > 0n ? free : 0n).toString())} />
      </div>

      <Heading>LOAN</Heading>
      <div className="mt-3 grid gap-4 text-[12px] sm:grid-cols-2 sm:text-[13px]">
        <label className="flex flex-col gap-1">
          <span className="text-dim">amount, USDC</span>
          <input
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="border border-rule bg-ground px-3 py-2 tnum outline-none focus:border-ink"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-dim">term</span>
          <select
            value={termPeriods}
            onChange={(event) => setTermPeriods(Number(event.target.value))}
            className="border border-rule bg-ground px-3 py-2 outline-none focus:border-ink"
          >
            {Array.from({ length: MAX_TERM_PERIODS }, (_, i) => i + 1).map((periods) => (
              <option key={periods} value={periods}>
                {periods * 30} days, {periods} {periods === 1 ? 'instalment' : 'instalments'}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-dim">repaid from rewards of</span>
          <select
            value={network?.networkId ?? ''}
            onChange={(event) => setChosenNetwork(event.target.value)}
            className="border border-rule bg-ground px-3 py-2 outline-none focus:border-ink"
          >
            {networks.map((option) => (
              <option
                key={option.networkId}
                value={option.networkId}
                disabled={option.unavailable !== null}
              >
                {option.displayName}
                {option.unavailable === 'no-limit' ? ' — no limit' : ''}
                {option.unavailable === 'no-devnet-mint' ? ' — not on devnet' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-dim">share of each payout withheld, %</span>
          <input
            value={sweepText}
            onChange={(event) => setSweepText(event.target.value)}
            inputMode="numeric"
            className="border border-rule bg-ground px-3 py-2 tnum outline-none focus:border-ink"
          />
        </label>
      </div>
      {network === null && (
        <p className="mt-3 text-[12px] text-amber">
          None of your networks can back a loan on devnet yet.
        </p>
      )}
      {sweepBps === null && (
        <p className="mt-3 text-[12px] text-amber">The share withheld is a whole 1 to 100.</p>
      )}

      {quote.kind === 'over-limit' && (
        <p className="mt-6 text-[12px] text-amber">
          That is more than your limit leaves: up to {formatUsd(quote.available.toString())}.
        </p>
      )}
      {quote.kind === 'insufficient-liquidity' && (
        <p className="mt-6 text-[12px] text-amber">
          The pool has {formatUsd(quote.free.toString())} free to lend.
        </p>
      )}

      {quote.kind === 'quote' && (
        <>
          <Heading>WHAT IT COSTS</Heading>
          <div className="mt-3 border-t border-rule">
            <DefRow label="fixed rate" value={`${percent(quote.aprBps)} APR, fixed at issue`} />
            <DefRow
              label="interest if nothing is repaid before the term ends"
              value={formatCost(quote.cost.interestIfHeldToTerm)}
            />
            <DefRow
              label="most you repay within the term"
              value={formatCost(quote.cost.totalIfHeldToTerm)}
            />
          </div>

          <Heading>REPAYMENT SCHEDULE</Heading>
          <Schedule rows={quote.cost.schedule} />
          <div className="mt-3 border-t border-rule">
            <DefRow
              label="interest if repaid on schedule"
              value={formatCost(quote.cost.interestOnSchedule)}
            />
            <DefRow
              label="each day past the term adds up to"
              value={formatCost(quote.cost.interestPerDayPastDue)}
            />
          </div>
          <p className="mt-6 max-w-[60ch] text-[11px] sm:text-[12px] leading-relaxed text-dim">
            Interest runs by the second on what is still owed, so repaying early costs less. After
            the {Number(REPAYMENT_PERIOD_SECONDS / 86_400n) * termPeriods}-day term the same rate
            keeps running. Withholding from rewards is not switched on yet: until it is, the loan is
            repaid by hand.
          </p>
        </>
      )}

      <div className="mt-10">
        <button
          type="button"
          disabled={!canSign}
          onClick={() => void sign()}
          className="border border-ink px-4 py-2 text-[12px] tracking-[0.14em] disabled:border-rule disabled:text-dim"
        >
          SIGN AND BORROW
        </button>
        {progress !== null && <p className="mt-3 text-[12px] text-dim">{progress}</p>}
        {stage.step === 'failed' && (
          <p className="mt-3 max-w-[60ch] text-[12px] leading-relaxed text-amber">
            {failureText(stage.failure)}
          </p>
        )}
        {stage.step === 'done' && (
          <p className="mt-3 text-[12px] leading-relaxed">
            Borrowed. Loan {stage.loan}.{' '}
            <a
              href={`https://explorer.solana.com/tx/${stage.signature}?cluster=devnet`}
              className="underline underline-offset-4"
              target="_blank"
              rel="noreferrer"
            >
              transaction
            </a>
          </p>
        )}
      </div>
    </div>
  )
}

export default Borrow
