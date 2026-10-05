import { utils } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { decodePool } from './accounts.ts'
import { depositInstruction } from './deposit.ts'
import { lenderShareAddress, poolAddress, rewardFloatProgramId } from './pda.ts'
import { coder, encodePool, key, offlineProgram } from './test-support.ts'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111')

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

describe('deposit instruction', () => {
  const program = offlineProgram()

  it('deposits from the lender’s own stablecoin account into the pool vault', async () => {
    const ix = await depositInstruction(program, {
      lender,
      pool: await onChainPool(),
      amount: 250_000_000n,
    })

    expect(ix.programId.equals(rewardFloatProgramId)).toBe(true)
    const decoded = coder.instruction.decode(ix.data)
    expect(decoded?.name).toBe('deposit')
    // The u64 argument after the 8-byte discriminator, little-endian.
    expect(ix.data.subarray(8).readBigUInt64LE()).toBe(250_000_000n)
    expect(ix.data.length).toBe(16)
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [lender.toBase58(), true, true],
      [pool.toBase58(), false, true],
      [lenderShareAddress(pool, lender).toBase58(), false, true],
      [vault.toBase58(), false, true],
      [utils.token.associatedAddress({ mint: stableMint, owner: lender }).toBase58(), false, true],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
      [SYSTEM_PROGRAM_ID.toBase58(), false, false],
    ])
  })

  it('credits the shares to the signing lender, not to anyone else', async () => {
    const ix = await depositInstruction(program, {
      lender,
      pool: await onChainPool(),
      amount: 1n,
    })

    expect(ix.keys[2]?.pubkey.equals(lenderShareAddress(pool, key(8)))).toBe(false)
  })

  it('refuses an amount outside u64', async () => {
    await expect(
      depositInstruction(program, { lender, pool: await onChainPool(), amount: 2n ** 64n }),
    ).rejects.toThrow(RangeError)
  })
})
