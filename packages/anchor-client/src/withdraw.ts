import { BN, type Program, utils } from '@coral-xyz/anchor'
import type { PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { OnChain, PoolAccount } from './accounts.ts'
import type { RewardFloat } from './idl/reward-float.ts'
import { lenderShareAddress, u64Bytes } from './pda.ts'

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
