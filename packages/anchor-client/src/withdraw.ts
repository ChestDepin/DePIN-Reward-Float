import { BN, BorshCoder, EventParser, type Program, utils } from '@coral-xyz/anchor'
import { PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { z } from 'zod'
import type { OnChain, PoolAccount } from './accounts.ts'
import { type RewardFloat, rewardFloatIdl } from './idl/reward-float.ts'
import { lenderShareAddress, rewardFloatProgramId, u64Bytes } from './pda.ts'

export type WithdrawRequest = {
  lender: PublicKey
  pool: OnChain<PoolAccount>
  // At most this much: the program pays no more than the shares are worth and no more
  // than is free, and says in its Withdrawn event which of the two held it back.
  maxAmount: bigint
}

export async function withdrawInstruction(
  program: Program<RewardFloat>,
  request: WithdrawRequest,
): Promise<TransactionInstruction> {
  const { lender, pool } = request
  return program.methods
    .withdraw(new BN(u64Bytes(request.maxAmount), 'le'))
    .accountsStrict({
      lender,
      pool: pool.address,
      lenderShare: lenderShareAddress(pool.address, lender),
      vault: pool.account.vault,
      destination: utils.token.associatedAddress({ mint: pool.account.stableMint, owner: lender }),
      tokenProgram: utils.token.TOKEN_PROGRAM_ID,
    })
    .instruction()
}

const integer = z
  .custom<BN>((value) => BN.isBN(value), 'expected a BN')
  .transform((value) => BigInt(value.toString()))
const pubkey = z.instanceof(PublicKey)

const withdrawnSchema = z.object({
  pool: pubkey,
  lender: pubkey,
  requested: integer,
  paid: integer,
  sharesBurned: integer,
  limitedBy: z
    .union([
      z.strictObject({ position: z.strictObject({}) }).transform(() => 'position' as const),
      z
        .strictObject({ freeLiquidity: z.strictObject({}) })
        .transform(() => 'free-liquidity' as const),
    ])
    .nullable(),
})

export type WithdrawnEvent = z.infer<typeof withdrawnSchema>

const parser = new EventParser(rewardFloatProgramId, new BorshCoder(rewardFloatIdl))

// What the program actually paid, from the transaction's logs: the page's quote was made
// a few seconds earlier, against a pool that may have moved since.
export function withdrawnEvent(logs: readonly string[]): WithdrawnEvent | null {
  for (const event of parser.parseLogs([...logs])) {
    if (event.name === 'withdrawn') return withdrawnSchema.parse(event.data)
  }
  return null
}
