import { Keypair, type PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { MintState } from './seed-pool.ts'
import { parseRewardMintConfig, rewardMintPlan } from './seed-reward-mints.ts'

function key(seed: number): PublicKey {
  return Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey
}

const authority = key(1)
const honey = key(2)
const hnt = key(3)
const networks = [
  { id: 'hivemapper', decimals: 9 },
  { id: 'helium', decimals: 8 },
]

function mint(address: PublicKey, decimals: number, mintAuthority: PublicKey | null): MintState {
  return { address, decimals, mintAuthority }
}

describe('reward mint config', () => {
  it('takes the public devnet endpoint and no mints when they are not set', () => {
    const config = parseRewardMintConfig({
      SEED_KEYPAIR: '/home/me/devnet.json',
      REWARD_MINT_AUTHORITY: authority.toBase58(),
      DEVNET_RPC_URL: '',
      VITE_REWARD_MINTS: '',
    })

    expect(config.rpcUrl).toBe('https://api.devnet.solana.com')
    expect(config.authority.equals(authority)).toBe(true)
    expect(config.existing.size).toBe(0)
  })

  it('reads the mints already handed to the web build', () => {
    const config = parseRewardMintConfig({
      SEED_KEYPAIR: '/home/me/devnet.json',
      REWARD_MINT_AUTHORITY: authority.toBase58(),
      VITE_REWARD_MINTS: `hivemapper:${honey.toBase58()}`,
    })

    expect(config.existing.get('hivemapper')?.equals(honey)).toBe(true)
  })

  it('names every variable that is missing or wrong', () => {
    expect(() =>
      parseRewardMintConfig({ REWARD_MINT_AUTHORITY: 'nope', VITE_REWARD_MINTS: 'helium' }),
    ).toThrow(/SEED_KEYPAIR.*REWARD_MINT_AUTHORITY.*VITE_REWARD_MINTS/)
  })
})

describe('reward mint plan', () => {
  it('creates a mint with mainnet decimals for every network that has none', () => {
    const steps = rewardMintPlan({ networks, authority, existing: new Map() })

    expect(steps).toEqual([
      { kind: 'create', networkId: 'hivemapper', decimals: 9 },
      { kind: 'create', networkId: 'helium', decimals: 8 },
    ])
  })

  it('keeps a mint that is already right and creates only the missing one', () => {
    const steps = rewardMintPlan({
      networks,
      authority,
      existing: new Map([['hivemapper', mint(honey, 9, authority)]]),
    })

    expect(steps).toEqual([
      { kind: 'keep', networkId: 'hivemapper', mint: honey },
      { kind: 'create', networkId: 'helium', decimals: 8 },
    ])
  })

  it('refuses a listed mint that is not on chain instead of silently replacing it', () => {
    expect(() =>
      rewardMintPlan({ networks, authority, existing: new Map([['helium', null]]) }),
    ).toThrow(/helium.*not found/)
  })

  it('refuses a mint with the wrong decimals, since amounts would read differently than on mainnet', () => {
    expect(() =>
      rewardMintPlan({
        networks,
        authority,
        existing: new Map([['helium', mint(hnt, 9, authority)]]),
      }),
    ).toThrow(/helium.*8 decimals/)
  })

  it('refuses a mint the reward key cannot mint, since the demo could not pay rewards with it', () => {
    expect(() =>
      rewardMintPlan({
        networks,
        authority,
        existing: new Map([['hivemapper', mint(honey, 9, key(9))]]),
      }),
    ).toThrow(/hivemapper.*mint authority/)
    expect(() =>
      rewardMintPlan({
        networks,
        authority,
        existing: new Map([['hivemapper', mint(honey, 9, null)]]),
      }),
    ).toThrow(/hivemapper.*mint authority/)
  })

  it('refuses a mint listed for a network the product does not support', () => {
    expect(() =>
      rewardMintPlan({
        networks,
        authority,
        existing: new Map([['render', mint(honey, 9, authority)]]),
      }),
    ).toThrow(/render/)
  })
})
