import { utils } from '@coral-xyz/anchor'
import type { AccountInfo, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { ChainReader } from './accounts.ts'
import {
  approveInstruction,
  delegationInstructions,
  fetchRewardAccount,
  revokeInstruction,
} from './delegate.ts'
import { operatorAccountAddress } from './pda.ts'
import { key } from './test-support.ts'

const operator = key(3)
const rewardMint = key(2)
const stranger = key(9)
const ata = utils.token.associatedAddress({ mint: rewardMint, owner: operator })
const TOKEN_PROGRAM = utils.token.TOKEN_PROGRAM_ID

// SPL token account, 165 bytes: mint (0), owner (32), amount (64), delegate as a
// COption: u32 tag (72) and key (76), state (108), is_native (109), delegated_amount (121).
function tokenAccount(input: { amount: bigint; delegate?: PublicKey; delegated?: bigint }): Buffer {
  const data = Buffer.alloc(165)
  rewardMint.toBuffer().copy(data, 0)
  operator.toBuffer().copy(data, 32)
  data.writeBigUInt64LE(input.amount, 64)
  if (input.delegate !== undefined) {
    data.writeUInt32LE(1, 72)
    input.delegate.toBuffer().copy(data, 76)
    data.writeBigUInt64LE(input.delegated ?? 0n, 121)
  }
  data.writeUInt8(1, 108)
  return data
}

function reader(data: Buffer | null, programOwner = TOKEN_PROGRAM): ChainReader {
  const info: AccountInfo<Buffer> | null =
    data === null
      ? null
      : { data, owner: programOwner, lamports: 1, executable: false, rentEpoch: 0 }
  return {
    getAccountInfo: async (address: PublicKey) => (address.equals(ata) ? info : null),
    getProgramAccounts: async () => [],
  }
}

describe('approveInstruction', () => {
  it('is the token program’s Approve: tag 4 and the amount as a little-endian u64', () => {
    const ix = approveInstruction({
      account: ata,
      delegate: stranger,
      owner: operator,
      amount: 43_600_433_297_239n,
    })

    expect(ix.programId.equals(TOKEN_PROGRAM)).toBe(true)
    expect(ix.data.toString('hex')).toBe('0457b75684a7270000')
    expect(ix.keys).toEqual([
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: stranger, isSigner: false, isWritable: false },
      { pubkey: operator, isSigner: true, isWritable: false },
    ])
  })
})

describe('revokeInstruction', () => {
  it('is the token program’s Revoke, signed by the owner alone (FR-014)', () => {
    const ix = revokeInstruction({ account: ata, owner: operator })

    expect(ix.programId.equals(TOKEN_PROGRAM)).toBe(true)
    expect(ix.data.toString('hex')).toBe('05')
    expect(ix.keys).toEqual([
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: operator, isSigner: true, isWritable: false },
    ])
  })
})

describe('delegationInstructions', () => {
  it('creates the reward account if missing and lets the operator account withhold from it', () => {
    const [create, approve] = delegationInstructions({ operator, rewardMint, allowance: 7n })

    expect(create?.programId.equals(utils.token.ASSOCIATED_PROGRAM_ID)).toBe(true)
    expect(create?.keys[1]?.pubkey.equals(ata)).toBe(true)
    expect(approve?.keys[0]?.pubkey.equals(ata)).toBe(true)
    expect(approve?.keys[1]?.pubkey.equals(operatorAccountAddress(operator))).toBe(true)
    expect(approve?.data.toString('hex')).toBe('040700000000000000')
  })
})

describe('fetchRewardAccount', () => {
  it('reads the balance, the delegate and what it may still take', async () => {
    const chain = reader(tokenAccount({ amount: 5n, delegate: stranger, delegated: 3n }))

    await expect(fetchRewardAccount(chain, operator, rewardMint)).resolves.toEqual({
      address: ata,
      exists: true,
      amount: 5n,
      delegate: stranger,
      delegatedAmount: 3n,
    })
  })

  it('reads an account with no delegate', async () => {
    const chain = reader(tokenAccount({ amount: 5n }))

    await expect(fetchRewardAccount(chain, operator, rewardMint)).resolves.toEqual({
      address: ata,
      exists: true,
      amount: 5n,
      delegate: null,
      delegatedAmount: 0n,
    })
  })

  it('says so when the operator has never held the token', async () => {
    await expect(fetchRewardAccount(reader(null), operator, rewardMint)).resolves.toEqual({
      address: ata,
      exists: false,
    })
  })

  it('refuses an account the token program does not own', async () => {
    await expect(
      fetchRewardAccount(reader(tokenAccount({ amount: 5n }), stranger), operator, rewardMint),
    ).rejects.toThrow(/token program/)
  })
})
