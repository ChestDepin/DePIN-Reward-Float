import {
  approveInstruction,
  fetchOpenLoans,
  fetchPool,
  fetchRewardAccount,
  fetchStableBalance,
  type LoanAccount,
  type OnChain,
  operatorAccountAddress,
  type PoolAccount,
  type RewardAccount,
  repayInstruction,
  revokeInstruction,
  rewardFloatProgram,
} from '@drf/anchor-client'
import type { WithholdingEntry } from '@drf/shared/api'
import {
  allocateRepayment,
  loanPosition,
  type NextPayment,
  operatorPosition,
  repayAllAmount,
} from '@drf/shared/loan'
import { type SolanaAddress, SUPPORTED_NETWORKS, solanaAddressSchema } from '@drf/shared/schemas'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import {
  type Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Empty } from '../components/Answer'
import { type ApiFailure, api, useResource } from '../lib/api'
import { type BorrowFailure, describeBorrowFailure, parseStableAmount } from '../lib/borrow'
import { chainConfig } from '../lib/chain'
import { formatBps, formatCost, formatRate, formatTokens, formatUsd } from '../lib/format'
import {
  delegationAfterRepayment,
  manualRepaymentText,
  type RepaymentDelegation,
} from '../lib/mandate'
import { useAddressParam, useOperatorIdentity } from '../lib/wallet'

type Loans =
  | { status: 'loading' }
  | { status: 'unreachable'; message: string }
  | { status: 'ready'; loans: OnChain<LoanAccount>[] }

const DefRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-col gap-y-1 border-b border-rule py-3 text-[12px] sm:flex-row sm:items-baseline sm:justify-between sm:gap-x-6 sm:text-[14px]">
    <span className="text-dim sm:text-ink">{label}</span>
    <span className="text-right tnum">{value}</span>
  </div>
)

function day(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10)
}

function nextText(next: NextPayment): string {
  const amount = formatCost(next.principal + next.interest)
  return next.kind === 'instalment'
    ? `${amount} by ${day(next.dueAt)}`
    : `${amount} now, late since ${day(next.since)}`
}

function secondsNow(): bigint {
  return BigInt(Math.floor(Date.now() / 1000))
}

