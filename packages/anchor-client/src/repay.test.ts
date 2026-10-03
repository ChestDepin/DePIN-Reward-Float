import { utils } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { decodeLoan, decodePool } from './accounts.ts'
import { operatorAccountAddress, poolAddress, rewardFloatProgramId } from './pda.ts'
import { repayInstruction } from './repay.ts'
import { coder, encodeLoan, encodePool, key, offlineProgram } from './test-support.ts'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

const stableMint = key(2)
const vault = key(3)
const pool = poolAddress(stableMint)
const operator = key(1)
const payer = key(5)
const loan = key(11)

async function onChain() {
  return {
    pool: {
      address: pool,
      account: decodePool(await encodePool({ attestor: key(6), stableMint, vault })),
    },
    loan: {
      address: loan,
      account: decodeLoan(await encodeLoan({ operator, pool, nonce: 7n })),
    },
  }
}

describe('repay instruction', () => {
  const program = offlineProgram()

  it('repays from the payer’s own stablecoin account, up to a ceiling', async () => {
    const ix = await repayInstruction(program, { payer, ...(await onChain()), maxAmount: 5_000n })

    expect(ix.programId.equals(rewardFloatProgramId)).toBe(true)
    const decoded = coder.instruction.decode(ix.data)
    expect(decoded?.name).toBe('repay')
    expect(JSON.stringify(decoded?.data)).toBe(JSON.stringify({ maxAmount: (5_000).toString(16) }))
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [payer.toBase58(), true, false],
      [pool.toBase58(), false, true],
      [loan.toBase58(), false, true],
      [operatorAccountAddress(operator).toBase58(), false, true],
      [vault.toBase58(), false, true],
      [utils.token.associatedAddress({ mint: stableMint, owner: payer }).toBase58(), false, true],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
    ])
  })

  it('debits the operator account of the loan, not of the payer', async () => {
    const ix = await repayInstruction(program, { payer, ...(await onChain()), maxAmount: 1n })

    expect(ix.keys[3]?.pubkey.equals(operatorAccountAddress(payer))).toBe(false)
  })

  it('refuses a ceiling outside u64', async () => {
    await expect(
      repayInstruction(program, { payer, ...(await onChain()), maxAmount: 2n ** 64n }),
    ).rejects.toThrow(RangeError)
  })
})
