import type { LimitFactorView, LimitRefusal, NetworkCreditLimit } from '@drf/shared/api'
import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { Empty, Failed, Loading } from '../components/Answer'
import { api, useResource } from '../lib/api'
import { formatUsd } from '../lib/format'
import { useAddressParam } from '../lib/wallet'

const FACTOR_LABEL: Record<LimitFactorView['name'], { label: string; clause: string }> = {
  'median-flow': {
    label: 'median monthly flow',
    clause: 'middle month of the observed year, valued at a recent price',
  },
  stability: {
    label: 'payout stability',
    clause: 'months without a payout lower the advance',
  },
  volatility: {
    label: 'volatility haircut',
    clause: 'the token can fall before the loan is repaid',
  },
}

const signed = (deltaUsd: string) =>
  deltaUsd.startsWith('-') ? `− ${formatUsd(deltaUsd.slice(1))}` : `+ ${formatUsd(deltaUsd)}`

const Refusal = ({ reason }: { reason: LimitRefusal }) => {
  if (reason.kind === 'short-history') {
    return (
      <>
        <p className="mt-6 max-w-[52ch] text-[15px] sm:text-[20px] leading-relaxed text-ink">
          {reason.requiredMonths} months with payouts are required. This address reaches the
          threshold in {reason.thresholdReachedIn}.
        </p>
        <p className="mt-6 max-w-[60ch] text-[11px] sm:text-[12px] leading-relaxed text-dim">
          This is a refusal with a date. It is not an error and it is not a limit of zero — the
          history was read correctly, there is simply not enough of it yet.
        </p>
      </>
    )
  }

  if (reason.kind === 'withdrawal-history') {
    return (
      <>
        <p className="mt-6 max-w-[52ch] text-[15px] sm:text-[20px] leading-relaxed text-ink">
          This network pays {reason.cadence}, so the chain holds a record of withdrawals, not of
          earnings.
        </p>
        <p className="mt-6 max-w-[60ch] text-[11px] sm:text-[12px] leading-relaxed text-dim">
          A regular withdrawal habit would look exactly like a regular income and it is not one. We
          would rather refuse than lend against a number we cannot verify.
        </p>
      </>
    )
  }

  return (
    <>
      <p className="mt-6 max-w-[52ch] text-[15px] sm:text-[20px] leading-relaxed text-ink">
        No price for this token between {reason.window.from} and {reason.window.to}.
      </p>
      <p className="mt-6 max-w-[60ch] text-[11px] sm:text-[12px] leading-relaxed text-dim">
        The payouts are known in tokens. What they are worth today is not, and the last price we do
        have is too old to lend against.
      </p>
    </>
  )
}

const Network = ({ network }: { network: NetworkCreditLimit }) => (
  <section className="mt-14 first:mt-0">
    <h2 className="text-[13px] sm:text-[15px] tracking-[0.16em]">
      {network.displayName.toUpperCase()} · {network.token.symbol}
    </h2>

    {network.limitUsd === null ? (
      network.reason && <Refusal reason={network.reason} />
    ) : (
      <div className="mt-6 border-t border-rule">
        {network.factors.map((factor) => (
          <div
            key={factor.name}
            className="border-b border-rule py-5 sm:grid sm:grid-cols-[1fr_150px] sm:items-baseline sm:gap-x-6"
          >
            <div>
              <div className="text-[15px] sm:text-[18px] text-ink">
                {FACTOR_LABEL[factor.name].label}
              </div>
              <div className="mt-1.5 text-[11px] sm:text-[12px] leading-relaxed text-dim">
                {FACTOR_LABEL[factor.name].clause}
              </div>
            </div>
            <div className="mt-3 text-right text-[17px] sm:mt-0 sm:text-[18px] tnum">
              {signed(factor.deltaUsd)}
            </div>
          </div>
        ))}

        <div className="border-t-2 border-amber pt-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
            <span className="text-[12px] sm:text-[15px] tracking-[0.14em] text-amber">
              AVAILABLE TO BORROW
            </span>
            <span className="text-[56px] leading-none sm:text-[72px] text-amber tnum">
              {formatUsd(network.limitUsd)}
            </span>
          </div>
        </div>
      </div>
    )}

    <p className="mt-6 text-[11px] sm:text-[12px] text-dim">
      Computed {network.computedAt.slice(0, 16).replace('T', ' ')} UTC · valid until{' '}
      {network.expiresAt.slice(0, 16).replace('T', ' ')} UTC
    </p>
  </section>
)

const Limit = () => {
  const address = useAddressParam()
  const [recomputed, setRecomputed] = useState(0)

  const limit = useResource(
    useCallback(() => {
      if (address === null) {
        return Promise.resolve({
          ok: false as const,
          failure: { kind: 'invalid-address' as const },
        })
      }

      // Перший показ бере збережене, якщо воно ще свіже; кнопка перерахунку
      // питає наново — це два різні ендпоінти, а не один із прапорцем.
      return recomputed === 0 ? api.creditLimit(address) : api.refreshCreditLimit(address)
    }, [address, recomputed]),
  )

  const borrowable =
    limit.status === 'done' && limit.result.ok
      ? limit.result.value.networks.some((network) => network.limitUsd !== null)
      : false

  return (
    <div>
      <h1 className="text-[13px] sm:text-[15px] tracking-[0.18em] text-dim">CREDIT LIMIT</h1>
      <p className="mt-2 break-all text-[11px] sm:text-[12px] text-dim">{address ?? '—'}</p>

      {limit.status === 'loading' && <Loading what="the credit limit" />}

      {limit.status === 'done' && !limit.result.ok && (
        <Failed failure={limit.result.failure} onRetry={() => setRecomputed(recomputed + 1)} />
      )}

      {limit.status === 'done' && limit.result.ok && (
        <>
          {limit.result.value.networks.length === 0 ? (
            <Empty>
              No recognised reward payouts for this address, so there is no network to lend against.
            </Empty>
          ) : (
            <div className="mt-10">
              {limit.result.value.networks.map((network) => (
                <Network key={network.networkId} network={network} />
              ))}
            </div>
          )}

          <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
            {borrowable && (
              <Link
                to="/offer"
                className="inline-block border border-rule px-4 py-2 text-[12px] sm:text-[13px] text-ink hover:border-ink"
              >
                CONTINUE →
              </Link>
            )}
            <button
              type="button"
              onClick={() => setRecomputed(recomputed + 1)}
              className="text-[12px] text-dim underline underline-offset-4 hover:text-ink"
            >
              recalculate now
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default Limit
