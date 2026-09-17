import { solanaAddressSchema } from '@drf/shared/schemas'
import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOperatorIdentity, useWalletConnection } from '../lib/wallet'

const Lookup = () => {
  const navigate = useNavigate()
  const identity = useOperatorIdentity()
  const { select, connect } = useWalletConnection()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    const parsed = solanaAddressSchema.safeParse(value.trim())

    if (!parsed.success) {
      setError('not a Solana wallet address')
      return
    }

    navigate(`/history/${parsed.data}`)
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
        Reads public payout history. Nothing is signed.
      </p>

      <div className="mt-12 border-t border-rule pt-6">
        <h2 className="text-[11px] tracking-[0.14em] text-dim">YOUR OWN WALLET</h2>

        {identity.status === 'connected' && (
          <button
            type="button"
            onClick={() => navigate(`/history/${identity.address}`)}
            className="mt-3 block break-all text-left text-[12px] sm:text-[13px] text-ink underline underline-offset-4"
          >
            {identity.address}
          </button>
        )}

        {identity.status === 'disconnected' && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            {identity.wallets.map((wallet) => (
              <button
                key={wallet}
                type="button"
                onClick={() => {
                  select(wallet as Parameters<typeof select>[0])
                  connect().catch(() => setError('the wallet refused to connect'))
                }}
                className="border border-rule px-3 py-2 text-[12px] text-ink hover:border-ink"
              >
                {wallet}
              </button>
            ))}
          </div>
        )}

        {identity.status === 'connecting' && (
          <p className="mt-3 text-[12px] text-dim">connecting…</p>
        )}

        {identity.status === 'no-wallet' && (
          <p className="mt-3 text-[12px] text-dim">
            No Solana wallet is installed in this browser. The address field above works without
            one — the payout history is public.
          </p>
        )}

        {identity.status === 'unusable-address' && (
          <p className="mt-3 text-[12px] text-dim">
            The connected wallet reported an address we cannot read.
          </p>
        )}
      </div>
    </div>
  )
}

export default Lookup
