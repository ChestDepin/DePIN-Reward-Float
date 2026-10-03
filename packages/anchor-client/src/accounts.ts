import { BN, BorshCoder, utils } from '@coral-xyz/anchor'
import { type AccountInfo, type GetProgramAccountsFilter, PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { rewardFloatIdl } from './idl/reward-float.ts'
import { operatorAccountAddress, rewardFloatProgramId } from './pda.ts'

const coder = new BorshCoder(rewardFloatIdl)

const integer = z
  .custom<BN>((value) => BN.isBN(value), 'expected a BN')
  .transform((value) => BigInt(value.toString()))
const pubkey = z.instanceof(PublicKey)
const small = z.number().int().nonnegative()

const variant = <const Name extends string>(name: Name) =>
  z.strictObject({ [name]: z.strictObject({}) }).transform(() => name)

export const loanSchema = z.object({
  operator: pubkey,
  pool: pubkey,
  rewardMint: pubkey,
  nonce: integer,
  principal: integer,
  outstanding: integer,
  accruedInterest: integer,
  interestRemainder: integer,
  openedAt: integer,
  dueAt: integer,
  lastAccrualAt: integer,
  aprBps: small,
  sweepBps: small,
  status: z.union([variant('active'), variant('overdue'), variant('repaid')]),
  bump: small,
})

export const operatorAccountSchema = z.object({
  owner: pubkey,
  totalDebt: integer,
  openLoans: small,
  overdue: z.boolean(),
  nonceFloor: integer,
  usedNonces: z.array(integer),
  bump: small,
})

export const poolSchema = z.object({
  authority: pubkey,
  attestor: pubkey,
  stableMint: pubkey,
  vault: pubkey,
  totalShares: integer,
  totalDeposits: integer,
  totalBorrowed: integer,
  accruedInterest: integer,
  overduePrincipal: integer,
  baseAprBps: small,
  slopeAprBps: small,
  bump: small,
})

export type LoanAccount = z.infer<typeof loanSchema>
export type OperatorAccount = z.infer<typeof operatorAccountSchema>
export type PoolAccount = z.infer<typeof poolSchema>
export type OnChain<T> = { address: PublicKey; account: T }

export function decodeLoan(data: Buffer): LoanAccount {
  return loanSchema.parse(coder.accounts.decode<unknown>('loan', data))
}

export function decodeOperatorAccount(data: Buffer): OperatorAccount {
  return operatorAccountSchema.parse(coder.accounts.decode<unknown>('operatorAccount', data))
}

export function decodePool(data: Buffer): PoolAccount {
  return poolSchema.parse(coder.accounts.decode<unknown>('pool', data))
}

// The two calls a Connection answers here, narrowed so that tests can stand in for it.
export type ChainReader = {
  getAccountInfo(address: PublicKey): Promise<AccountInfo<Buffer> | null>
  getProgramAccounts(
    programId: PublicKey,
    config: { filters: GetProgramAccountsFilter[] },
  ): Promise<readonly { pubkey: PublicKey; account: AccountInfo<Buffer> }[]>
}

// A discriminator proves the bytes have the right shape, not where they came from: any
// program can write them. Only the owner says the reward-float program wrote them.
async function readProgramAccount(reader: ChainReader, address: PublicKey): Promise<Buffer | null> {
  const info = await reader.getAccountInfo(address)
  if (info === null) return null
  if (!info.owner.equals(rewardFloatProgramId)) {
    throw new Error(`${address.toBase58()} is not owned by the reward-float program`)
  }
  return info.data
}

export async function fetchPool(
  reader: ChainReader,
  address: PublicKey,
): Promise<OnChain<PoolAccount>> {
  const data = await readProgramAccount(reader, address)
  if (data === null) throw new Error(`pool ${address.toBase58()} not found`)
  return { address, account: decodePool(data) }
}

// No account means the operator has never borrowed: borrow opens it with the first loan.
export async function fetchOperatorAccount(
  reader: ChainReader,
  operator: PublicKey,
): Promise<OperatorAccount | null> {
  const data = await readProgramAccount(reader, operatorAccountAddress(operator))
  return data === null ? null : decodeOperatorAccount(data)
}

const LOAN_OPERATOR_OFFSET = 8
// Discriminator, three keys, eight 64-bit fields, two u16 — fixed-size, so status sits
// at a fixed offset and the RPC node can filter on it.
const LOAN_STATUS_OFFSET = 8 + 3 * 32 + 8 * 8 + 2 * 2
const OPEN_STATUS_VARIANTS = [0, 1]

function loanDiscriminator(): number[] {
  const loan = rewardFloatIdl.accounts.find((account) => account.name === 'loan')
  if (loan === undefined) throw new Error('the vendored IDL has no loan account')
  return loan.discriminator
}

function memcmp(offset: number, bytes: Uint8Array | number[]): GetProgramAccountsFilter {
  return { memcmp: { offset, bytes: utils.bytes.bs58.encode(Buffer.from(bytes)) } }
}

// Loans are never closed, so a filter on the operator alone would also return every
// loan they ever repaid. A memcmp cannot say "not repaid", hence a query per open status.
export async function fetchOpenLoans(
  reader: ChainReader,
  operator: PublicKey,
): Promise<OnChain<LoanAccount>[]> {
  const pages = await Promise.all(
    OPEN_STATUS_VARIANTS.map((status) =>
      reader.getProgramAccounts(rewardFloatProgramId, {
        filters: [
          memcmp(0, loanDiscriminator()),
          memcmp(LOAN_OPERATOR_OFFSET, operator.toBuffer()),
          memcmp(LOAN_STATUS_OFFSET, [status]),
        ],
      }),
    ),
  )
  return pages.flat().map(({ pubkey, account }) => ({
    address: pubkey,
    account: decodeLoan(account.data),
  }))
}

// The list and the count are two reads that may land on different slots; refetching
// both is the way out. Caught here, it costs a retry instead of a failed transaction.
export class OpenLoansOutOfSync extends Error {
  override name = 'OpenLoansOutOfSync'
}

export function openLoansForBorrow(input: {
  operatorAccount: OperatorAccount | null
  pool: PublicKey
  loans: readonly OnChain<LoanAccount>[]
}): PublicKey[] {
  for (const { address, account } of input.loans) {
    if (account.status === 'repaid') {
      throw new OpenLoansOutOfSync(`loan ${address.toBase58()} is already repaid`)
    }
    if (!account.pool.equals(input.pool)) {
      throw new OpenLoansOutOfSync(
        `loan ${address.toBase58()} is open in another pool, which blocks borrowing here`,
      )
    }
  }
  const counted = input.operatorAccount?.openLoans ?? 0
  if (input.loans.length !== counted) {
    throw new OpenLoansOutOfSync(
      `found ${input.loans.length} open loans, the operator account counts ${counted}`,
    )
  }
  return input.loans.map((loan) => loan.address)
}
