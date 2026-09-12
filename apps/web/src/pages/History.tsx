import { Link } from 'react-router-dom'
import { PAYOUT_SOURCE_ADDRESS, HIVEMAPPER_ADDRESS, MAX_VALUE, PAYOUTS } from '../lib/data'

const COLS = 'sm:grid sm:grid-cols-[72px_1fr_1fr_1fr_120px] sm:gap-x-4 sm:items-center'

const History = () => {
  return (
    <div>
      <h1 className="text-[13px] sm:text-[15px] tracking-[0.16em]">
        PAYOUT HISTORY · HIVEMAPPER · HONEY
      </h1>
      <p className="mt-2 break-all text-[11px] sm:text-[12px] text-dim">{HIVEMAPPER_ADDRESS}</p>

      {/* register */}
      <div className="mt-10 border-t border-rule">
        <div
          className={`hidden border-b border-rule py-2 text-[11px] tracking-[0.12em] text-dim ${COLS}`}
        >
          <span>MONTH</span>
          <span className="text-right">HONEY</span>
          <span className="text-right">PRICE AT PAYOUT</span>
          <span className="text-right">VALUE</span>
          <span />
        </div>

        {PAYOUTS.map((row) => {
          const value = row.valueNumber
          const gap = value === null
          const tone = gap ? 'text-dim' : 'text-ink'
          return (
            <div
              key={row.month}
              className={`border-b border-rule py-3 text-[12px] sm:text-[13px] ${tone} ${COLS}`}
            >
              <span className="block">{row.month}</span>

              {/* mobile stacked figures */}
              <span className="mt-2 flex justify-between sm:hidden">
                <span className="text-dim">HONEY</span>
                <span className="tnum">{row.honey ?? '—'}</span>
              </span>
              <span className="flex justify-between sm:hidden">
                <span className="text-dim">price at payout</span>
                <span className="tnum">{row.price ?? '—'}</span>
              </span>
              <span className="flex justify-between sm:hidden">
                <span className="text-dim">value</span>
                <span className="tnum">{row.value ?? 'no payout'}</span>
              </span>

              {/* desktop columns */}
              <span className="hidden text-right tnum sm:block">{row.honey ?? '—'}</span>
              <span className="hidden text-right tnum sm:block">{row.price ?? '—'}</span>
              <span className="hidden text-right tnum sm:block">{row.value ?? 'no payout'}</span>

              <span className="mt-3 block h-[6px] w-full sm:mt-0">
                {value !== null && (
                  <span
                    className="block h-[6px] bg-ink"
                    style={{
                      width: `${(value / MAX_VALUE) * 100}%`,
                    }}
                  />
                )}
              </span>
            </div>
          )
        })}
      </div>

      <p className="mt-4 text-[12px] sm:text-[13px]">
        12 months observed · 11 months with payouts · $1,965.49 total
      </p>

      <div className="mt-12 border-t border-rule pt-4">
        <h2 className="text-[11px] tracking-[0.14em] text-dim">SOURCE</h2>
        <div className="mt-3 space-y-1 text-[11px] sm:text-[12px] text-dim">
          <div className="flex flex-col gap-y-0.5 sm:flex-row sm:gap-x-4">
            <span className="w-[110px] shrink-0">payout source</span>
            <span className="break-all">{PAYOUT_SOURCE_ADDRESS}</span>
          </div>
          <div className="flex flex-col gap-y-0.5 sm:flex-row sm:gap-x-4">
            <span className="w-[110px] shrink-0">first payout</span>
            <span>2025-09-04</span>
          </div>
          <div className="flex flex-col gap-y-0.5 sm:flex-row sm:gap-x-4">
            <span className="w-[110px] shrink-0">last indexed</span>
            <span>2026-08-29 · slot 442,918,004</span>
          </div>
        </div>
      </div>

      <div className="mt-10">
        <Link
          to="/limit"
          className="inline-block border border-rule px-4 py-2 text-[12px] sm:text-[13px] text-ink hover:border-ink"
        >
          CONTINUE →
        </Link>
      </div>
    </div>
  )
}

export default History
