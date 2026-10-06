import {
  delegationInstructions,
  fetchOpenLoans,
  fetchRewardAccount,
  type LoanAccount,
  type OnChain,
  operatorAccountAddress,
  type RewardAccount,
  revokeInstruction,
} from '@drf/anchor-client'
import { debtCeiling } from '@drf/shared/loan'
import { type SolanaAddress, SUPPORTED_NETWORKS, solanaAddressSchema } from '@drf/shared/schemas'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { describeBorrowFailure } from '../lib/borrow'
import { chainConfig } from '../lib/chain'
import { formatCost, formatTokens } from '../lib/format'
import { delegationFor, foreignDelegate, type MandateState, mandateState } from '../lib/mandate'
import { useOperatorIdentity } from '../lib/wallet'

const DefRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-col gap-y-1 border-b border-rule py-3 text-[12px] sm:flex-row sm:items-baseline sm:justify-between sm:gap-x-6 sm:text-[14px]">
    <span className="text-dim sm:text-ink">{label}</span>
    <span className="text-right tnum">{value}</span>
  </div>
)

function secondsNow(): bigint {
  return BigInt(Math.floor(Date.now() / 1000))
}

type Token = { symbol: string; decimals: number }

type Row = {
  networkId: string
  displayName: string
  token: Token
  mint: PublicKey
  account: RewardAccount
  ceiling: bigint
  // null: the api had no rate, so the allowance the debt needs is unknown.
  target: bigint | null
}

type Board =
  | { status: 'loading' }
  | { status: 'unreachable'; message: string }
  | { status: 'ready'; rows: Row[] }

type Action =
  | { step: 'idle' }
  | { step: 'busy'; networkId: string }
  | { step: 'done'; networkId: string; signature: string }
  | { step: 'failed'; networkId: string; message: string }

const Mandate = () => {
  const identity = useOperatorIdentity()

  if (identity.status === 'connecting') {
    return <p className="text-[13px] text-dim">connecting the wallet…</p>
  }
  if (identity.status !== 'connected') {
    return (
      <p className="text-[13px] leading-relaxed text-dim">
        The mandate is your own wallet’s permission, so it is read and changed with it.{' '}
        <Link to="/lookup" className="text-ink underline underline-offset-4">
          Connect it
        </Link>{' '}
        first.
      </p>
    )
  }
  return <MandateBoard operator={identity.address} />
}

async function readRows(
  connection: ReturnType<typeof useConnection>['connection'],
  operator: PublicKey,
): Promise<Row[]> {
  const loans = await fetchOpenLoans(connection, operator)
  const now = secondsNow()
  return Promise.all(
    [...chainConfig.rewardMints].flatMap(([networkId, mint]) => {
      const network = SUPPORTED_NETWORKS.get(networkId)
      if (network === undefined) return []
      return [
        (async (): Promise<Row> => {
          const covered = loans.filter((loan: OnChain<LoanAccount>) =>
            loan.account.rewardMint.equals(mint),
          )
          const ceiling = debtCeiling(
            covered.map((loan) => loan.account),
            now,
          )
          const [account, rate] = await Promise.all([
            fetchRewardAccount(connection, operator, mint),
            ceiling === 0n
              ? Promise.resolve(null)
              : api.issueRateAttestation(solanaAddressSchema.parse(mint.toBase58())),
          ])
          const target =
            ceiling === 0n
              ? 0n
              : rate?.ok === true
                ? delegationFor({
                    loans: covered.map((loan) => loan.account),
                    rewardMint: mint,
                    rate: BigInt(rate.value.stablePerTrillionReward),
                    now,
                  }).allowance
                : null
          return {
            networkId,
            displayName: network.displayName,
            token: network.token,
            mint,
            account,
            ceiling,
            target,
          }
        })(),
      ]
    }),
  )
}

