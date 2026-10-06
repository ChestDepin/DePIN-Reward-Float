import { BN } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  conversionRewardVaultAddress,
  conversionStableVaultAddress,
  conversionVaultAddress,
  lenderShareAddress,
  loanAddress,
  operatorAccountAddress,
  poolAddress,
  rewardFloatProgramId,
  rewardWatchAddress,
  vaultAddress,
} from './pda.ts'
import { key, offlineProgram } from './test-support.ts'

// The resolver derives these from the seeds written in the IDL, so agreeing with it
// means agreeing with the program rather than with a second copy of its seeds.
describe('program addresses', () => {
  const program = offlineProgram()

  it('takes the program id from the vendored IDL', () => {
    expect(rewardFloatProgramId.equals(program.programId)).toBe(true)
  })

  it('derives the pool and its vault as initialize_pool does', async () => {
    const stableMint = key(1)
    const resolved = await program.methods
      .initializePool(key(2), 800, 2000)
      .accountsPartial({ authority: key(3), stableMint, programData: key(4) })
      .pubkeys()

    expect(poolAddress(stableMint).equals(resolved.pool as PublicKey)).toBe(true)
    expect(vaultAddress(poolAddress(stableMint)).equals(resolved.vault as PublicKey)).toBe(true)
  })

  it('derives the operator account and a loan as borrow does, nonce little-endian', async () => {
    const operator = key(5)
    const nonce = 0x0102_0304_0506_0708n
    const resolved = await program.methods
      .borrow(new BN(nonce.toString()), new BN(1), 1, 5000, 3000)
      .accountsPartial({
        operator,
        pool: key(6),
        vault: key(7),
        destination: key(8),
        rewardMint: key(9),
      })
      .pubkeys()

    expect(operatorAccountAddress(operator).equals(resolved.operatorAccount as PublicKey)).toBe(
      true,
    )
    expect(loanAddress(operator, nonce).equals(resolved.loan as PublicKey)).toBe(true)
    expect(rewardWatchAddress(operator, key(9)).equals(resolved.rewardWatch as PublicKey)).toBe(
      true,
    )
  })

  it('gives each operator and reward token a watch of its own', () => {
    const watch = rewardWatchAddress(key(5), key(9))
    expect(watch.equals(rewardWatchAddress(key(5), key(10)))).toBe(false)
    expect(watch.equals(rewardWatchAddress(key(4), key(9)))).toBe(false)
  })

  it('derives a lender share as deposit does, one per pool and lender', async () => {
    const pool = key(6)
    const lender = key(7)
    const resolved = await program.methods
      .deposit(new BN(1))
      .accountsPartial({ lender, pool, vault: key(8), source: key(9) })
      .pubkeys()

    expect(lenderShareAddress(pool, lender).equals(resolved.lenderShare as PublicKey)).toBe(true)
    expect(lenderShareAddress(key(5), lender).equals(lenderShareAddress(pool, lender))).toBe(false)
  })

  it('derives a conversion vault and its two token accounts as init_conversion_vault does', async () => {
    const pool = key(6)
    const rewardMint = key(7)
    const resolved = await program.methods
      .initConversionVault(30, 100)
      .accountsPartial({ authority: key(3), pool, rewardMint, stableMint: key(8) })
      .pubkeys()

    const conversionVault = conversionVaultAddress(pool, rewardMint)
    expect(conversionVault.equals(resolved.conversionVault as PublicKey)).toBe(true)
    expect(
      conversionStableVaultAddress(conversionVault).equals(resolved.stableVault as PublicKey),
    ).toBe(true)
    expect(
      conversionRewardVaultAddress(conversionVault).equals(resolved.rewardVault as PublicKey),
    ).toBe(true)
  })

  it('gives each pool and reward token a vault of its own', () => {
    const honey = conversionVaultAddress(key(6), key(7))

    expect(honey.equals(conversionVaultAddress(key(6), key(8)))).toBe(false)
    expect(honey.equals(conversionVaultAddress(key(5), key(7)))).toBe(false)
    expect(conversionStableVaultAddress(honey).equals(conversionRewardVaultAddress(honey))).toBe(
      false,
    )
  })

  it('gives every nonce its own loan, including the largest u64', () => {
    const operator = key(5)
    const largest = 2n ** 64n - 1n

    expect(loanAddress(operator, 0n).equals(loanAddress(operator, 1n))).toBe(false)
    expect(loanAddress(operator, largest)).toBeInstanceOf(PublicKey)
  })

  it('refuses a nonce outside u64', () => {
    expect(() => loanAddress(key(5), 2n ** 64n)).toThrow(RangeError)
    expect(() => loanAddress(key(5), -1n)).toThrow(RangeError)
  })
})
