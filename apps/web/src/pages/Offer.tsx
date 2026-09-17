import { OFFER_TERMS, REPAYMENT_ROWS } from '../lib/data'

const DefRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-col gap-y-1 border-b border-rule py-3 text-[12px] sm:flex-row sm:items-baseline sm:justify-between sm:gap-x-6 sm:text-[14px]">
    <span className="text-dim sm:text-ink">{label}</span>
    <span className="text-right tnum">{value}</span>
  </div>
)

const Offer = () => {
  return (
    <div>
      <h1 className="text-[13px] sm:text-[15px] tracking-[0.18em] text-dim">LOAN TERMS</h1>

      <p className="mt-4 border border-amber px-3 py-2 text-[11px] sm:text-[12px] leading-relaxed text-amber">
        MOCK. Every figure on this screen is invented. Lending is not built yet — there is no
        endpoint behind this page and no money moves. The payout history and the credit limit are
        real; this is not.
      </p>

      <div className="mt-8 border-t border-rule">
        {OFFER_TERMS.map(([label, value]) => (
          <DefRow key={label} label={label} value={value} />
        ))}
      </div>

      <h2 className="mt-12 text-[11px] sm:text-[12px] tracking-[0.14em] text-dim">
        PROJECTED REPAYMENT
      </h2>
      <div className="mt-3 border-t border-rule">
        {REPAYMENT_ROWS.map(([label, value]) => (
          <DefRow key={label} label={label} value={value} />
        ))}
      </div>

      {/* projected vs term */}
      <div className="mt-10">
        <div className="relative h-[6px] w-full bg-ink">
          <span
            className="absolute top-[-7px] block w-px bg-ink"
            style={{ left: '85%', height: '20px' }}
          />
        </div>
        <div className="mt-3 flex items-baseline justify-between text-[11px] text-dim">
          <span>projected</span>
          <span>term</span>
        </div>
      </div>

      <p className="mt-12 max-w-[60ch] text-[11px] sm:text-[12px] leading-relaxed text-dim">
        Repayment is withheld from rewards as they arrive. If rewards stop, the loan does not repay
        itself.
      </p>
    </div>
  )
}

export default Offer
