import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  decodeMint,
  initializeMintInstruction,
  mintToInstruction,
  parseAmount,
  parseSeedConfig,
  type SeedState,
  seedPlan,
} from './seed-pool.ts'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

function key(seed: number): PublicKey {
  return Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey
}

const wallet = key(1)
const attestor = key(2)
const mint = key(3)

describe('seed config', () => {
  const env = {
    SEED_KEYPAIR: '/home/me/devnet.json',
    SEED_AMOUNT: '1000',
    ATTESTOR_PUBLIC_KEY: attestor.toBase58(),
  }

  it('takes the public devnet endpoint and a new mint when they are not set', () => {
    const config = parseSeedConfig({ ...env, DEVNET_RPC_URL: '', STABLE_MINT: '' })

    expect(config.rpcUrl).toBe('https://api.devnet.solana.com')
    expect(config.stableMint).toBeNull()
    expect(config.attestor?.equals(attestor)).toBe(true)
    expect(config.amount).toBe('1000')
    expect([config.baseAprBps, config.slopeAprBps]).toEqual([800, 2000])
  })

  it('reads an existing mint and a rate curve', () => {
    const config = parseSeedConfig({
      ...env,
      STABLE_MINT: mint.toBase58(),
      SEED_BASE_APR_BPS: '500',
      SEED_SLOPE_APR_BPS: '1500',
    })

    expect(config.stableMint?.equals(mint)).toBe(true)
    expect([config.baseAprBps, config.slopeAprBps]).toEqual([500, 1500])
  })

  it('names every variable that is missing or wrong', () => {
    expect(() =>
      parseSeedConfig({ SEED_AMOUNT: 'lots', STABLE_MINT: 'nope', SEED_BASE_APR_BPS: '70000' }),
    ).toThrow(/SEED_KEYPAIR.*SEED_AMOUNT.*STABLE_MINT.*SEED_BASE_APR_BPS/)
  })
})

describe('amount', () => {
  it('turns whole tokens into base units', () => {
    expect(parseAmount('1000', 6)).toBe(1_000_000_000n)
    expect(parseAmount('0.000001', 6)).toBe(1n)
    expect(parseAmount('12.5', 6)).toBe(12_500_000n)
  })

  it('refuses nothing and more decimals than the mint has', () => {
    expect(() => parseAmount('0', 6)).toThrow(/greater than zero/)
    expect(() => parseAmount('0.0000001', 6)).toThrow(/6 decimals/)
  })
})

describe('mint account', () => {
  function mintData(authority: PublicKey | null, decimals: number): Buffer {
    const data = Buffer.alloc(82)
    if (authority !== null) {
      data.writeUInt32LE(1, 0)
      authority.toBuffer().copy(data, 4)
    }
    data.writeUInt8(decimals, 44)
    data.writeUInt8(1, 45)
    return data
  }

  it('reads the decimals and who may mint', () => {
    const decoded = decodeMint(mint, { owner: TOKEN_PROGRAM_ID, data: mintData(wallet, 6) })

    expect(decoded.decimals).toBe(6)
    expect(decoded.mintAuthority?.equals(wallet)).toBe(true)
  })

  it('reads a mint nobody can mint more of', () => {
    expect(
      decodeMint(mint, { owner: TOKEN_PROGRAM_ID, data: mintData(null, 6) }).mintAuthority,
    ).toBeNull()
  })

  it('refuses an account that is not a token mint', () => {
    expect(() => decodeMint(mint, { owner: key(9), data: mintData(wallet, 6) })).toThrow(
      /not a token mint/,
    )
    expect(() => decodeMint(mint, { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) })).toThrow(
      /not a token mint/,
    )
  })
})

describe('seed plan', () => {
  const amount = 1_000_000_000n
  const ready: SeedState = {
    mint: { address: mint, decimals: 6, mintAuthority: wallet },
    poolExists: true,
    balance: amount,
  }

  it('only deposits when the pool exists and the wallet holds enough', () => {
    expect(seedPlan({ wallet, attestor: null, amount, state: ready })).toEqual([
      { kind: 'deposit', amount },
    ])
  })

  it('mints only the shortfall when the wallet may mint', () => {
    const state = { ...ready, balance: 400_000_000n }

    expect(seedPlan({ wallet, attestor: null, amount, state })).toEqual([
      { kind: 'mint-to', amount: 600_000_000n },
      { kind: 'deposit', amount },
    ])
  })

  it('starts from nothing: a mint, the pool, the tokens, the deposit', () => {
    const state: SeedState = { mint: null, poolExists: false, balance: 0n }

    expect(seedPlan({ wallet, attestor, amount, state })).toEqual([
      { kind: 'create-mint' },
      { kind: 'initialize-pool', attestor },
      { kind: 'mint-to', amount },
      { kind: 'deposit', amount },
    ])
  })

  it('cannot create the pool without the attestor key the api signs with', () => {
    const state = { ...ready, poolExists: false }

    expect(() => seedPlan({ wallet, attestor: null, amount, state })).toThrow(/ATTESTOR_PUBLIC_KEY/)
  })

  it('cannot top up a wallet that may not mint the stablecoin', () => {
    const state: SeedState = {
      ...ready,
      mint: { address: mint, decimals: 6, mintAuthority: key(8) },
      balance: 1n,
    }

    expect(() => seedPlan({ wallet, attestor: null, amount, state })).toThrow(/holds 1/)
  })
})

describe('token instructions', () => {
  it('initialises a mint with the wallet as its only authority', () => {
    const ix = initializeMintInstruction({ mint, decimals: 6, authority: wallet })

    expect(ix.programId.equals(TOKEN_PROGRAM_ID)).toBe(true)
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [mint.toBase58(), false, true],
    ])
    // InitializeMint2: tag 20, decimals, mint authority, no freeze authority.
    expect([...ix.data]).toEqual([20, 6, ...wallet.toBytes(), 0])
  })

  it('mints to an account, amount little-endian', () => {
    const destination = key(5)
    const ix = mintToInstruction({ mint, destination, authority: wallet, amount: 258n })

    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [mint.toBase58(), false, true],
      [destination.toBase58(), false, true],
      [wallet.toBase58(), true, false],
    ])
    expect([...ix.data]).toEqual([7, 2, 1, 0, 0, 0, 0, 0, 0])
  })
})
