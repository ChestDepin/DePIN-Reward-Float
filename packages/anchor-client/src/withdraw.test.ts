import { utils } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { decodePool } from './accounts.ts'
import { lenderShareAddress, poolAddress, rewardFloatProgramId } from './pda.ts'
import { coder, encodePool, key, offlineProgram } from './test-support.ts'
import { withdrawInstruction } from './withdraw.ts'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

const stableMint = key(2)
const vault = key(3)
const pool = poolAddress(stableMint)
const lender = key(7)

async function onChainPool() {
  return {
    address: pool,
    account: decodePool(await encodePool({ attestor: key(6), stableMint, vault })),
  }
}

describe('withdraw instruction', () => {
  const program = offlineProgram()

  it('pays from the pool vault into the lender’s own stablecoin account', async () => {
    const ix = await withdrawInstruction(program, {
      lender,
      pool: await onChainPool(),
      maxAmount: 126_500_000n,
    })

    expect(ix.programId.equals(rewardFloatProgramId)).toBe(true)
    expect(coder.instruction.decode(ix.data)?.name).toBe('withdraw')
    expect(ix.data.subarray(8).readBigUInt64LE()).toBe(126_500_000n)
    expect(ix.data.length).toBe(16)
    // The lender only signs: nothing is opened, so nothing is paid for.
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [lender.toBase58(), true, false],
      [pool.toBase58(), false, true],
      [lenderShareAddress(pool, lender).toBase58(), false, true],
      [vault.toBase58(), false, true],
      [utils.token.associatedAddress({ mint: stableMint, owner: lender }).toBase58(), false, true],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
    ])
  })

  it('asks for everything with the largest u64, which the program caps at the position', async () => {
    const ix = await withdrawInstruction(program, {
      lender,
      pool: await onChainPool(),
      maxAmount: 2n ** 64n - 1n,
    })

    expect(ix.data.subarray(8).readBigUInt64LE()).toBe(2n ** 64n - 1n)
  })

  it('refuses an amount outside u64', async () => {
    await expect(
      withdrawInstruction(program, { lender, pool: await onChainPool(), maxAmount: 2n ** 64n }),
    ).rejects.toThrow(RangeError)
  })
})
