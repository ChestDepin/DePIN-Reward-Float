import {
  depositInstruction,
  fetchLenderShare,
  fetchPool,
  fetchStableBalance,
  type LenderShareAccount,
  type OnChain,
  type PoolAccount,
  poolAddress,
  rewardFloatProgram,
  withdrawInstruction,
  withdrawnEvent,
} from '@drf/anchor-client'
import type { PoolState } from '@drf/shared/api'
import { quoteWithdrawal, valueOfShares } from '@drf/shared/loan'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { type ApiFailure, api, useResource } from '../lib/api'
import { type BorrowFailure, describeBorrowFailure, parseStableAmount } from '../lib/borrow'
import { chainConfig } from '../lib/chain'
import { formatBps, formatUsd } from '../lib/format'
import { lendFailureText, withdrawalText, withdrawnText } from '../lib/lend'
import { useOperatorIdentity } from '../lib/wallet'

const U64_MAX = 2n ** 64n - 1n

const DefRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-col gap-y-1 border-b border-rule py-3 text-[12px] sm:flex-row sm:items-baseline sm:justify-between sm:gap-x-6 sm:text-[14px]">
    <span className="text-dim sm:text-ink">{label}</span>
    <span className="text-right tnum">{value}</span>
  </div>
)

const Heading = ({ children }: { children: string }) => (
  <h2 className="mt-12 text-[11px] sm:text-[12px] tracking-[0.14em] text-dim">{children}</h2>
)

function secondsNow(): bigint {
  return BigInt(Math.floor(Date.now() / 1000))
}

function poolFailureText(failure: ApiFailure): string {
  if (failure.kind === 'data-unavailable') {
    return 'The api could not read the pool. Its numbers are unknown, not zero.'
  }
  if (failure.kind === 'unreachable') return 'The api could not be reached.'
  return 'The api answered something this page cannot read.'
}

const Pool = () => {
  const identity = useOperatorIdentity()
  const [reads, setReads] = useState(0)
  // `reads` only renews the callback: after a deposit or a withdrawal the pool has moved.
  const loadPool = useCallback(() => {
    void reads
    return api.pool()
  }, [reads])
  const pool = useResource(loadPool)

  return (
    <div>
      <h1 className="text-[13px] sm:text-[15px] tracking-[0.18em] text-dim">POOL</h1>
      {pool.status === 'loading' && (
        <p className="mt-8 text-[13px] text-dim">reading the pool…</p>
      )}
      {pool.status === 'done' && !pool.result.ok && (
        <p className="mt-8 text-[13px] text-amber">{poolFailureText(pool.result.failure)}</p>
      )}
      {pool.status === 'done' && pool.result.ok && <Numbers pool={pool.result.value} />}

      <Heading>YOUR POSITION</Heading>
      {identity.status === 'connecting' && (
        <p className="mt-3 text-[12px] text-dim">connecting the wallet…</p>
      )}
      {identity.status !== 'connecting' && identity.status !== 'connected' && (
        <p className="mt-3 text-[12px] leading-relaxed text-dim">
          Lending is signed by your own wallet.{' '}
          <Link to="/lookup" className="text-ink underline underline-offset-4">
            Connect it
          </Link>{' '}
          to deposit or withdraw.
        </p>
      )}
      {identity.status === 'connected' && chainConfig.stableMint === null && (
        <p className="mt-3 text-[12px] leading-relaxed text-dim">
          Lending is not set up on this deployment: it has no stablecoin to lend.
        </p>
      )}
      {identity.status === 'connected' && chainConfig.stableMint !== null && (
        <Lender
          lender={new PublicKey(identity.address)}
          stableMint={chainConfig.stableMint}
          reads={reads}
          onMoved={() => setReads((n) => n + 1)}
        />
      )}
    </div>
  )
}

const Numbers = ({ pool }: { pool: PoolState }) => (
  <>
    <div className="mt-8 border-t border-rule">
      <DefRow label="lenders’ money" value={formatUsd(pool.totalDeposits)} />
      <DefRow label="out in loans" value={formatUsd(pool.borrowed)} />
      <DefRow label="free to withdraw or lend" value={formatUsd(pool.free)} />
      <DefRow label="utilisation" value={formatBps(pool.utilisationBps)} />
      <DefRow
        label="rate the open loans pay"
        value={pool.loanAprBps === null ? 'no loans out' : `${formatBps(pool.loanAprBps)} APR`}
      />
      <DefRow label="what lenders earn now" value={`${formatBps(pool.lenderAprBps)} APR`} />
    </div>
    <p className="mt-6 max-w-[60ch] text-[11px] sm:text-[12px] leading-relaxed text-dim">
      Both rates are what the loans already out are fixed at, weighted by what each still owes, not
      a rate on offer. What lenders earn is that interest spread over all of their money, lent or
      not, so it moves as loans open and close. It is paid by operators from their payouts, not by
      new tokens.
    </p>
  </>
)

