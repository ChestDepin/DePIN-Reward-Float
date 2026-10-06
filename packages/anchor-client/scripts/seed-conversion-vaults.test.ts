import { Keypair, type PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { ConversionVaultAccount } from '../src/accounts.ts'
import {
  type ConversionVaultState,
  conversionVaultPlan,
  parseConversionVaultConfig,
} from './seed-conversion-vaults.ts'

function key(seed: number): PublicKey {
  return Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey
}

const wallet = key(1)
const stable = key(2)
const honey = key(3)
const hnt = key(4)
const pool = key(5)

const env = {
  SEED_KEYPAIR: '/home/me/devnet.json',
  SEED_AMOUNT: '1000',
  STABLE_MINT: stable.toBase58(),
  VITE_REWARD_MINTS: `hivemapper:${honey.toBase58()},helium:${hnt.toBase58()}`,
}

function vault(spreadBps = 30, maxSlippageBps = 100): ConversionVaultAccount {
  return {
    pool,
    rewardMint: honey,
    stableVault: key(6),
    rewardVault: key(7),
    spreadBps,
    maxSlippageBps,
    bump: 255,
  }
}

function plan(
  vaults: [string, ConversionVaultState][],
  overrides: { poolAuthority?: PublicKey | null; mintAuthority?: PublicKey | null } = {},
) {
  return conversionVaultPlan({
    wallet,
    poolAuthority: overrides.poolAuthority === undefined ? wallet : overrides.poolAuthority,
    stableMint: {
      address: stable,
      decimals: 6,
      mintAuthority: overrides.mintAuthority === undefined ? wallet : overrides.mintAuthority,
    },
    target: 1_000_000_000n,
    spreadBps: 30,
    maxSlippageBps: 100,
    vaults: new Map(vaults),
  })
}

describe('conversion vault config', () => {
  it('takes the public devnet endpoint, a 30 bps spread and a 1 % tolerance by default', () => {
    const config = parseConversionVaultConfig({ ...env, DEVNET_RPC_URL: '' })

    expect(config.rpcUrl).toBe('https://api.devnet.solana.com')
    expect(config.stableMint.equals(stable)).toBe(true)
    expect(config.rewardMints.get('helium')?.equals(hnt)).toBe(true)
    expect(config.amount).toBe('1000')
    expect(config.spreadBps).toBe(30)
    expect(config.maxSlippageBps).toBe(100)
  })

  it('reads a spread and a tolerance of its own', () => {
    const config = parseConversionVaultConfig({
      ...env,
      CONVERSION_SPREAD_BPS: '250',
      CONVERSION_MAX_SLIPPAGE_BPS: '0',
    })

    expect(config.spreadBps).toBe(250)
    expect(config.maxSlippageBps).toBe(0)
  })

  it('refuses a spread or tolerance the program would refuse', () => {
    expect(() => parseConversionVaultConfig({ ...env, CONVERSION_SPREAD_BPS: '10000' })).toThrow(
      /CONVERSION_SPREAD_BPS/,
    )
    expect(() =>
      parseConversionVaultConfig({ ...env, CONVERSION_MAX_SLIPPAGE_BPS: '10000' }),
    ).toThrow(/CONVERSION_MAX_SLIPPAGE_BPS/)
  })

  it('names every variable that is missing or wrong', () => {
    expect(() =>
      parseConversionVaultConfig({ STABLE_MINT: 'nope', VITE_REWARD_MINTS: '' }),
    ).toThrow(/SEED_KEYPAIR.*SEED_AMOUNT.*STABLE_MINT.*VITE_REWARD_MINTS/)
  })
})

describe('conversion vault plan', () => {
  it('opens and fills a vault for every reward token that has none', () => {
    const steps = plan([
      ['hivemapper', { rewardMint: honey, vault: null, balance: 0n }],
      ['helium', { rewardMint: hnt, vault: null, balance: 0n }],
    ])

    expect(steps).toEqual([
      { kind: 'create', networkId: 'hivemapper', rewardMint: honey },
      { kind: 'top-up', networkId: 'hivemapper', rewardMint: honey, amount: 1_000_000_000n },
      { kind: 'create', networkId: 'helium', rewardMint: hnt },
      { kind: 'top-up', networkId: 'helium', rewardMint: hnt, amount: 1_000_000_000n },
    ])
  })

  it('keeps a vault that is right and full, and tops up only the shortfall of one that ran low', () => {
    const steps = plan([
      ['hivemapper', { rewardMint: honey, vault: vault(), balance: 1_200_000_000n }],
      ['helium', { rewardMint: hnt, vault: vault(), balance: 400_000_000n }],
    ])

    expect(steps).toEqual([
      { kind: 'keep', networkId: 'hivemapper', rewardMint: honey },
      { kind: 'top-up', networkId: 'helium', rewardMint: hnt, amount: 600_000_000n },
    ])
  })

  it('refuses a vault opened with other terms, since they cannot be changed', () => {
    expect(() =>
      plan([['hivemapper', { rewardMint: honey, vault: vault(50, 100), balance: 0n }]]),
    ).toThrow(/hivemapper.*spread 50.*30/)
    expect(() =>
      plan([['hivemapper', { rewardMint: honey, vault: vault(30, 200), balance: 0n }]]),
    ).toThrow(/hivemapper.*tolerance 200.*100/)
  })

  it('needs the pool to exist, and its authority to open a vault', () => {
    const missing: [string, ConversionVaultState][] = [
      ['hivemapper', { rewardMint: honey, vault: null, balance: 0n }],
    ]

    expect(() => plan(missing, { poolAuthority: null })).toThrow(/seed:pool/)
    expect(() => plan(missing, { poolAuthority: key(9) })).toThrow(/pool authority/)
    expect(
      plan([['hivemapper', { rewardMint: honey, vault: vault(), balance: 1_000_000_000n }]], {
        poolAuthority: key(9),
      }),
    ).toEqual([{ kind: 'keep', networkId: 'hivemapper', rewardMint: honey }])
  })

  it('cannot top up a vault with a stablecoin the wallet may not mint', () => {
    expect(() =>
      plan([['helium', { rewardMint: hnt, vault: vault(), balance: 0n }]], {
        mintAuthority: key(9),
      }),
    ).toThrow(/helium.*may not mint/)
  })

  it('has nothing to do without a reward token', () => {
    expect(() => plan([])).toThrow(/VITE_REWARD_MINTS/)
  })
})
