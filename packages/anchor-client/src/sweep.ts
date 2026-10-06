import { BN, BorshCoder, EventParser, type Program, utils } from '@coral-xyz/anchor'
import type { IssuedRateAttestation } from '@drf/shared/api'
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, type TransactionInstruction } from '@solana/web3.js'
import { z } from 'zod'
import type { ConversionVaultAccount, OnChain, PoolAccount } from './accounts.ts'
import { AttestationMismatch, signatureCheck } from './borrow.ts'
import { type RewardFloat, rewardFloatIdl } from './idl/reward-float.ts'
import { operatorAccountAddress, rewardFloatProgramId, rewardWatchAddress } from './pda.ts'

export type SweepRequest = {
  operator: PublicKey
  pool: OnChain<PoolAccount>
  conversionVault: OnChain<ConversionVaultAccount>
  rate: IssuedRateAttestation
  // Every open loan of the operator, of every reward mint: sweep wants exactly the
  // operator's open_loans, the same set borrow does.
  openLoans: readonly PublicKey[]
}

// A refused rate would fail the transaction only after its fee is paid, and a keeper
// retries every few seconds.
function checkRate({ rate, pool, conversionVault }: SweepRequest): void {
  if (!new PublicKey(rate.attestor).equals(pool.account.attestor)) {
    throw new AttestationMismatch(
      `the rate is signed by ${rate.attestor}, the pool trusts ${pool.account.attestor.toBase58()}`,
    )
  }
  if (!new PublicKey(rate.rewardMint).equals(conversionVault.account.rewardMint)) {
    throw new AttestationMismatch(
      `the rate is for ${rate.rewardMint}, the vault buys ${conversionVault.account.rewardMint.toBase58()}`,
    )
  }
}

// Two instructions: the attestor's signature over the rate, and sweep, which reads the
// rate from the instruction right before it.
export async function sweepInstructions(
  program: Program<RewardFloat>,
  request: SweepRequest,
): Promise<TransactionInstruction[]> {
  checkRate(request)
  const { operator, pool, conversionVault } = request
  const rewardMint = conversionVault.account.rewardMint

  const sweep = await program.methods
    .sweep()
    .accountsStrict({
      pool: pool.address,
      operatorAccount: operatorAccountAddress(operator),
      rewardAccount: utils.token.associatedAddress({ mint: rewardMint, owner: operator }),
      rewardWatch: rewardWatchAddress(operator, rewardMint),
      conversionVault: conversionVault.address,
      stableVault: conversionVault.account.stableVault,
      rewardVault: conversionVault.account.rewardVault,
      vault: pool.account.vault,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: utils.token.TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(
      request.openLoans.map((loan) => ({ pubkey: loan, isSigner: false, isWritable: true })),
    )
    .instruction()

  return [signatureCheck(request.rate), sweep]
}

const integer = z
  .custom<BN>((value) => BN.isBN(value), 'expected a BN')
  .transform((value) => BigInt(value.toString()))
const pubkey = z.instanceof(PublicKey)
const bps = z.number().int().nonnegative()

const sweptSchema = z
  .object({
    loan: pubkey,
    operator: pubkey,
    rewardMint: pubkey,
    withheld: integer,
    paid: integer,
    stablePerTrillionReward: integer,
    deviationBps: bps,
    remainingDebt: integer,
  })
  .transform((data) => ({ kind: 'swept' as const, ...data }))

const skippedSchema = z
  .object({
    operator: pubkey,
    rewardMint: pubkey,
    withheld: integer,
    stablePerTrillionReward: integer,
    deviationBps: bps,
    maxSlippageBps: bps,
  })
  .transform((data) => ({ kind: 'skipped' as const, ...data }))

export type SweepEvent = z.infer<typeof sweptSchema> | z.infer<typeof skippedSchema>

const parser = new EventParser(rewardFloatProgramId, new BorshCoder(rewardFloatIdl))

export function sweepEvents(logs: readonly string[]): SweepEvent[] {
  const events: SweepEvent[] = []
  for (const event of parser.parseLogs([...logs])) {
    if (event.name === 'swept') events.push(sweptSchema.parse(event.data))
    if (event.name === 'sweepSkipped') events.push(skippedSchema.parse(event.data))
  }
  return events
}
