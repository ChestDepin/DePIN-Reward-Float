import { PAYOUTS, REFUSED_FACTS } from '../lib/data'

const MINI = PAYOUTS.filter((p) => ['2026-05', '2026-06', '2026-07', '2026-08'].includes(p.month))

const PLACEHOLDERS = ['2026-09', '2026-10']

const Refused = () => {
  return (
    <div>
      <h1 className="text-[13px] sm:text-[15px] tracking-[0.18em] text-dim">NO LIMIT AVAILABLE</h1>

      <div className="mt-8 border-t border-rule">
        {REFUSED_FACTS.map(([label, value]) => (
          <div
            key={label}
            className="flex flex-col gap-y-1 border-b border-rule py-3 text-[12px] sm:flex-row sm:items-baseline sm:justify-between sm:gap-x-6 sm:text-[13px]"
          >
            <span className="text-dim sm:text-ink">{label}</span>
            <span className="break-all text-left tnum sm:text-right">{value}</span>
          </div>
        ))}
      </div>

      <p className="mt-10 max-w-[52ch] text-[15px] sm:text-[20px] leading-relaxed text-ink">
        Six complete months of payouts are required. This address will reach the threshold on
        2026-10-31.
      </p>

      <p className="mt-6 max-w-[60ch] text-[11px] sm:text-[12px] leading-relaxed text-dim">
        This is a refusal with a date. It is not an error, and it is not a limit of zero — the
        history below was read correctly, there is simply not enough of it yet.
      </p>

      <h2 className="mt-12 text-[11px] tracking-[0.14em] text-dim">HISTORY READ · 4 OF 6 MONTHS</h2>
      <div className="mt-3 border-t border-rule">
        {MINI.map((row) => (
          <div
            key={row.month}
            className="flex items-baseline justify-between border-b border-rule py-3 text-[12px] sm:text-[13px]"
          >
            <span>{row.month}</span>
            <span className="tnum">{row.value}</span>
          </div>
        ))}
        {PLACEHOLDERS.map((month) => (
          <div
            key={month}
            className="flex items-baseline justify-between border-b border-rule py-3 text-[12px] text-dim sm:text-[13px]"
          >
            <span>{month}</span>
            <span className="tnum">—</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default Refused
