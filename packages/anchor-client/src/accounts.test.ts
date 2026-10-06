import { utils } from '@coral-xyz/anchor'
import {
  type AccountInfo,
  Connection,
  type GetProgramAccountsFilter,
  type PublicKey,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  type ChainReader,
  decodeConversionVault,
  decodeLoan,
  decodeOperatorAccount,
  decodePool,
  decodeRewardWatch,
  fetchAllOpenLoans,
  fetchConversionVault,
  fetchOpenLoans,
  fetchOperatorAccount,
  fetchPool,
  fetchRewardWatches,
  OpenLoansOutOfSync,
  openLoansForBorrow,
} from './accounts.ts'
import { operatorAccountAddress, rewardFloatProgramId } from './pda.ts'
import {
  encodeConversionVault,
  encodeLoan,
  encodeOperatorAccount,
  encodePool,
  encodeRewardWatch,
  key,
} from './test-support.ts'

type Stored = { pubkey: PublicKey; account: AccountInfo<Buffer> }

function stored(pubkey: PublicKey, data: Buffer, owner = rewardFloatProgramId): Stored {
  return { pubkey, account: { data, owner, lamports: 1, executable: false, rentEpoch: 0 } }
}

function matches(data: Buffer, filter: GetProgramAccountsFilter): boolean {
  if ('dataSize' in filter) return data.length === filter.dataSize
  const expected = utils.bytes.bs58.decode(filter.memcmp.bytes)
  return data
    .subarray(filter.memcmp.offset, filter.memcmp.offset + expected.length)
    .equals(Buffer.from(expected))
}

// Applies the filters the way an RPC node does, so a wrong offset in the client
// returns the wrong loans here too rather than whatever the stub was told to return.
function chain(accounts: Stored[]): ChainReader & { queries: GetProgramAccountsFilter[][] } {
  const queries: GetProgramAccountsFilter[][] = []
  return {
    queries,
    async getAccountInfo(address) {
      return accounts.find((a) => a.pubkey.equals(address))?.account ?? null
    },
    async getProgramAccounts(programId, config) {
      queries.push(config.filters)
      return accounts.filter(
        (a) =>
          a.account.owner.equals(programId) &&
          config.filters.every((f) => matches(a.account.data, f)),
      )
    },
  }
}

describe('decoding program accounts', () => {
  it('reads a loan into bigints without losing u64 precision', async () => {
    const loan = decodeLoan(
      await encodeLoan({
        operator: key(1),
        pool: key(2),
        nonce: 42n,
        outstanding: 2n ** 64n - 1n,
        status: 'overdue',
      }),
    )

    expect(loan.operator.equals(key(1))).toBe(true)
    expect(loan.nonce).toBe(42n)
    expect(loan.outstanding).toBe(18_446_744_073_709_551_615n)
    expect(loan.accruedInterest).toBe(1234n)
    expect(loan.dueAt).toBe(1_792_592_000n)
    expect(loan.aprBps).toBe(1200)
    expect(loan.status).toBe('overdue')
  })

  it('reads the operator account and the pool', async () => {
    const operator = decodeOperatorAccount(await encodeOperatorAccount(key(1), 3))
    const pool = decodePool(
      await encodePool({ attestor: key(3), stableMint: key(4), vault: key(5) }),
    )

    expect(operator.openLoans).toBe(3)
    expect(operator.usedNonces).toEqual([7n, 0n, 0n, 0n])
    expect(pool.attestor.equals(key(3))).toBe(true)
    expect(pool.totalDeposits).toBe(500_000_000n)
    expect(pool.accrualRate).toBe(24_000_000_000n)
    // u128: larger than any u64, so it has to come through as a bigint unrounded.
    expect(pool.accrualRateTime).toBe(42_960_000_000_000_000_000n)
    expect(pool.accrualRemainders).toBe(5n)
  })

  it('reads a conversion vault with its spread and tolerance', async () => {
    const vault = decodeConversionVault(
      await encodeConversionVault({
        pool: key(6),
        rewardMint: key(7),
        spreadBps: 30,
        maxSlippageBps: 100,
      }),
    )

    expect(vault.pool.equals(key(6))).toBe(true)
    expect(vault.rewardMint.equals(key(7))).toBe(true)
    expect(vault.stableVault.equals(key(81))).toBe(true)
    expect(vault.rewardVault.equals(key(82))).toBe(true)
    expect(vault.spreadBps).toBe(30)
    expect(vault.maxSlippageBps).toBe(100)
    expect(vault.bump).toBe(253)
  })

  it('reads the reward watch of an operator and a mint', async () => {
    const watch = decodeRewardWatch(
      await encodeRewardWatch({ operator: key(1), rewardMint: key(7), balance: 2n ** 64n - 1n }),
    )

    expect(watch.operator.equals(key(1))).toBe(true)
    expect(watch.rewardMint.equals(key(7))).toBe(true)
    expect(watch.balance).toBe(18_446_744_073_709_551_615n)
  })

  it('refuses bytes of another account type', async () => {
    const pool = await encodePool({ attestor: key(3), stableMint: key(4), vault: key(5) })

    expect(() => decodeLoan(pool)).toThrow()
  })

  it('refuses a truncated account', async () => {
    const loan = await encodeLoan({ operator: key(1), pool: key(2), nonce: 1n })

    expect(() => decodeLoan(loan.subarray(0, loan.length - 10))).toThrow()
  })
})

