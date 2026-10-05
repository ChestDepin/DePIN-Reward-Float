import { fetchOpenLoans, type LoanAccount, type OnChain } from '@drf/anchor-client'
import { loanPosition, type NextPayment, operatorPosition } from '@drf/shared/loan'
import { useConnection } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Empty } from '../components/Answer'
import { formatCost } from '../lib/format'
import { useAddressParam } from '../lib/wallet'

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

// A minute, not a second: shown in cents, a few hundred dollars of debt takes hours to
// move by one, and a page re-rendered every second would show the same figure anyway.
function useNow(): bigint {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)))
  useEffect(() => {
    const timer = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

const Position = () => {
  const address = useAddressParam()
  const { connection } = useConnection()
  const now = useNow()
  const [loans, setLoans] = useState<Loans>({ status: 'loading' })

  useEffect(() => {
    if (address === null) return
    let live = true
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
  }, [connection, address])

  return (
    <div>
      <h1 className="text-[13px] sm:text-[15px] tracking-[0.18em] text-dim">POSITION</h1>
      <p className="mt-2 break-all text-[11px] sm:text-[12px] text-dim">{address ?? '—'}</p>

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
        <Open loans={loans.loans} now={now} />
      )}
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
              return (
                <tr key={address.toBase58()} className="border-b border-rule">
                  <td className="py-2">
                    {day(account.dueAt)}
                    {account.status === 'overdue' && <span className="text-amber"> overdue</span>}
                  </td>
                  <td className={cell}>{(account.aprBps / 100).toFixed(2)}%</td>
                  <td className={cell}>{formatCost(position.outstanding)}</td>
                  <td className={cell}>{formatCost(position.interest)}</td>
                  <td className={cell}>{nextText(position.next)}</td>
                </tr>
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

export default Position
