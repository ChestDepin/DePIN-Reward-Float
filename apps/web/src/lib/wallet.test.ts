import { describe, expect, it } from 'vitest'
import { deriveIdentity } from './wallet'

const REAL_ADDRESS = '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy'

describe('deriveIdentity', () => {
  it('reports the connected address as the whole identity', () => {
    const identity = deriveIdentity({
      wallets: ['Phantom'],
      connecting: false,
      address: REAL_ADDRESS,
    })

    expect(identity).toEqual({ status: 'connected', address: REAL_ADDRESS })
  })

  it('offers the wallets the browser registered when nothing is connected', () => {
    const identity = deriveIdentity({
      wallets: ['Phantom', 'Solflare'],
      connecting: false,
      address: null,
    })

    expect(identity).toEqual({ status: 'disconnected', wallets: ['Phantom', 'Solflare'] })
  })

  it('separates "no wallet installed" from "not connected yet"', () => {
    expect(deriveIdentity({ wallets: [], connecting: false, address: null })).toEqual({
      status: 'no-wallet',
    })
  })

  it('reports connecting while the wallet is deciding', () => {
    expect(deriveIdentity({ wallets: ['Phantom'], connecting: true, address: null })).toEqual({
      status: 'connecting',
    })
  })

  it('refuses an address the wallet extension made up', () => {
    expect(
      deriveIdentity({ wallets: ['Phantom'], connecting: false, address: 'not-an-address' }),
    ).toEqual({ status: 'unusable-address' })
  })

  it('refuses the M0 demo address, which is not a real pubkey', () => {
    expect(
      deriveIdentity({
        wallets: ['Phantom'],
        connecting: false,
        address: 'HvmDemo7xK2qF4b9WgQn3sT8yLcRzA1eU6dJ5mNpVe',
      }),
    ).toEqual({ status: 'unusable-address' })
  })

  it('prefers a connected address over a still-pending connect', () => {
    expect(
      deriveIdentity({ wallets: ['Phantom'], connecting: true, address: REAL_ADDRESS }),
    ).toMatchObject({ status: 'connected' })
  })
})
