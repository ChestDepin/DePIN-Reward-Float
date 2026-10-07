import { BN, BorshCoder, type Program, utils } from '@coral-xyz/anchor'
import { type IssuedRateAttestation, issuedRateAttestationSchema } from '@drf/shared/api'
import { signRateAttestation } from '@drf/shared/attestation'
import { solanaAddressSchema } from '@drf/shared/schemas'
import {
  type AccountInfo,
  Connection,
  type GetProgramAccountsFilter,
  Keypair,
  type PublicKey,
} from '@solana/web3.js'
import { type RewardFloat, rewardFloatIdl } from './idl/reward-float.ts'
import { rewardFloatProgram } from './index.ts'
import { rewardFloatProgramId } from './pda.ts'

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
  rewardMint?: PublicKey
  rewardDue?: bigint
  manualRepayment?: 'revoked' | 'allowanceShort' | 'withdrawnEarly' | null
}

export async function encodeLoan(fields: LoanFields): Promise<Buffer> {
  return coder.accounts.encode('loan', {
    operator: fields.operator,
    pool: fields.pool,
    rewardMint: fields.rewardMint ?? key(90),
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
    rewardDue: new BN((fields.rewardDue ?? 0n).toString()),
    manualRepayment:
      fields.manualRepayment === undefined || fields.manualRepayment === null
        ? null
        : { [fields.manualRepayment]: {} },
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

export async function encodeConversionVault(fields: {
  pool: PublicKey
  rewardMint: PublicKey
  spreadBps: number
  maxSlippageBps: number
}): Promise<Buffer> {
  return coder.accounts.encode('conversionVault', {
    pool: fields.pool,
    rewardMint: fields.rewardMint,
    stableVault: key(81),
    rewardVault: key(82),
    spreadBps: fields.spreadBps,
    maxSlippageBps: fields.maxSlippageBps,
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

export async function encodeRewardWatch(fields: {
  operator: PublicKey
  rewardMint: PublicKey
  balance: bigint
}): Promise<Buffer> {
  return coder.accounts.encode('rewardWatch', {
    operator: fields.operator,
    rewardMint: fields.rewardMint,
    balance: new BN(fields.balance.toString()),
    bump: 251,
  })
}

export const attestorSeed = new Uint8Array(32).fill(21)
export const attestorKey = Keypair.fromSeed(attestorSeed).publicKey

export async function issuedRate(
  rewardMint: PublicKey,
  signer: Uint8Array = attestorSeed,
): Promise<IssuedRateAttestation> {
  const pricedAt = new Date('2026-10-07T10:00:00Z')
  const expiresAt = new Date('2026-10-07T10:02:00Z')
  const { message, signature } = await signRateAttestation(
    {
      rewardMint: solanaAddressSchema.parse(rewardMint.toBase58()),
      stablePerTrillionReward: 2_406_662n,
      pricedAt,
      expiresAt,
    },
    signer,
  )
  return issuedRateAttestationSchema.parse({
    rewardMint: rewardMint.toBase58(),
    stablePerTrillionReward: '2406662',
    attestor: Keypair.fromSeed(signer).publicKey.toBase58(),
    message: utils.bytes.bs58.encode(message),
    signature: utils.bytes.bs58.encode(signature),
    pricedAt: pricedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  })
}

type EventName = 'swept' | 'sweepSkipped' | 'manualRepaymentNeeded'

function eventData(name: EventName, data: Record<string, unknown>): string {
  const event = rewardFloatIdl.events.find((e) => e.name === name)
  if (event === undefined) throw new Error(`the vendored IDL has no ${name} event`)
  const fields = Object.fromEntries(
    Object.entries(data).map(([field, value]) => [
      field,
      typeof value === 'bigint' ? new BN(value.toString()) : value,
    ]),
  )
  const body = coder.types.encode(name, fields)
  return `Program data: ${Buffer.concat([Buffer.from(event.discriminator), body]).toString('base64')}`
}

// The log lines of a transaction whose sweep emitted these events, as an RPC node
// returns them: the parser only reads data inside the program's own invocation.
export function sweepLogs(events: readonly { name: EventName; data: Record<string, unknown> }[]) {
  const program = rewardFloatIdl.address
  return [
    'Program Ed25519SigVerify111111111111111111111111111 invoke [1]',
    'Program Ed25519SigVerify111111111111111111111111111 success',
    `Program ${program} invoke [1]`,
    'Program log: Instruction: Sweep',
    ...events.map((event) => eventData(event.name, event.data)),
    `Program ${program} consumed 23000 of 200000 compute units`,
    `Program ${program} success`,
  ]
}

// SPL token account: mint (0), owner (32), amount u64 LE (64), then the rest up to 165.
export function encodeTokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(165)
  mint.toBuffer().copy(data, 0)
  owner.toBuffer().copy(data, 32)
  data.writeBigUInt64LE(amount, 64)
  return data
}

export type StoredAccount = { pubkey: PublicKey; account: AccountInfo<Buffer> }

export function storedAccount(
  pubkey: PublicKey,
  data: Buffer,
  owner: PublicKey = rewardFloatProgramId,
): StoredAccount {
  return { pubkey, account: { data, owner, lamports: 1, executable: false, rentEpoch: 0 } }
}

function matches(data: Buffer, filter: GetProgramAccountsFilter): boolean {
  if ('dataSize' in filter) return data.length === filter.dataSize
  const expected = utils.bytes.bs58.decode(filter.memcmp.bytes)
  return data
    .subarray(filter.memcmp.offset, filter.memcmp.offset + expected.length)
    .equals(Buffer.from(expected))
}

// The three reads a Connection answers for a keeper, over a fixed set of accounts that
// a test may change between calls. Filters apply the way an RPC node applies them.
export function fakeChain(accounts: StoredAccount[]) {
  const find = (address: PublicKey) =>
    accounts.find((a) => a.pubkey.equals(address))?.account ?? null
  return {
    accounts,
    async getAccountInfo(address: PublicKey) {
      return find(address)
    },
    async getMultipleAccountsInfo(addresses: PublicKey[]) {
      return addresses.map(find)
    },
    async getProgramAccounts(
      programId: PublicKey,
      config: { filters: GetProgramAccountsFilter[] },
    ) {
      return accounts.filter(
        (a) =>
          a.account.owner.equals(programId) &&
          config.filters.every((f) => matches(a.account.data, f)),
      )
    },
  }
}