// A minute, not a second: shown in cents, a few hundred dollars of debt takes hours to
// move by one, and a page re-rendered every second would show the same figure anyway.
function useNow(): bigint {
  const [now, setNow] = useState(secondsNow)
  useEffect(() => {
    const timer = setInterval(() => setNow(secondsNow()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

const Position = () => {
  const address = useAddressParam()
  const identity = useOperatorIdentity()
  const { connection } = useConnection()
  const now = useNow()
  const [loans, setLoans] = useState<Loans>({ status: 'loading' })
  const [reads, setReads] = useState(0)
  // Kept here, not in the repay form: rereading the loans unmounts the form, and after a
  // full repayment there is no form left to show it in.
  const [repaid, setRepaid] = useState<string | null>(null)
  useEffect(() => {
    void address
    setRepaid(null)
  }, [address])

  useEffect(() => {
    if (address === null) return
    let live = true
    // `reads` only restarts the effect: a repayment changes the loans on the chain.
    void reads
    setLoans({ status: 'loading' })
    fetchOpenLoans(connection, new PublicKey(address))
      .then((found) => {
        if (live) setLoans({ status: 'ready', loans: found })
      })
      .catch((error: unknown) => {
        if (live) {
          setLoans({
            status: 'unreachable',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => {
      live = false
    }
  }, [connection, address, reads])
  const owner = identity.status === 'connected' && identity.address === address

  return (
    <div>
      <h1 className="text-[13px] sm:text-[15px] tracking-[0.18em] text-dim">POSITION</h1>
      <p className="mt-2 break-all text-[11px] sm:text-[12px] text-dim">{address ?? '—'}</p>
      {repaid !== null && (
        <p className="mt-6 text-[12px] leading-relaxed">
          Repaid.{' '}
          <a
            href={`https://explorer.solana.com/tx/${repaid}?cluster=devnet`}
            className="underline underline-offset-4"
            target="_blank"
            rel="noreferrer"
          >
            transaction
          </a>
        </p>
      )}

      {address === null && (
        <Empty>This is not a Solana address, so there is nothing to read.</Empty>
      )}
      {address !== null && loans.status === 'loading' && (
        <p className="mt-10 text-[13px] text-dim">reading open loans from devnet…</p>
      )}
      {address !== null && loans.status === 'unreachable' && (
        <Empty>Devnet could not be read: {loans.message}</Empty>
      )}
      {address !== null && loans.status === 'ready' && loans.loans.length === 0 && (
        <Empty>
          No open loans.{' '}
          <Link to="/borrow" className="text-ink underline underline-offset-4">
            Borrow
          </Link>
        </Empty>
      )}
      {address !== null && loans.status === 'ready' && loans.loans.length > 0 && (
        <>
          <Open loans={loans.loans} now={now} />
          {owner && (
            <Repay
              operator={new PublicKey(address)}
              loans={loans.loans}
              now={now}
              onRepaid={(signature) => {
                setRepaid(signature)
                setReads((n) => n + 1)
              }}
            />
          )}
        </>
      )}
      {address !== null && <Journal address={address} />}
    </div>
  )
}

const Open = ({ loans, now }: { loans: OnChain<LoanAccount>[]; now: bigint }) => {
  const total = operatorPosition(
    loans.map((loan) => loan.account),
    now,
  )
  const cell = 'py-2 text-right'

  return (
    <>
      <div className="mt-8 border-t border-rule">
        <DefRow label="owed now" value={formatCost(total.owed)} />
        <DefRow label="principal left" value={formatCost(total.outstanding)} />
        <DefRow label="interest accrued" value={formatCost(total.interest)} />
        {total.next !== null && <DefRow label="next payment" value={nextText(total.next)} />}
      </div>

      <h2 className="mt-12 text-[11px] sm:text-[12px] tracking-[0.14em] text-dim">LOANS</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-t border-rule text-[12px] sm:text-[13px] tnum">
          <thead className="text-dim">
            <tr className="border-b border-rule">
              <th className="py-2 text-left font-normal">term ends</th>
              <th className={`${cell} font-normal`}>rate</th>
              <th className={`${cell} font-normal`}>principal left</th>
              <th className={`${cell} font-normal`}>interest</th>
              <th className={`${cell} font-normal`}>next payment</th>
            </tr>
          </thead>
          <tbody>
            {loans.map(({ address, account }) => {
              const position = loanPosition(account, now)
              const manual = account.manualRepayment
              return (
                <Fragment key={address.toBase58()}>
                  <tr className={manual === null ? 'border-b border-rule' : ''}>
                    <td className="py-2">
                      {day(account.dueAt)}
                      {account.status === 'overdue' && <span className="text-amber"> overdue</span>}
                      {manual !== null && <span className="text-amber"> manual</span>}
                    </td>
                    <td className={cell}>{(account.aprBps / 100).toFixed(2)}%</td>
                    <td className={cell}>{formatCost(position.outstanding)}</td>
                    <td className={cell}>{formatCost(position.interest)}</td>
                    <td className={cell}>{nextText(position.next)}</td>
                  </tr>
                  {manual !== null && (
                    <tr className="border-b border-rule text-amber">
                      <td colSpan={5} className="pb-2 text-[11px] sm:text-[12px] leading-relaxed">
                        {manualRepaymentText(manual)}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-6 max-w-[60ch] text-[11px] sm:text-[12px] leading-relaxed text-dim">
        Interest runs by the second on the principal left; the figures above are brought up to the
        minute. A payment includes the interest that will have accrued by its date. Paying ahead
        moves the next date out; an instalment left unpaid stays due until it is paid.
      </p>
    </>
  )
}

// rate: null when the api has none, or when the account holds no permission of ours to
// move and so none was asked for.
type Reward = { mint: PublicKey; account: RewardAccount; rate: bigint | null }

type RepayChain =
  | { status: 'loading' }
  | { status: 'unreachable'; message: string }
  | {
      status: 'ready'
      pools: Map<string, OnChain<PoolAccount>>
      balance: bigint
      rewards: Reward[]
    }

async function readRewards(
  connection: Connection,
  operator: PublicKey,
  mints: readonly string[],
): Promise<Reward[]> {
  const ours = operatorAccountAddress(operator)
  return Promise.all(
    mints.map(async (key) => {
      const mint = new PublicKey(key)
      const account = await fetchRewardAccount(connection, operator, mint)
      const rate =
        account.exists && account.delegate?.equals(ours) === true
          ? await api.issueRateAttestation(solanaAddressSchema.parse(key))
          : null
      return {
        mint,
        account,
        rate: rate?.ok === true ? BigInt(rate.value.stablePerTrillionReward) : null,
      }
    }),
  )
}

function rewardToken(mint: PublicKey): { symbol: string; decimals: number } | null {
  for (const [networkId, configured] of chainConfig.rewardMints) {
    if (configured.equals(mint)) return SUPPORTED_NETWORKS.get(networkId)?.token ?? null
  }
  return null
}

function minute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

function tokensText(baseUnits: string, mint: SolanaAddress): string {
  const token = rewardToken(new PublicKey(mint))
  return token === null
    ? `${baseUnits} base units`
    : `${formatTokens(baseUnits, token.decimals)} ${token.symbol}`
}

function rateText(entry: WithholdingEntry): string {
  const token = rewardToken(new PublicKey(entry.rewardMint))
  return token === null
    ? `${entry.stablePerTrillionReward} per 10^12 base units`
    : formatRate(entry.stablePerTrillionReward, token.decimals)
}

function journalFailureText(failure: ApiFailure): string {
  if (failure.kind === 'data-unavailable') return 'The api could not read the withholdings.'
  if (failure.kind === 'unreachable') return 'The api could not be reached.'
  return 'The api answered something this page cannot read.'
}

const Explorer = ({ signature, children }: { signature: string; children: string }) => (
  <a
    href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}
    className="underline underline-offset-4"
    target="_blank"
    rel="noreferrer"
  >
    {children}
  </a>
)

// FR-016: read from the api, not from the open loans above, so a withholding that closed
// its loan stays in the journal.
const Journal = ({ address }: { address: SolanaAddress }) => {
  const load = useCallback(() => api.withholdings(address), [address])
  const journal = useResource(load)
  const cell = 'whitespace-nowrap py-2 pl-5 text-right'

  return (
    <>
      <h2 className="mt-12 text-[11px] sm:text-[12px] tracking-[0.14em] text-dim">WITHHOLDINGS</h2>
      {journal.status === 'loading' && (
        <p className="mt-3 text-[12px] text-dim">reading the withholdings…</p>
      )}
      {journal.status === 'done' && !journal.result.ok && (
        <p className="mt-3 text-[12px] text-amber">{journalFailureText(journal.result.failure)}</p>
      )}
      {journal.status === 'done' &&
        journal.result.ok &&
        journal.result.value.entries.length === 0 && (
          <p className="mt-3 text-[12px] text-dim">
            Nothing has been withheld from your rewards yet.
          </p>
        )}
      {journal.status === 'done' &&
        journal.result.ok &&
        journal.result.value.entries.length > 0 && (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-t border-rule text-[12px] sm:text-[13px] tnum">
                <thead className="text-dim">
                  <tr className="border-b border-rule">
                    <th className="whitespace-nowrap py-2 text-left font-normal">when, UTC</th>
                    <th className={`${cell} font-normal`}>withheld</th>
                    <th className={`${cell} font-normal`}>rate, $ per token</th>
                    <th className={`${cell} font-normal`}>deviation</th>
                    <th className={`${cell} font-normal`}>repaid</th>
                    <th className={`${cell} font-normal`}>loan left</th>
                  </tr>
                </thead>
                <tbody>
                  {journal.result.value.entries.map((entry) =>
                    entry.kind === 'withheld' ? (
                      <tr key={`${entry.signature}:${entry.loan}`} className="border-b border-rule">
                        <td className="whitespace-nowrap py-2">
                          <Explorer signature={entry.signature}>{minute(entry.blockTime)}</Explorer>
                        </td>
                        <td className={cell}>{tokensText(entry.withheld, entry.rewardMint)}</td>
                        <td className={cell}>{rateText(entry)}</td>
                        <td className={cell}>{formatBps(entry.deviationBps)}</td>
                        <td className={cell}>{formatUsd(entry.paid)}</td>
                        <td className={cell}>
                          {entry.remainingDebt === '0'
                            ? 'repaid'
                            : formatCost(BigInt(entry.remainingDebt))}
                        </td>
                      </tr>
                    ) : (
                      <Fragment key={entry.signature}>
                        <tr className="text-amber">
                          <td className="whitespace-nowrap py-2">
                            <Explorer signature={entry.signature}>{minute(entry.lastAt)}</Explorer>
                          </td>
                          <td className={cell}>—</td>
                          <td className={cell}>{rateText(entry)}</td>
                          <td className={cell}>{formatBps(entry.deviationBps)}</td>
                          <td className={cell}>—</td>
                          <td className={cell}>—</td>
                        </tr>
                        <tr className="border-b border-rule text-amber">
                          <td
                            colSpan={6}
                            className="pb-2 text-[11px] sm:text-[12px] leading-relaxed"
                          >
                            Over the {formatBps(entry.maxSlippageBps)} the pool allows, so the{' '}
                            {tokensText(entry.attempted, entry.rewardMint)} due were not withheld.
                            {entry.attempts > 1 &&
                              ` ${entry.attempts} tries since ${minute(entry.firstAt)}, the worst at ${formatBps(entry.worstDeviationBps)}.`}
                          </td>
                        </tr>
                      </Fragment>
                    ),
                  )}
                </tbody>
              </table>
            </div>
            {!journal.result.value.complete && (
              <p className="mt-3 text-[12px] text-dim">Older entries are not shown.</p>
            )}
            <p className="mt-6 max-w-[60ch] text-[11px] sm:text-[12px] leading-relaxed text-dim">
              A withholding sells part of a reward at the attested rate and repays the loan with
              what the sale brought. The deviation is how much less the sale brought than the rate
              promised. When it is more than the pool allows, nothing is withheld, the reward stays
              in your wallet, and the next sweep tries again.
            </p>
          </>
        )}
    </>
  )
}

type Moved = Exclude<RepaymentDelegation, { kind: 'keep' }>

function delegationText(delegation: Moved, mint: PublicKey): string {
  if (delegation.kind === 'revoke') return 'nothing, the permission is revoked'
  const token = rewardToken(mint)
  return token === null
    ? `${delegation.allowance} base units`
    : `${formatTokens(delegation.allowance.toString(), token.decimals)} ${token.symbol}`
}

type Choice = 'next' | 'all' | 'custom'

type RepayStage =
  | { step: 'idle' }
  | { step: 'signing' | 'confirming' }
  | { step: 'failed'; failure: BorrowFailure }

function repayFailureText(failure: BorrowFailure): string {
  if (failure.kind === 'rejected') return 'The wallet declined. Nothing was sent.'
  if (failure.kind === 'program') return `The program refused the repayment: ${failure.message}.`
  return `The repayment did not go through${failure.kind === 'unknown' ? `: ${failure.message}` : '.'}`
}

const Repay = ({
  operator,
  loans,
  now,
  onRepaid,
}: {
  operator: PublicKey
  loans: OnChain<LoanAccount>[]
  now: bigint
  onRepaid: (signature: string) => void
}) => {
  const { connection } = useConnection()
  const { sendTransaction } = useWallet()
  const program = useMemo(() => rewardFloatProgram(connection), [connection])
  const [chain, setChain] = useState<RepayChain>({ status: 'loading' })
  const [choice, setChoice] = useState<Choice>('next')
  const [customText, setCustomText] = useState('')
  const [stage, setStage] = useState<RepayStage>({ step: 'idle' })

  const poolKeys = useMemo(
    () => [...new Set(loans.map((loan) => loan.account.pool.toBase58()))],
    [loans],
  )
  const rewardKeys = useMemo(
    () => [...new Set(loans.map((loan) => loan.account.rewardMint.toBase58()))],
    [loans],
  )
  const ours = useMemo(() => operatorAccountAddress(operator), [operator])
  useEffect(() => {
    let live = true
    Promise.all([
      Promise.all(poolKeys.map((pool) => fetchPool(connection, new PublicKey(pool)))),
      readRewards(connection, operator, rewardKeys),
    ])
      .then(async ([pools, rewards]) => {
        // One pool per stablecoin, and the page lends one stablecoin, so one balance.
        const stableMint = pools[0]?.account.stableMint
        const balance =
          stableMint === undefined ? 0n : await fetchStableBalance(connection, operator, stableMint)
        if (live) {
          setChain({
            status: 'ready',
            pools: new Map(pools.map((pool) => [pool.address.toBase58(), pool])),
            balance,
            rewards,
          })
        }
      })
      .catch((error: unknown) => {
        if (live) {
          setChain({
            status: 'unreachable',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => {
      live = false
    }
  }, [connection, operator, poolKeys, rewardKeys])

  const states = loans.map((loan) => loan.account)
  const amountAt = (at: bigint): bigint | null => {
    if (choice === 'all') return repayAllAmount(states, at)
    if (choice === 'custom') return parseStableAmount(customText)
    const next = operatorPosition(states, at).next
    return next === null ? null : next.principal + next.interest
  }
  const amount = amountAt(now)
  const allocation = amount === null ? null : allocateRepayment(states, amount, now)
  // Repaying everything asks for a little more than is owed, and only what is owed is
  // taken; the wallet needs to hold the debt, not the ceiling.
  const needed = choice === 'all' ? operatorPosition(states, now).owed : amount
  const short = chain.status === 'ready' && needed !== null && needed > chain.balance
  const busy = stage.step === 'signing' || stage.step === 'confirming'
  const canSign = chain.status === 'ready' && allocation?.ok === true && !short && !busy
  const moved = (rewards: readonly Reward[], perLoan: readonly bigint[], at: bigint) =>
    rewards.flatMap((reward) => {
      const delegation = delegationAfterRepayment({
        loans: states,
        perLoan,
        rewardMint: reward.mint,
        account: reward.account,
        ours,
        rate: reward.rate,
        at,
      })
      return delegation.kind === 'keep' ? [] : [{ reward, delegation }]
    })
  const delegations =
    chain.status === 'ready' && allocation?.ok === true
      ? moved(chain.rewards, allocation.perLoan, now)
      : []

  const sign = async () => {
    if (chain.status !== 'ready') return
    const at = secondsNow()
    const fresh = amountAt(at)
    const split = fresh === null ? null : allocateRepayment(states, fresh, at)
    if (split === null || !split.ok) return
    try {
      // The accounts and the rate are read again here, not taken from the screen: the
      // operator may have revoked since, and the allowance must not outgrow the debt.
      const [repays, rewards] = await Promise.all([
        Promise.all(
          loans.flatMap((loan, index) => {
            const maxAmount = split.perLoan[index] ?? 0n
            const pool = chain.pools.get(loan.account.pool.toBase58())
            if (maxAmount === 0n || pool === undefined) return []
            return [repayInstruction(program, { payer: operator, pool, loan, maxAmount })]
          }),
        ),
        readRewards(connection, operator, rewardKeys),
      ])
      const permissions = moved(rewards, split.perLoan, at).map(
        ({ reward, delegation }): TransactionInstruction =>
          delegation.kind === 'revoke'
            ? revokeInstruction({ account: reward.account.address, owner: operator })
            : approveInstruction({
                account: reward.account.address,
                delegate: ours,
                owner: operator,
                amount: delegation.allowance,
              }),
      )
      const instructions = [...repays, ...permissions]
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const transaction = new Transaction({
        feePayer: operator,
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
      onRepaid(signature)
    } catch (error) {
      setStage({ step: 'failed', failure: describeBorrowFailure(error) })
    }
  }

  const option = (value: Choice, label: string) => (
    <label className="flex items-center gap-2">
      <input
        type="radio"
        name="repay"
        checked={choice === value}
        onChange={() => setChoice(value)}
        className="accent-current"
      />
      <span>{label}</span>
    </label>
  )

  return (
    <>
      <h2 className="mt-12 text-[11px] sm:text-[12px] tracking-[0.14em] text-dim">REPAY</h2>
      {chain.status === 'loading' && (
        <p className="mt-3 text-[12px] text-dim">reading the pool and your balance…</p>
      )}
      {chain.status === 'unreachable' && (
        <p className="mt-3 text-[12px] text-amber">Devnet could not be read: {chain.message}</p>
      )}
      {chain.status === 'ready' && (
        <>
          <div className="mt-3 border-t border-rule">
            <DefRow label="in your wallet" value={formatCost(chain.balance)} />
          </div>
          <div className="mt-4 flex flex-col gap-3 text-[12px] sm:text-[13px]">
            {option('next', 'the next payment')}
            {option('all', 'everything, closing every loan')}
            <div className="flex flex-wrap items-center gap-3">
              {option('custom', 'another amount, USDC')}
              <input
                value={customText}
                onChange={(event) => {
                  setCustomText(event.target.value)
                  setChoice('custom')
                }}
                inputMode="decimal"
                placeholder="0.00"
                className="w-32 border border-rule bg-ground px-3 py-2 tnum outline-none focus:border-ink"
              />
            </div>
          </div>

          {amount !== null && allocation?.ok === true && (
            <div className="mt-6 border-t border-rule">
              <DefRow
                label={choice === 'all' ? 'at most' : 'you repay'}
                value={formatCost(amount)}
              />
            </div>
          )}
          {allocation?.ok === false && allocation.reason === 'over-debt' && (
            <p className="mt-3 text-[12px] text-amber">
              That is more than everything owed: up to {formatCost(allocation.max)}.
            </p>
          )}
          {delegations.length > 0 && (
            <div>
              {delegations.map(({ reward, delegation }) => (
                <DefRow
                  key={reward.mint.toBase58()}
                  label={`then the protocol may withhold from your ${rewardToken(reward.mint)?.symbol ?? reward.mint.toBase58()}`}
                  value={delegationText(delegation, reward.mint)}
                />
              ))}
            </div>
          )}
          {delegations.some(
            ({ reward, delegation }) => delegation.kind === 'set' && reward.rate === null,
          ) && (
            <p className="mt-3 max-w-[60ch] text-[12px] leading-relaxed text-dim">
              The api has no rate right now, so the permission is lowered in proportion to the debt.
              Set it at the attested rate on the{' '}
              <Link to="/mandate" className="text-ink underline underline-offset-4">
                mandate
              </Link>{' '}
              page later.
            </p>
          )}
          {short && allocation?.ok === true && (
            <p className="mt-3 text-[12px] text-amber">
              Your wallet holds {formatCost(chain.balance)}, less than this repayment.
            </p>
          )}
          <p className="mt-6 max-w-[60ch] text-[11px] sm:text-[12px] leading-relaxed text-dim">
            Interest is paid before principal, and what is due now before what is due later.
            Repaying everything allows for ten minutes more of interest, since the debt grows while
            the transaction is on its way; only the debt is taken, the rest stays in the wallet.
          </p>

          <div className="mt-6">
            <button
              type="button"
              disabled={!canSign}
              onClick={() => void sign()}
              className="border border-ink px-4 py-2 text-[12px] tracking-[0.14em] disabled:border-rule disabled:text-dim"
            >
              SIGN AND REPAY
            </button>
            {stage.step === 'signing' && (
              <p className="mt-3 text-[12px] text-dim">waiting for the wallet…</p>
            )}
            {stage.step === 'confirming' && (
              <p className="mt-3 text-[12px] text-dim">waiting for devnet to confirm…</p>
            )}
            {stage.step === 'failed' && (
              <p className="mt-3 max-w-[60ch] text-[12px] leading-relaxed text-amber">
                {repayFailureText(stage.failure)}
              </p>
            )}
          </div>
        </>
      )}
    </>
  )
}

export default Position
