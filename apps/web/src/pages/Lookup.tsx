import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { HELIUM_ADDRESS, HIVEMAPPER_ADDRESS } from '../lib/data'

const EXAMPLES = [
  { address: HIVEMAPPER_ADDRESS, network: 'Hivemapper', to: '/history' },
  { address: HELIUM_ADDRESS, network: 'Helium', to: '/refused' },
]

const Lookup = () => {
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const resolve = (raw: string) => {
    const input = raw.trim()
    if (input === HIVEMAPPER_ADDRESS) {
      navigate('/history')
      return
    }
    if (input === HELIUM_ADDRESS) {
      navigate('/refused')
      return
    }
    setError('no reward payouts found for this address')
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    resolve(value)
  }

  return (
    <div>
      <h1 className="text-[13px] tracking-[0.18em] text-dim">OPERATOR LOOKUP</h1>

      <form onSubmit={onSubmit} className="mt-6">
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder="operator wallet address"
          aria-label="operator wallet address"
          className="w-full bg-transparent border border-rule px-3 py-3 text-[13px] sm:text-[15px] text-ink placeholder:text-dim outline-none focus:border-ink"
        />
        <button type="submit" className="sr-only">
          read payout history
        </button>
      </form>

      {error && <p className="mt-3 text-[12px] sm:text-[13px] text-ink">{error}</p>}

      <p className="mt-3 text-[11px] sm:text-[12px] text-dim">
        Reads public payout history. Nothing is signed. No wallet is connected.
      </p>

      <div className="mt-12 border-t border-rule">
        <div className="flex items-center justify-between border-b border-rule py-2 text-[11px] tracking-[0.14em] text-dim">
          <span>KNOWN ADDRESSES</span>
          <span>NETWORK</span>
        </div>
        {EXAMPLES.map((ex) => (
          <button
            key={ex.address}
            type="button"
            onClick={() => {
              setValue(ex.address)
              setError(null)
              navigate(ex.to)
            }}
            className="block w-full border-b border-rule py-4 text-left hover:bg-[#141519]"
          >
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
              <span className="break-all text-[12px] sm:text-[13px] text-ink">{ex.address}</span>
              <span className="shrink-0 text-[12px] text-dim">{ex.network}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export default Lookup
