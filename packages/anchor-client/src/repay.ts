import { BN, type Program, utils } from '@coral-xyz/anchor'
import type { PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { LoanAccount, OnChain, PoolAccount } from './accounts.ts'
import type { RewardFloat } from './idl/reward-float.ts'
import { operatorAccountAddress, u64Bytes } from './pda.ts'

export type RepayRequest = {
  // Anyone may repay a loan, from their own stablecoin account.
  payer: PublicKey
  pool: OnChain<PoolAccount>
  loan: OnChain<LoanAccount>
  // A ceiling, not an amount: interest grows every second, so the exact debt at the
  // moment the transaction lands cannot be known when it is signed.
  maxAmount: bigint
}

export async function repayInstruction(
  program: Program<RewardFloat>,
  request: RepayRequest,
): Promise<TransactionInstruction> {
  const { payer, pool, loan } = request
  return program.methods
    .repay(new BN(u64Bytes(request.maxAmount), 'le'))
    .accountsStrict({
      payer,
      pool: pool.address,
      loan: loan.address,
      operatorAccount: operatorAccountAddress(loan.account.operator),
      vault: pool.account.vault,
      source: utils.token.associatedAddress({ mint: pool.account.stableMint, owner: payer }),
      tokenProgram: utils.token.TOKEN_PROGRAM_ID,
    })
    .instruction()
}
