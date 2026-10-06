import { Program } from '@coral-xyz/anchor'
import type { Connection } from '@solana/web3.js'
import { type RewardFloat, rewardFloatIdl } from './idl/reward-float.ts'

export * from './accounts.ts'
export * from './borrow.ts'
export * from './delegate.ts'
export * from './deposit.ts'
export { type RewardFloat, rewardFloatIdl } from './idl/reward-float.ts'
export * from './pda.ts'
export * from './repay.ts'
export * from './reward-mints.ts'
export * from './sweep.ts'
export {
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  fetchStableBalance,
  mintToInstruction,
  tokenAmount,
} from './token.ts'

export type RewardFloatProgram = Program<RewardFloat>

export function rewardFloatProgram(connection: Connection): RewardFloatProgram {
  return new Program(rewardFloatIdl, { connection })
}
