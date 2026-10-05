import { Program } from '@coral-xyz/anchor'
import type { Connection } from '@solana/web3.js'
import { type RewardFloat, rewardFloatIdl } from './idl/reward-float.ts'

export * from './accounts.ts'
export * from './borrow.ts'
export * from './deposit.ts'
export { type RewardFloat, rewardFloatIdl } from './idl/reward-float.ts'
export * from './pda.ts'
export * from './repay.ts'
export { fetchStableBalance } from './token.ts'

export function rewardFloatProgram(connection: Connection): Program<RewardFloat> {
  return new Program(rewardFloatIdl, { connection })
}
