import { BN, type Program, utils } from '@coral-xyz/anchor'
import { type PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js'
import type { OnChain, PoolAccount } from './accounts.ts'
import type { RewardFloat } from './idl/reward-float.ts'
import { lenderShareAddress, u64Bytes } from './pda.ts'

export type DepositRequest = {
  lender: PublicKey
  pool: OnChain<PoolAccount>
  amount: bigint
}

export async function depositInstruction(
  program: Program<RewardFloat>,
  request: DepositRequest,
): Promise<TransactionInstruction> {
  const { lender, pool } = request
  return program.methods
    .deposit(new BN(u64Bytes(request.amount), 'le'))
    .accountsStrict({
      lender,
      pool: pool.address,
      lenderShare: lenderShareAddress(pool.address, lender),
      vault: pool.account.vault,
      source: utils.token.associatedAddress({ mint: pool.account.stableMint, owner: lender }),
      tokenProgram: utils.token.TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}
