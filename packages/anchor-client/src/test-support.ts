import { BN, BorshCoder, type Program } from '@coral-xyz/anchor'
import { Connection, Keypair, type PublicKey } from '@solana/web3.js'
import { type RewardFloat, rewardFloatIdl } from './idl/reward-float.ts'
import { rewardFloatProgram } from './index.ts'

export const coder = new BorshCoder(rewardFloatIdl)

// Nothing here reaches the network: the port is closed and every builder under test
// passes its accounts in full, so a stray RPC call fails the test instead of hanging.
export function offlineProgram(): Program<RewardFloat> {
  return rewardFloatProgram(new Connection('http://127.0.0.1:1'))
}

export function key(seed: number): PublicKey {
  return Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey
}

export type LoanFields = {
  operator: PublicKey
  pool: PublicKey
  nonce: bigint
  outstanding?: bigint
  status?: 'active' | 'overdue' | 'repaid'
}

export async function encodeLoan(fields: LoanFields): Promise<Buffer> {
  return coder.accounts.encode('loan', {
    operator: fields.operator,
    pool: fields.pool,
    rewardMint: key(90),
    nonce: new BN(fields.nonce.toString()),
    principal: new BN(1_000_000),
    outstanding: new BN((fields.outstanding ?? 1_000_000n).toString()),
    accruedInterest: new BN(1234),
    interestRemainder: new BN(5),
    openedAt: new BN(1_790_000_000),
    dueAt: new BN(1_792_592_000),
    lastAccrualAt: new BN(1_790_000_100),
    aprBps: 1200,
    sweepBps: 5000,
    status: { [fields.status ?? 'active']: {} },
    bump: 254,
  })
}

export async function encodeOperatorAccount(owner: PublicKey, openLoans: number): Promise<Buffer> {
  return coder.accounts.encode('operatorAccount', {
    owner,
    totalDebt: new BN(2_000_000),
    openLoans,
    overdue: false,
    nonceFloor: new BN(0),
    usedNonces: [new BN(7), new BN(0), new BN(0), new BN(0)],
    bump: 253,
  })
}

export async function encodePool(fields: {
  attestor: PublicKey
  stableMint: PublicKey
  vault: PublicKey
}): Promise<Buffer> {
  return coder.accounts.encode('pool', {
    authority: key(80),
    attestor: fields.attestor,
    stableMint: fields.stableMint,
    vault: fields.vault,
    totalShares: new BN(0),
    totalDeposits: new BN(500_000_000),
    totalBorrowed: new BN(2_000_000),
    accruedInterest: new BN(1234),
    accrualRate: new BN('24000000000'),
    accrualRateTime: new BN('42960000000000000000'),
    accrualRemainders: new BN(5),
    overduePrincipal: new BN(0),
    baseAprBps: 800,
    slopeAprBps: 2000,
    bump: 252,
  })
}
