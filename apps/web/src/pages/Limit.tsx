import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { DERIVATION, type DerivationLine } from '../lib/data'

const Row = ({ line, visible }: { line: DerivationLine; visible: boolean }) => (
  <div
    style={{ visibility: visible ? 'visible' : 'hidden' }}
    className="border-b border-rule py-5 sm:grid sm:grid-cols-[1fr_130px_150px] sm:items-baseline sm:gap-x-6"
  >
    <div>
      <div className="text-[15px] sm:text-[18px] text-ink">{line.label}</div>
      {line.clause.length > 0 && (
        <div className="mt-1.5 text-[11px] sm:text-[12px] leading-relaxed text-dim">
          {line.clause.map((c) => (
            <div key={c}>{c}</div>
          ))}
        </div>
      )}
    </div>
    <div className="mt-3 flex items-baseline justify-between sm:mt-0 sm:block sm:text-right">
      <span className="text-[13px] sm:text-[15px] text-dim sm:text-ink tnum">
        {line.operand ?? ''}
      </span>
      <span className="text-[17px] sm:hidden tnum">{line.result}</span>
    </div>
    <div className="hidden text-right text-[18px] sm:block tnum">{line.result}</div>
  </div>
)

const Limit = () => {
  const [params, setParams] = useSearchParams()
  const state = params.get('state')
  const isUnavailable = state === 'unavailable'
  const isIncomplete = state === 'incomplete'

  const shown = isIncomplete ? DERIVATION.slice(0, 3) : DERIVATION
  const steps = shown.length + 1 // + final block
  const [revealed, setRevealed] = useState(0)

  useEffect(() => {
    setRevealed(0)
    if (isUnavailable) return
    let i = 0
    const id = window.setInterval(() => {
      i += 1
      setRevealed(i)
      if (i >= steps) window.clearInterval(id)
    }, 90)
    return () => window.clearInterval(id)
  }, [steps, isUnavailable])

  return (
    <div>
      <h1 className="text-[13px] sm:text-[15px] tracking-[0.18em] text-dim">CREDIT LIMIT</h1>

      {isUnavailable ? (
        <div className="mt-10 border-t border-rule pt-10">
          <div className="text-[20px] sm:text-[26px] tracking-[0.06em]">
            PAYOUT DATA UNAVAILABLE
          </div>
          <p className="mt-4 max-w-[46ch] text-[13px] sm:text-[15px] leading-relaxed text-dim">
            Could not read the chain. This is not a statement about this operator — the limit is
            unknown, not zero.
          </p>
          <button
            type="button"
            onClick={() => setParams({})}
            className="mt-6 text-[13px] text-ink underline underline-offset-4"
          >
            retry
          </button>
        </div>
      ) : (
        <div className="mt-8 border-t border-rule">
          {shown.map((line, i) => (
            <Row key={line.label} line={line} visible={revealed > i} />
          ))}

          {isIncomplete ? (
            <div
              style={{ visibility: revealed > shown.length - 1 ? 'visible' : 'hidden' }}
              className="py-5"
            >
              <div className="text-[15px] sm:text-[18px] text-ink">
                HONEY volatility haircut — cannot compute
              </div>
              <div className="mt-1.5 text-[11px] sm:text-[12px] text-dim">
                missing daily prices for 2026-03-01 … 2026-03-31
              </div>
            </div>
          ) : (
            <div
              style={{ visibility: revealed >= steps ? 'visible' : 'hidden' }}
              className="border-t-2 border-amber pt-6"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                <span className="text-[12px] sm:text-[15px] tracking-[0.14em] text-amber">
                  AVAILABLE TO BORROW
                </span>
                <span className="text-[56px] leading-none sm:text-[72px] text-amber tnum">
                  $555
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {!isUnavailable && !isIncomplete && (
        <>
          <p className="mt-6 text-[11px] sm:text-[12px] text-dim">
            Recalculated 2026-08-30 14:02 UTC · valid for 24 hours
          </p>
          <div className="mt-8">
            <Link
              to="/offer"
              className="inline-block border border-rule px-4 py-2 text-[12px] sm:text-[13px] text-ink hover:border-ink"
            >
              CONTINUE →
            </Link>
          </div>
        </>
      )}

      <div className="mt-16 flex flex-wrap gap-x-6 gap-y-2 border-t border-rule pt-4 text-[11px] text-dim">
        <button type="button" onClick={() => setParams({ state: 'unavailable' })}>
          demo: unavailable
        </button>
        <button type="button" onClick={() => setParams({ state: 'incomplete' })}>
          demo: incomplete prices
        </button>
        {state && (
          <button type="button" onClick={() => setParams({})}>
            demo: normal
          </button>
        )}
      </div>
    </div>
  )
}

export default Limit
