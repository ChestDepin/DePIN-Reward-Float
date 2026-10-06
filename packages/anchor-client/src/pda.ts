import { PublicKey } from '@solana/web3.js'
import { rewardFloatIdl } from './idl/reward-float.ts'

export const rewardFloatProgramId = new PublicKey(rewardFloatIdl.address)

const U64_MAX = 2n ** 64n - 1n

function seed(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

function derive(seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, rewardFloatProgramId)[0]
}

export function u64Bytes(value: bigint): Buffer {
  if (value < 0n || value > U64_MAX) throw new RangeError(`${value} is outside u64`)
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64LE(value)
  return bytes
}

export function poolAddress(stableMint: PublicKey): PublicKey {
  return derive([seed('pool'), stableMint.toBuffer()])
}

export function vaultAddress(pool: PublicKey): PublicKey {
  return derive([seed('vault'), pool.toBuffer()])
}

export function operatorAccountAddress(operator: PublicKey): PublicKey {
  return derive([seed('operator'), operator.toBuffer()])
}

export function lenderShareAddress(pool: PublicKey, owner: PublicKey): PublicKey {
  return derive([seed('share'), pool.toBuffer(), owner.toBuffer()])
}

export function loanAddress(operator: PublicKey, nonce: bigint): PublicKey {
  return derive([seed('loan'), operator.toBuffer(), u64Bytes(nonce)])
}

export function conversionVaultAddress(pool: PublicKey, rewardMint: PublicKey): PublicKey {
  return derive([seed('conv'), pool.toBuffer(), rewardMint.toBuffer()])
}

export function conversionStableVaultAddress(conversionVault: PublicKey): PublicKey {
  return derive([seed('conv_stable'), conversionVault.toBuffer()])
}

export function conversionRewardVaultAddress(conversionVault: PublicKey): PublicKey {
  return derive([seed('conv_reward'), conversionVault.toBuffer()])
}