type LenderChain =
  | { status: 'loading' }
  | { status: 'missing-pool' }
  | { status: 'unreachable'; message: string }
  | {
      status: 'ready'
      pool: OnChain<PoolAccount>
      share: LenderShareAccount | null
      balance: bigint
    }

type Action = 'deposit' | 'withdrawal'

type Stage =
  | { step: 'idle' }
  | { step: 'signing' | 'confirming'; action: Action }
  | { step: 'failed'; action: Action; failure: BorrowFailure }
  | { step: 'done'; signature: string; text: string }

type Choice = 'all' | 'custom'

const Lender = ({
  lender,
  stableMint,
  reads,
  onMoved,
}: {
  lender: PublicKey
  stableMint: PublicKey
  reads: number
  onMoved: () => void
}) => {
  const { connection } = useConnection()
  const { sendTransaction } = useWallet()
  const program = useMemo(() => rewardFloatProgram(connection), [connection])
  const [chain, setChain] = useState<LenderChain>({ status: 'loading' })
  const [depositText, setDepositText] = useState('')
  const [choice, setChoice] = useState<Choice>('all')
  const [withdrawText, setWithdrawText] = useState('')
  const [stage, setStage] = useState<Stage>({ step: 'idle' })

  useEffect(() => {
    let live = true
    const address = poolAddress(stableMint)
    // `reads` only restarts the effect: a deposit or a withdrawal changes all three.
    void reads
    Promise.all([
      fetchPool(connection, address),
      fetchLenderShare(connection, address, lender),
      fetchStableBalance(connection, lender, stableMint),
    ])
      .then(([pool, share, balance]) => {
        if (live) setChain({ status: 'ready', pool, share, balance })
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
  }, [connection, lender, stableMint, reads])

  if (chain.status === 'loading') {
    return <p className="mt-3 text-[12px] text-dim">reading your share and balance from devnet…</p>
  }
  if (chain.status === 'missing-pool') {
    return (
      <p className="mt-3 text-[12px] leading-relaxed text-dim">
        The lending pool does not exist on devnet yet, so there is nothing to lend into.
      </p>
    )
  }
  if (chain.status === 'unreachable') {
    return <p className="mt-3 text-[12px] text-amber">Devnet could not be read: {chain.message}</p>
  }

  const { pool, share, balance } = chain
  const now = secondsNow()
  const shares = share?.shares ?? 0n
  const worth = valueOfShares(pool.account, shares, now)
  const ofPool = pool.account.totalShares === 0n ? 0n : (shares * 10_000n) / pool.account.totalShares
  const busy = stage.step === 'signing' || stage.step === 'confirming'

  const deposit = parseStableAmount(depositText)
  const depositShort = deposit !== null && deposit > balance
  const canDeposit = deposit !== null && !depositShort && !busy

  const maxAmount = choice === 'all' ? U64_MAX : parseStableAmount(withdrawText)
  const quote = maxAmount === null ? null : quoteWithdrawal(pool.account, shares, maxAmount, now)
  const explained =
    quote === null || maxAmount === null
      ? null
      : withdrawalText(quote, maxAmount < worth ? maxAmount : worth)
  const canWithdraw = quote?.ok === true && !busy

  const send = async (
    action: Action,
    build: () => Promise<TransactionInstruction>,
    done: (logs: readonly string[]) => string,
  ) => {
    try {
      const instruction = await build()
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const transaction = new Transaction({
        feePayer: lender,
        blockhash,
        lastValidBlockHeight,
      }).add(instruction)

      setStage({ step: 'signing', action })
      const signature = await sendTransaction(transaction, connection)

      setStage({ step: 'confirming', action })
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      )
      if (confirmation.value.err !== null) {
        throw new Error(JSON.stringify(confirmation.value.err))
      }
      const sent = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      setStage({ step: 'done', signature, text: done(sent?.meta?.logMessages ?? []) })
      setDepositText('')
      setWithdrawText('')
      onMoved()
    } catch (error) {
      setStage({ step: 'failed', action, failure: describeBorrowFailure(error) })
    }
  }

  const signDeposit = () => {
    if (deposit === null) return
    void send(
      'deposit',
      () => depositInstruction(program, { lender, pool, amount: deposit }),
      () => `Deposited ${formatUsd(deposit.toString())}.`,
    )
  }

  const signWithdrawal = () => {
    if (maxAmount === null) return
    void send(
      'withdrawal',
      () => withdrawInstruction(program, { lender, pool, maxAmount }),
      (logs) => {
        const event = withdrawnEvent(logs)
        // The transaction went through either way; only its logs were not to be had.
        return event === null ? 'Withdrawn.' : withdrawnText(event)
      },
    )
  }

  const option = (value: Choice, label: string) => (
    <label className="flex items-center gap-2">
      <input
        type="radio"
        name="withdraw"
        checked={choice === value}
        onChange={() => setChoice(value)}
        className="accent-current"
      />
      <span>{label}</span>
    </label>
  )

  return (
    <>
      <div className="mt-3 border-t border-rule">
        <DefRow label="worth now, interest included" value={formatUsd(worth.toString())} />
        <DefRow label="your share of the pool" value={formatBps(Number(ofPool))} />
        <DefRow label="in your wallet" value={formatUsd(balance.toString())} />
      </div>
      <p className="mt-6 max-w-[60ch] text-[11px] sm:text-[12px] leading-relaxed text-dim">
        Interest reaches you through the price of your share: nothing to claim, nothing to sign. A
        deposit buys shares at the same price a withdrawal sells them at, so you do not buy into
        interest earned before you came in.
      </p>

      <Heading>DEPOSIT</Heading>
      <div className="mt-3 flex flex-wrap items-end gap-3 text-[12px] sm:text-[13px]">
        <label className="flex flex-col gap-1">
          <span className="text-dim">amount, USDC</span>
          <input
            value={depositText}
            onChange={(event) => setDepositText(event.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="w-40 border border-rule bg-ground px-3 py-2 tnum outline-none focus:border-ink"
          />
        </label>
        <button
          type="button"
          disabled={!canDeposit}
          onClick={signDeposit}
          className="border border-ink px-4 py-2 text-[12px] tracking-[0.14em] disabled:border-rule disabled:text-dim"
        >
          SIGN AND DEPOSIT
        </button>
      </div>
      {depositShort && (
        <p className="mt-3 text-[12px] text-amber">
          Your wallet holds {formatUsd(balance.toString())}, less than this deposit.
        </p>
      )}

      <Heading>WITHDRAW</Heading>
      <div className="mt-3 flex flex-col gap-3 text-[12px] sm:text-[13px]">
        {option('all', 'everything')}
        <div className="flex flex-wrap items-center gap-3">
          {option('custom', 'up to, USDC')}
          <input
            value={withdrawText}
            onChange={(event) => {
              setWithdrawText(event.target.value)
              setChoice('custom')
            }}
            inputMode="decimal"
            placeholder="0.00"
            className="w-32 border border-rule bg-ground px-3 py-2 tnum outline-none focus:border-ink"
          />
        </div>
      </div>
      {quote?.ok === true && (
        <div className="mt-6 border-t border-rule">
          <DefRow label="you get" value={formatUsd(quote.paid.toString())} />
        </div>
      )}
      {explained !== null && (
        <p className="mt-3 max-w-[60ch] text-[12px] leading-relaxed text-amber">{explained}</p>
      )}
      <div className="mt-6">
        <button
          type="button"
          disabled={!canWithdraw}
          onClick={signWithdrawal}
          className="border border-ink px-4 py-2 text-[12px] tracking-[0.14em] disabled:border-rule disabled:text-dim"
        >
          SIGN AND WITHDRAW
        </button>
      </div>

      {stage.step === 'signing' && (
        <p className="mt-3 text-[12px] text-dim">waiting for the wallet…</p>
      )}
      {stage.step === 'confirming' && (
        <p className="mt-3 text-[12px] text-dim">waiting for devnet to confirm…</p>
      )}
      {stage.step === 'failed' && (
        <p className="mt-3 max-w-[60ch] text-[12px] leading-relaxed text-amber">
          {lendFailureText(stage.action, stage.failure)}
        </p>
      )}
      {stage.step === 'done' && (
        <p className="mt-3 text-[12px] leading-relaxed">
          {stage.text}{' '}
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
    </>
  )
}

export default Pool
