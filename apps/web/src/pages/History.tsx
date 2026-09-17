import type { NetworkPayoutHistory } from '@drf/shared/api'
import { useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Empty, Failed, Loading } from '../components/Answer'
import { api, useResource } from '../lib/api'
import { formatTokens, formatUsd } from '../lib/format'
import { useAddressParam } from '../lib/wallet'

const COLS = 'sm:grid sm:grid-cols-[72px_1fr_1fr_120px] sm:gap-x-4 sm:items-center'

const sum = (values: readonly (string | null)[]) =>
  values.reduce((total, value) => total + BigInt(value ?? 0), 0n)

const Network = ({ network }: { network: NetworkPayoutHistory }) => {
  const paid = network.months.filter((month) => month.payoutCount > 0)
  const priced = network.months.map((month) => month.valueUsd)
  const largest = priced.reduce((top, value) => {
    const usd = BigInt(value ?? 0)

    return usd > top ? usd : top
  }, 0n)
  const unpriced = network.months.filter(
    (month) => month.payoutCount > 0 && month.valueUsd === null,
  )
  const sources = [...new Set(network.payouts.map((payout) => payout.source))]
  const times = network.payouts.map((payout) => payout.blockTime).sort()
  const newest = network.payouts.reduce<(typeof network.payouts)[number] | null>(
    (latest, payout) => (latest === null || payout.blockTime > latest.blockTime ? payout : latest),
    null,
  )

  return (
    <section className="mt-12 first:mt-0">
      <h2 className="text-[13px] sm:text-[15px] tracking-[0.16em]">
        {network.displayName.toUpperCase()} · {network.token.symbol}
      </h2>

      <div className="mt-6 border-t border-rule">
        <div
          className={`hidden border-b border-rule py-2 text-[11px] tracking-[0.12em] text-dim ${COLS}`}
        >
          <span>MONTH</span>
          <span className="text-right">{network.token.symbol}</span>
          <span className="text-right">VALUE</span>
          <span />
        </div>

        {network.months.map((month) => {
          const value = month.valueUsd
          const empty = month.payoutCount === 0
          const width = largest === 0n || value === null ? 0 : Number((BigInt(value) * 100n) / largest)

          return (
            <div
              key={month.month}
              className={`border-b border-rule py-3 text-[12px] sm:text-[13px] ${empty ? 'text-dim' : 'text-ink'} ${COLS}`}
            >
              <span className="block">{month.month}</span>

              <span className="mt-2 flex justify-between sm:hidden">
                <span className="text-dim">{network.token.symbol}</span>
                <span className="tnum">
                  {empty ? '—' : formatTokens(month.amount, network.token.decimals)}
                </span>
              </span>
              <span className="flex justify-between sm:hidden">
                <span className="text-dim">value</span>
                <span className="tnum">
                  {empty ? 'no payout' : value === null ? 'no price' : formatUsd(value)}
                </span>
              </span>

              <span className="hidden text-right tnum sm:block">
                {empty ? '—' : formatTokens(month.amount, network.token.decimals)}
              </span>
              <span className="hidden text-right tnum sm:block">
                {empty ? 'no payout' : value === null ? 'no price' : formatUsd(value)}
              </span>

              <span className="mt-3 block h-[6px] w-full sm:mt-0">
                {width > 0 && <span className="block h-[6px] bg-ink" style={{ width: `${width}%` }} />}
              </span>
            </div>
          )
        })}
      </div>

      <p className="mt-4 text-[12px] sm:text-[13px]">
        {network.months.length} months observed · {paid.length} months with payouts ·{' '}
        {formatUsd(sum(priced).toString())}
        {unpriced.length > 0 && ' (incomplete — some months have no price)'}
      </p>

      <div className="mt-8 border-t border-rule pt-4">
        <h3 className="text-[11px] tracking-[0.14em] text-dim">SOURCE</h3>
        <div className="mt-3 space-y-1 text-[11px] sm:text-[12px] text-dim">
          {sources.map((source) => (
            <div key={source} className="flex flex-col gap-y-0.5 sm:flex-row sm:gap-x-4">
              <span className="w-[110px] shrink-0">payout source</span>
              <span className="break-all">{source}</span>
            </div>
          ))}
          <div className="flex flex-col gap-y-0.5 sm:flex-row sm:gap-x-4">
            <span className="w-[110px] shrink-0">first payout</span>
            <span>{times[0]?.slice(0, 10) ?? '—'}</span>
          </div>
          <div className="flex flex-col gap-y-0.5 sm:flex-row sm:gap-x-4">
            <span className="w-[110px] shrink-0">last indexed</span>
            <span>
              {newest === null
                ? '—'
                : `${newest.blockTime.slice(0, 10)} · slot ${Number(newest.slot).toLocaleString('en-US')}`}
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

const History = () => {
  const address = useAddressParam()
  const history = useResource(
    useCallback(
      () =>
        address === null
          ? Promise.resolve({ ok: false as const, failure: { kind: 'invalid-address' as const } })
          : api.payoutHistory(address),
      [address],
    ),
  )

  return (
    <div>
      <h1 className="text-[13px] sm:text-[15px] tracking-[0.16em] text-dim">PAYOUT HISTORY</h1>
      <p className="mt-2 break-all text-[11px] sm:text-[12px] text-dim">{address ?? '—'}</p>

      {history.status === 'loading' && <Loading what="the payout history" />}

      {history.status === 'done' && !history.result.ok && (
        <Failed failure={history.result.failure} />
      )}

      {history.status === 'done' && history.result.ok && (
        <>
          {history.result.value.networks.length === 0 ? (
            <Empty>
              No recognised reward payouts for this address in {history.result.value.period.from} …{' '}
              {history.result.value.period.to}. Nothing was hidden — nothing was found.
            </Empty>
          ) : (
            <div className="mt-10">
              {history.result.value.networks.map((network) => (
                <Network key={network.networkId} network={network} />
              ))}
            </div>
          )}

          {address !== null && (
            <div className="mt-10">
              <Link
                to={`/limit/${address}`}
                className="inline-block border border-rule px-4 py-2 text-[12px] sm:text-[13px] text-ink hover:border-ink"
              >
                CONTINUE →
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default History
