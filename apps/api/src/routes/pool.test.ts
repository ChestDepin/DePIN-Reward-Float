import { type PoolAccount, poolAddress } from '@drf/anchor-client'
import { encodePool, fakeChain, key, storedAccount } from '@drf/anchor-client/test-support'
import { poolStateSchema } from '@drf/shared/api'
import { solanaAddressSchema } from '@drf/shared/schemas'
import { describe, expect, it } from 'vitest'
import { DataUnavailable } from './errors.ts'
import { buildPoolState, createChainPoolSource, createPoolRoutes, type PoolSource } from './pool.ts'

const STABLE_MINT = key(60)
const POOL = poolAddress(STABLE_MINT)

function account(fields: Partial<PoolAccount>): PoolAccount {
  return {
    authority: key(61),
    attestor: key(62),
    stableMint: STABLE_MINT,
    vault: key(63),
    totalShares: 1_000_000_000n,
    totalDeposits: 1_000_000_000n,
    totalBorrowed: 0n,
    accruedInterest: 0n,
    accrualRate: 0n,
    accrualRateTime: 0n,
    accrualRemainders: 0n,
    overduePrincipal: 0n,
    baseAprBps: 800,
    slopeAprBps: 2_000,
    bump: 255,
    ...fields,
  }
}

describe('buildPoolState', () => {
  it('weights the rate by what each open loan still owes', () => {
    // 300 owing at 900 bps and 100 owing at 1_300 bps: (300·900 + 100·1_300) / 400 = 1_000.
    const state = buildPoolState({
      address: POOL,
      account: account({
        totalBorrowed: 400_000_000n,
        accrualRate: 300_000_000n * 900n + 100_000_000n * 1_300n,
      }),
    })

    expect(state).toEqual({
      pool: POOL.toBase58(),
      stableMint: STABLE_MINT.toBase58(),
      totalDeposits: '1000000000',
      borrowed: '400000000',
      free: '600000000',
      utilisationBps: 4_000,
      loanAprBps: 1_000,
      lenderAprBps: 400,
    })
    expect(poolStateSchema.parse(state)).toEqual(state)
  })

  it('rounds down, so the pool never shows a lender more than it earns', () => {
    const state = buildPoolState({
      address: POOL,
      account: account({ totalDeposits: 3n, totalBorrowed: 2n, accrualRate: 2n * 901n + 1n }),
    })

    expect(state).toMatchObject({ utilisationBps: 6_666, loanAprBps: 901, lenderAprBps: 601 })
  })

  it('has no loan rate while nothing is lent, and the lenders earn nothing', () => {
    const state = buildPoolState({ address: POOL, account: account({}) })

    expect(state).toMatchObject({
      free: '1000000000',
      utilisationBps: 0,
      loanAprBps: null,
      lenderAprBps: 0,
    })
  })

  it('reads a pool nobody has deposited into as empty', () => {
    const state = buildPoolState({
      address: POOL,
      account: account({ totalShares: 0n, totalDeposits: 0n }),
    })

    expect(state).toMatchObject({
      totalDeposits: '0',
      free: '0',
      utilisationBps: 0,
      loanAprBps: null,
      lenderAprBps: 0,
    })
  })

  it('refuses a pool that has lent more than it holds, as the program does', () => {
    expect(() =>
      buildPoolState({
        address: POOL,
        account: account({ totalDeposits: 100n, totalBorrowed: 101n, accrualRate: 101n * 900n }),
      }),
    ).toThrow(/lent more than it holds/)
  })
})

describe('createChainPoolSource', () => {
  const pool = async () =>
    storedAccount(
      POOL,
      await encodePool({ attestor: key(62), stableMint: STABLE_MINT, vault: key(63) }),
    )

  function counting(chain: ReturnType<typeof fakeChain>) {
    let reads = 0
    return {
      get reads() {
        return reads
      },
      reader: {
        ...chain,
        getAccountInfo: (address: Parameters<typeof chain.getAccountInfo>[0]) => {
          reads += 1
          return chain.getAccountInfo(address)
        },
      },
    }
  }

  it('reads the pool of the stablecoin from the chain', async () => {
    const source = createChainPoolSource({
      reader: fakeChain([await pool()]),
      stableMint: STABLE_MINT,
      cacheMs: 15_000,
      clock: () => 0,
    })

    const read = await source.read()

    expect(read.address.equals(POOL)).toBe(true)
    expect(read.account.totalDeposits).toBe(500_000_000n)
  })

  it('answers from the last read while it is fresh, and reads again after', async () => {
    let now = 0
    const chain = counting(fakeChain([await pool()]))
    const source = createChainPoolSource({
      reader: chain.reader,
      stableMint: STABLE_MINT,
      cacheMs: 15_000,
      clock: () => now,
    })

    await source.read()
    now = 14_999
    await source.read()
    expect(chain.reads).toBe(1)

    now = 15_000
    await source.read()
    expect(chain.reads).toBe(2)
  })

  it('says the pool is unavailable when the RPC fails, and does not keep the failure', async () => {
    let failing = true
    const chain = fakeChain([await pool()])
    const source = createChainPoolSource({
      reader: {
        ...chain,
        getAccountInfo: async (address) => {
          if (failing) throw new Error('fetch failed')
          return chain.getAccountInfo(address)
        },
      },
      stableMint: STABLE_MINT,
      cacheMs: 15_000,
      clock: () => 0,
    })

    await expect(source.read()).rejects.toBeInstanceOf(DataUnavailable)

    failing = false
    await expect(source.read()).resolves.toMatchObject({ address: POOL })
  })

  it('treats a stablecoin without a pool as a misconfiguration, not as unavailable data', async () => {
    const source = createChainPoolSource({
      reader: fakeChain([]),
      stableMint: STABLE_MINT,
      cacheMs: 15_000,
      clock: () => 0,
    })

    const failure = await source.read().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(DataUnavailable)
  })
})

describe('GET /pool', () => {
  const lent = account({ totalBorrowed: 250_000_000n, accrualRate: 250_000_000n * 1_000n })
  const source = (read: PoolSource['read']): PoolSource => ({ read })

  it('answers with the state of the pool', async () => {
    const routes = createPoolRoutes({
      pool: source(async () => ({ address: POOL, account: lent })),
    })

    const response = await routes.request('/pool')

    expect(response.status).toBe(200)
    expect(poolStateSchema.parse(await response.json())).toEqual({
      pool: solanaAddressSchema.parse(POOL.toBase58()),
      stableMint: solanaAddressSchema.parse(STABLE_MINT.toBase58()),
      totalDeposits: '1000000000',
      borrowed: '250000000',
      free: '750000000',
      utilisationBps: 2_500,
      loanAprBps: 1_000,
      lenderAprBps: 250,
    })
  })

  it('says the pool could not be read when the chain is down', async () => {
    const routes = createPoolRoutes({
      pool: source(async () => {
        throw new DataUnavailable('the devnet pool')
      }),
    })

    const response = await routes.request('/pool')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'DATA_UNAVAILABLE', message: 'the pool could not be read' },
    })
  })

  it('says the pool is not set up when the api runs without devnet', async () => {
    const response = await createPoolRoutes({ pool: null }).request('/pool')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'DATA_UNAVAILABLE', message: 'the pool is not set up' },
    })
  })

  it('lets any other failure through to the server', async () => {
    const routes = createPoolRoutes({
      pool: source(async () => {
        throw new Error('pool not found')
      }),
    })

    const response = await routes.request('/pool')

    expect(response.status).toBe(500)
  })
})
