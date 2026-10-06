import { BN, type Program, utils } from '@coral-xyz/anchor'
import type { IssuedAttestation, IssuedRateAttestation } from '@drf/shared/api'
import {
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js'
import type { OnChain, PoolAccount } from './accounts.ts'
import type { RewardFloat } from './idl/reward-float.ts'
import { loanAddress, operatorAccountAddress, u64Bytes } from './pda.ts'
import { createAssociatedTokenAccountIdempotent } from './token.ts'

export type BorrowRequest = {
  operator: PublicKey
  pool: OnChain<PoolAccount>
  attestation: IssuedAttestation
  // The reward token's rate (FR-015b): borrow sizes the reward allowance by it.
  rate: IssuedRateAttestation
  // Every open loan of the operator, from openLoansForBorrow: borrow accrues them all
  // before it compares the debt with the limit.
  openLoans: readonly PublicKey[]
  rewardMint: PublicKey
  amount: bigint
  termPeriods: number
  sweepBps: number
  maxAprBps: number
}

export class AttestationMismatch extends Error {
  override name = 'AttestationMismatch'
}

function u64(value: bigint): BN {
  return new BN(u64Bytes(value), 'le')
}

// The program would refuse both, but only after the operator has signed and paid for
// the transaction; after an attestor rotation (FR-012c) the first is expected, not rare.
function checkAttestation(request: BorrowRequest): void {
  const { attestation, rate, pool, operator } = request
  if (!new PublicKey(attestation.attestor).equals(pool.account.attestor)) {
    throw new AttestationMismatch(
      `the attestation is signed by ${attestation.attestor}, the pool trusts ${pool.account.attestor.toBase58()}`,
    )
  }
  if (!new PublicKey(attestation.wallet).equals(operator)) {
    throw new AttestationMismatch(
      `the attestation is issued to ${attestation.wallet}, not to ${operator.toBase58()}`,
    )
  }
  if (!new PublicKey(rate.attestor).equals(pool.account.attestor)) {
    throw new AttestationMismatch(
      `the rate is signed by ${rate.attestor}, the pool trusts ${pool.account.attestor.toBase58()}`,
    )
  }
  if (!new PublicKey(rate.rewardMint).equals(request.rewardMint)) {
    throw new AttestationMismatch(
      `the rate is for ${rate.rewardMint}, the loan is repaid from ${request.rewardMint.toBase58()}`,
    )
  }
}

function signatureCheck(signed: { attestor: string; message: string; signature: string }) {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: new PublicKey(signed.attestor).toBytes(),
    message: utils.bytes.bs58.decode(signed.message),
    signature: utils.bytes.bs58.decode(signed.signature),
  })
}

// Five instructions, in this order: the destination and the reward account (FR-008
// promises one transaction even to an operator who never held either token), the
// attestor's signatures over the rate and over the limit, and borrow, which reads the
// limit from the instruction right before it and the rate from the one before that.
// borrow approves the reward account itself, at the rate the loan actually gets.
export async function borrowInstructions(
  program: Program<RewardFloat>,
  request: BorrowRequest,
): Promise<TransactionInstruction[]> {
  checkAttestation(request)
  const { operator, pool, attestation, rewardMint } = request
  const nonce = BigInt(attestation.nonce)
  const destination = utils.token.associatedAddress({
    mint: pool.account.stableMint,
    owner: operator,
  })

  const borrow = await program.methods
    .borrow(
      u64(nonce),
      u64(request.amount),
      request.termPeriods,
      request.sweepBps,
      request.maxAprBps,
    )
    .accountsStrict({
      operator,
      pool: pool.address,
      operatorAccount: operatorAccountAddress(operator),
      loan: loanAddress(operator, nonce),
      vault: pool.account.vault,
      destination,
      rewardMint,
      rewardAccount: utils.token.associatedAddress({ mint: rewardMint, owner: operator }),
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: utils.token.TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(
      request.openLoans.map((loan) => ({ pubkey: loan, isSigner: false, isWritable: true })),
    )
    .instruction()

  return [
    createAssociatedTokenAccountIdempotent({
      payer: operator,
      owner: operator,
      mint: pool.account.stableMint,
    }),
    createAssociatedTokenAccountIdempotent({ payer: operator, owner: operator, mint: rewardMint }),
    signatureCheck(request.rate),
    signatureCheck(attestation),
    borrow,
  ]
}