const MandateBoard = ({ operator }: { operator: SolanaAddress }) => {
  const { connection } = useConnection()
  const { sendTransaction } = useWallet()
  const operatorKey = useMemo(() => new PublicKey(operator), [operator])
  const ours = useMemo(() => operatorAccountAddress(operatorKey), [operatorKey])
  const [board, setBoard] = useState<Board>({ status: 'loading' })
  const [reads, setReads] = useState(0)
  const [action, setAction] = useState<Action>({ step: 'idle' })
  const [replace, setReplace] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    let live = true
    // `reads` only restarts the effect: a revoke or an approve changes the accounts.
    void reads
    setBoard({ status: 'loading' })
    readRows(connection, operatorKey)
      .then((rows) => {
        if (live) setBoard({ status: 'ready', rows })
      })
      .catch((error: unknown) => {
        if (live) {
          setBoard({
            status: 'unreachable',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => {
      live = false
    }
  }, [connection, operatorKey, reads])

  const send = async (networkId: string, build: () => Promise<TransactionInstruction[] | null>) => {
    setAction({ step: 'busy', networkId })
    try {
      const instructions = await build()
      if (instructions === null) {
        setAction({ step: 'idle' })
        setReads((n) => n + 1)
        return
      }
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const transaction = new Transaction({
        feePayer: operatorKey,
        blockhash,
        lastValidBlockHeight,
      }).add(...instructions)
      const signature = await sendTransaction(transaction, connection)
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      )
      if (confirmation.value.err !== null) {
        throw new Error(JSON.stringify(confirmation.value.err))
      }
      setAction({ step: 'done', networkId, signature })
      setReads((n) => n + 1)
    } catch (error) {
      const failure = describeBorrowFailure(error)
      setAction({
        step: 'failed',
        networkId,
        message:
          failure.kind === 'rejected'
            ? 'The wallet declined. Nothing was sent.'
            : failure.kind === 'program'
              ? failure.message
              : failure.kind === 'unknown'
                ? failure.message
                : 'The transaction did not go through.',
      })
    }
  }

  const revoke = (row: Row) =>
    send(row.networkId, async () => [
      revokeInstruction({ account: row.account.address, owner: operatorKey }),
    ])

  // Sized again at the click: the rate, the loans and the account are read now, not
  // taken from the screen, so the allowance does not outgrow the debt (FR-014a).
  const approve = (row: Row) =>
    send(row.networkId, async () => {
      const [loans, account, rate] = await Promise.all([
        fetchOpenLoans(connection, operatorKey),
        fetchRewardAccount(connection, operatorKey, row.mint),
        api.issueRateAttestation(solanaAddressSchema.parse(row.mint.toBase58())),
      ])
      if (!rate.ok) throw new Error('the api has no rate for this token right now')
      if (foreignDelegate(account, ours) !== null && !replace.has(row.networkId)) return null
      const { allowance } = delegationFor({
        loans: loans.map((loan) => loan.account),
        rewardMint: row.mint,
        rate: BigInt(rate.value.stablePerTrillionReward),
        now: secondsNow(),
      })
      if (allowance === 0n) return null
      return delegationInstructions({ operator: operatorKey, rewardMint: row.mint, allowance })
    })

  return (
    <div>
      <h1 className="text-[13px] sm:text-[15px] tracking-[0.18em] text-dim">MANDATE</h1>
      <p className="mt-4 max-w-[60ch] text-[11px] sm:text-[12px] leading-relaxed text-dim">
        A loan is repaid from the rewards of one network. To withhold them, the protocol is allowed
        to take from your reward account up to what those loans can be owed within their term, and
        never more than you owe. The account stays yours; revoking takes one transaction and needs
        nothing from the protocol.
      </p>

      {chainConfig.rewardMints.size === 0 && (
        <p className="mt-10 text-[13px] text-dim">
          No network can back a loan on this deployment, so there is nothing to delegate.
        </p>
      )}
      {board.status === 'loading' && (
        <p className="mt-10 text-[13px] text-dim">reading your reward accounts from devnet…</p>
      )}
      {board.status === 'unreachable' && (
        <p className="mt-10 text-[13px] text-dim">Devnet could not be read: {board.message}</p>
      )}
      {board.status === 'ready' &&
        board.rows.map((row) => (
          <MandateRow
            key={row.networkId}
            row={row}
            state={mandateState({
              account: row.account,
              ours,
              owed: row.ceiling > 0n,
              target: row.target,
            })}
            action={action.step !== 'idle' && action.networkId === row.networkId ? action : null}
            busy={action.step === 'busy'}
            replace={replace.has(row.networkId)}
            onReplace={(checked) =>
              setReplace((current) => {
                const next = new Set(current)
                if (checked) next.add(row.networkId)
                else next.delete(row.networkId)
                return next
              })
            }
            onRevoke={() => void revoke(row)}
            onApprove={() => void approve(row)}
          />
        ))}
    </div>
  )
}

const MandateRow = ({
  row,
  state,
  action,
  busy,
  replace,
  onReplace,
  onRevoke,
  onApprove,
}: {
  row: Row
  state: MandateState
  action: Exclude<Action, { step: 'idle' }> | null
  busy: boolean
  replace: boolean
  onReplace: (checked: boolean) => void
  onRevoke: () => void
  onApprove: () => void
}) => {
  const { symbol, decimals } = row.token
  const tokens = (amount: bigint) => `${formatTokens(amount.toString(), decimals)} ${symbol}`
  const button =
    'border border-ink px-4 py-2 text-[12px] tracking-[0.14em] disabled:border-rule disabled:text-dim'
  const target = state.kind === 'missing' || state.kind === 'active' ? state.target : null
  const delegated = state.kind === 'idle' || state.kind === 'active' ? state.delegatedAmount : 0n
  const foreign = state.kind === 'missing' ? state.foreign : null
  const canApprove =
    target !== null && target > 0n && target !== delegated && (foreign === null || replace)

  return (
    <section className="mt-12">
      <h2 className="text-[11px] sm:text-[12px] tracking-[0.14em] text-dim">
        {row.displayName.toUpperCase()} · {symbol}
      </h2>
      <div className="mt-3 border-t border-rule">
        <DefRow
          label="most owed within the term on loans repaid from it"
          value={formatCost(row.ceiling)}
        />
        <DefRow label="the protocol may withhold" value={tokens(delegated)} />
        {target !== null && row.ceiling > 0n && (
          <DefRow label="what that debt needs, at the attested rate" value={tokens(target)} />
        )}
      </div>

      <p className="mt-4 max-w-[60ch] text-[12px] leading-relaxed">
        {state.kind === 'none' && `Nothing is owed on ${symbol} loans and nothing is delegated.`}
        {state.kind === 'idle' &&
          `Nothing is owed on ${symbol} loans, yet the protocol may still take ${tokens(delegated)}. Revoke it.`}
        {state.kind === 'missing' &&
          (target === null
            ? 'Nothing is delegated, so these loans are repaid by hand. The api has no rate right now, so the permission cannot be sized.'
            : 'Nothing is delegated, so these loans are not repaid from rewards: they are repaid by hand.')}
        {state.kind === 'active' &&
          target !== null &&
          (delegated > target
            ? 'The permission is worth more than the debt now. Set it to what the debt needs.'
            : delegated < target
              ? 'The permission no longer covers the debt. Set it again, or repay by hand.'
              : 'The permission covers the debt and no more.')}
        {state.kind === 'active' &&
          target === null &&
          'The api has no rate right now, so whether it covers the debt cannot be said.'}
      </p>

      {foreign !== null && (
        <div className="mt-4 max-w-[60ch] text-[12px] leading-relaxed text-amber">
          <p>
            The account already lets {foreign.delegate.toBase58()} take up to{' '}
            {tokens(foreign.delegatedAmount)}. An account has one delegate: setting ours replaces
            that permission.
          </p>
          <label className="mt-3 flex items-center gap-2 text-ink">
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => onReplace(event.target.checked)}
              className="accent-current"
            />
            <span>Replace it</span>
          </label>
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        {target !== null && target > 0n && (
          <button
            type="button"
            disabled={!canApprove || busy}
            onClick={onApprove}
            className={button}
          >
            SET TO {tokens(target).toUpperCase()}
          </button>
        )}
        {delegated > 0n && (
          <button type="button" disabled={busy} onClick={onRevoke} className={button}>
            REVOKE
          </button>
        )}
      </div>
      {action?.step === 'busy' && (
        <p className="mt-3 text-[12px] text-dim">waiting for the wallet and devnet…</p>
      )}
      {action?.step === 'failed' && (
        <p className="mt-3 max-w-[60ch] text-[12px] leading-relaxed text-amber">{action.message}</p>
      )}
      {action?.step === 'done' && (
        <p className="mt-3 text-[12px] leading-relaxed">
          Done.{' '}
          <a
            href={`https://explorer.solana.com/tx/${action.signature}?cluster=devnet`}
            className="underline underline-offset-4"
            target="_blank"
            rel="noreferrer"
          >
            transaction
          </a>
        </p>
      )}
    </section>
  )
}

export default Mandate