describe('reading accounts from the chain', () => {
  it('fetches the pool it is asked for', async () => {
    const reader = chain([
      stored(key(9), await encodePool({ attestor: key(3), stableMint: key(4), vault: key(5) })),
    ])

    const pool = await fetchPool(reader, key(9))

    expect(pool.address.equals(key(9))).toBe(true)
    expect(pool.account.vault.equals(key(5))).toBe(true)
  })

  it('refuses a pool that is missing or owned by another program', async () => {
    const data = await encodePool({ attestor: key(3), stableMint: key(4), vault: key(5) })
    const reader = chain([stored(key(9), data, key(77))])

    await expect(fetchPool(reader, key(8))).rejects.toThrow(/not found/)
    await expect(fetchPool(reader, key(9))).rejects.toThrow(/not owned by/)
  })

  it('reads a conversion vault that is not there yet as missing', async () => {
    const data = await encodeConversionVault({
      pool: key(6),
      rewardMint: key(7),
      spreadBps: 30,
      maxSlippageBps: 100,
    })
    const reader = chain([stored(key(9), data), stored(key(10), data, key(77))])

    expect(await fetchConversionVault(reader, key(8))).toBeNull()
    expect((await fetchConversionVault(reader, key(9)))?.spreadBps).toBe(30)
    await expect(fetchConversionVault(reader, key(10))).rejects.toThrow(/not owned by/)
  })

  it('reads a missing operator account as an operator who never borrowed', async () => {
    expect(await fetchOperatorAccount(chain([]), key(1))).toBeNull()
  })

  it('finds every active and overdue loan of the operator and nothing else', async () => {
    const operator = key(1)
    const reader = chain([
      stored(key(11), await encodeLoan({ operator, pool: key(2), nonce: 1n })),
      stored(key(12), await encodeLoan({ operator, pool: key(2), nonce: 2n, status: 'overdue' })),
      stored(key(13), await encodeLoan({ operator, pool: key(2), nonce: 3n, status: 'repaid' })),
      stored(key(14), await encodeLoan({ operator: key(3), pool: key(2), nonce: 1n })),
      stored(key(15), await encodeLoan({ operator, pool: key(2), nonce: 4n }), key(77)),
      stored(operatorAccountAddress(operator), await encodeOperatorAccount(operator, 2)),
    ])

    const loans = await fetchOpenLoans(reader, operator)

    expect(loans.map((l) => l.address.toBase58()).sort()).toEqual(
      [key(11), key(12)].map((k) => k.toBase58()).sort(),
    )
    expect(reader.queries).toHaveLength(2)
  })

  it('finds every reward watch of every operator and no other account', async () => {
    const reader = chain([
      stored(
        key(21),
        await encodeRewardWatch({ operator: key(1), rewardMint: key(7), balance: 5n }),
      ),
      stored(
        key(22),
        await encodeRewardWatch({ operator: key(3), rewardMint: key(8), balance: 0n }),
      ),
      stored(key(23), await encodeLoan({ operator: key(1), pool: key(2), nonce: 1n })),
      stored(operatorAccountAddress(key(1)), await encodeOperatorAccount(key(1), 1)),
    ])

    const watches = await fetchRewardWatches(reader)

    expect(watches.map((w) => [w.address.toBase58(), w.account.balance])).toEqual([
      [key(21).toBase58(), 5n],
      [key(22).toBase58(), 0n],
    ])
    expect(reader.queries).toHaveLength(1)
  })

  it('finds the open loans of every operator, none that are repaid', async () => {
    const reader = chain([
      stored(key(11), await encodeLoan({ operator: key(1), pool: key(2), nonce: 1n })),
      stored(
        key(12),
        await encodeLoan({ operator: key(3), pool: key(2), nonce: 1n, status: 'overdue' }),
      ),
      stored(
        key(13),
        await encodeLoan({ operator: key(1), pool: key(2), nonce: 2n, status: 'repaid' }),
      ),
      stored(key(14), await encodeLoan({ operator: key(3), pool: key(2), nonce: 2n }), key(77)),
    ])

    const loans = await fetchAllOpenLoans(reader)

    expect(loans.map((l) => l.address.toBase58()).sort()).toEqual(
      [key(11), key(12)].map((k) => k.toBase58()).sort(),
    )
    expect(reader.queries).toHaveLength(2)
  })

  it('accepts a real Connection as the reader', () => {
    const reader: ChainReader = new Connection('http://127.0.0.1:1')
    expect(reader).toBeDefined()
  })
})

describe('open loans for a borrow', () => {
  const pool = key(2)
  const operator = key(1)

  async function open(address: PublicKey, nonce: bigint, inPool = pool) {
    return { address, account: decodeLoan(await encodeLoan({ operator, pool: inPool, nonce })) }
  }

  it('passes the loans through when they are exactly the ones the program counts', async () => {
    const account = decodeOperatorAccount(await encodeOperatorAccount(operator, 2))
    const loans = [await open(key(11), 1n), await open(key(12), 2n)]

    const accounts = openLoansForBorrow({ operatorAccount: account, pool, loans })

    expect(accounts.map((a) => a.toBase58())).toEqual([key(11), key(12)].map((k) => k.toBase58()))
  })

  it('needs none for an operator who never borrowed', () => {
    expect(openLoansForBorrow({ operatorAccount: null, pool, loans: [] })).toEqual([])
  })

  it('refuses before signing when the chain shows fewer loans than the program counts', async () => {
    const account = decodeOperatorAccount(await encodeOperatorAccount(operator, 2))
    const loans = [await open(key(11), 1n)]

    expect(() => openLoansForBorrow({ operatorAccount: account, pool, loans })).toThrow(
      OpenLoansOutOfSync,
    )
  })

  it('refuses when an open loan belongs to another pool', async () => {
    const account = decodeOperatorAccount(await encodeOperatorAccount(operator, 1))
    const loans = [await open(key(11), 1n, key(3))]

    expect(() => openLoansForBorrow({ operatorAccount: account, pool, loans })).toThrow(
      /another pool/,
    )
  })
})
