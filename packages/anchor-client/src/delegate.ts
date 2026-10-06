import { utils } from '@coral-xyz/anchor'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { ChainReader } from './accounts.ts'
import { operatorAccountAddress, u64Bytes } from './pda.ts'
import { createAssociatedTokenAccountIdempotent } from './token.ts'

// Delegation has no account of its own (FR-014): it is the token program's own Approve
// on the operator's reward account, so the operator revokes it with one Revoke and
// without the protocol. Written out like the rest of src/token.ts.
const APPROVE = 4
const REVOKE = 5

const TOKEN_ACCOUNT_SIZE = 165
const AMOUNT_OFFSET = 64
const DELEGATE_TAG_OFFSET = 72
const DELEGATE_OFFSET = 76
const DELEGATED_AMOUNT_OFFSET = 121

export type RewardAccount =
  | { address: PublicKey; exists: false }
  | {
      address: PublicKey
      exists: true
      amount: bigint
      delegate: PublicKey | null
      delegatedAmount: bigint
    }

export function approveInstruction(input: {
  account: PublicKey
  delegate: PublicKey
  owner: PublicKey
  amount: bigint
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: utils.token.TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: input.account, isSigner: false, isWritable: true },
      { pubkey: input.delegate, isSigner: false, isWritable: false },
      { pubkey: input.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([APPROVE]), u64Bytes(input.amount)]),
  })
}

export function revokeInstruction(input: {
  account: PublicKey
  owner: PublicKey
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: utils.token.TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: input.account, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([REVOKE]),
  })
}

// The delegate is the operator account, not a loan: a token account has one delegate,
// and an operator may hold several loans repaid from the same token.
export function delegationInstructions(input: {
  operator: PublicKey
  rewardMint: PublicKey
  allowance: bigint
}): TransactionInstruction[] {
  const { operator, rewardMint, allowance } = input
  return [
    // Approve needs the account to exist, and on devnet the stand-in reaches an
    // operator's wallet only once rewards start arriving.
    createAssociatedTokenAccountIdempotent({ payer: operator, owner: operator, mint: rewardMint }),
    approveInstruction({
      account: utils.token.associatedAddress({ mint: rewardMint, owner: operator }),
      delegate: operatorAccountAddress(operator),
      owner: operator,
      amount: allowance,
    }),
  ]
}

export async function fetchRewardAccount(
  reader: ChainReader,
  owner: PublicKey,
  mint: PublicKey,
): Promise<RewardAccount> {
  const address = utils.token.associatedAddress({ mint, owner })
  const info = await reader.getAccountInfo(address)
  if (info === null) return { address, exists: false }
  if (!info.owner.equals(utils.token.TOKEN_PROGRAM_ID)) {
    throw new Error(`${address.toBase58()} is not owned by the token program`)
  }
  if (info.data.length < TOKEN_ACCOUNT_SIZE) {
    throw new Error(`${address.toBase58()} is too short to be a token account`)
  }
  const hasDelegate = info.data.readUInt32LE(DELEGATE_TAG_OFFSET) === 1
  return {
    address,
    exists: true,
    amount: info.data.readBigUInt64LE(AMOUNT_OFFSET),
    delegate: hasDelegate
      ? new PublicKey(info.data.subarray(DELEGATE_OFFSET, DELEGATE_OFFSET + 32))
      : null,
    delegatedAmount: hasDelegate ? info.data.readBigUInt64LE(DELEGATED_AMOUNT_OFFSET) : 0n,
  }
}
