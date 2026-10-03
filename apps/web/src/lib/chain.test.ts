import { describe, expect, it } from 'vitest'
import { parseChainConfig } from './chain'

const MINT_A = 'So11111111111111111111111111111111111111112'
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

describe('parseChainConfig', () => {
  it('reads devnet by default and leaves lending off until a stablecoin is set', () => {
    const config = parseChainConfig({})

    expect(config.rpcUrl).toBe('https://api.devnet.solana.com')
    expect(config.stableMint).toBeNull()
    expect(config.rewardMints.size).toBe(0)
  })

  // A repository variable that was never set reaches the Pages build as "".
  it('reads an empty variable as an unset one', () => {
    const config = parseChainConfig({
      VITE_DEVNET_RPC_URL: '',
      VITE_STABLE_MINT: '',
      VITE_REWARD_MINTS: '',
    })

    expect(config.rpcUrl).toBe('https://api.devnet.solana.com')
    expect(config.stableMint).toBeNull()
    expect(config.rewardMints.size).toBe(0)
  })

  it('reads the stablecoin and one reward mint per network', () => {
    const config = parseChainConfig({
      VITE_DEVNET_RPC_URL: 'http://127.0.0.1:8899',
      VITE_STABLE_MINT: MINT_A,
      VITE_REWARD_MINTS: `hivemapper:${MINT_B}, helium:${MINT_A}`,
    })

    expect(config.rpcUrl).toBe('http://127.0.0.1:8899')
    expect(config.stableMint?.toBase58()).toBe(MINT_A)
    expect(config.rewardMints.get('hivemapper')?.toBase58()).toBe(MINT_B)
    expect(config.rewardMints.get('helium')?.toBase58()).toBe(MINT_A)
  })

  it('refuses a malformed reward mint list rather than lending against the wrong token', () => {
    expect(() => parseChainConfig({ VITE_REWARD_MINTS: `hivemapper=${MINT_B}` })).toThrow()
    expect(() => parseChainConfig({ VITE_REWARD_MINTS: 'hivemapper:not-a-key' })).toThrow()
    expect(() =>
      parseChainConfig({ VITE_REWARD_MINTS: `helium:${MINT_A},helium:${MINT_B}` }),
    ).toThrow()
  })
})
