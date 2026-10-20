import {
  type ChainReader,
  fetchPool,
  type OnChain,
  type PoolAccount,
  poolAddress,
} from '@drf/anchor-client'
import type { PoolState } from '@drf/shared/api'
import { solanaAddressSchema } from '@drf/shared/schemas'
import type { PublicKey } from '@solana/web3.js'
import { Hono } from 'hono'
import { DataUnavailable, errorBody, reading } from './errors.ts'

const BPS = 10_000n

export type PoolSource = { read(): Promise<OnChain<PoolAccount>> }

// `accrualRate` is the sum of outstanding · apr_bps over the open loans, kept by the
// program for accrual, so the weighted rate needs no read of the loans themselves.
// Every share is rounded down: a lender is never shown more than the pool earns.
export function buildPoolState({ address, account }: OnChain<PoolAccount>): PoolState {
  const { totalDeposits, totalBorrowed, accrualRate } = account
  if (totalBorrowed > totalDeposits) {
    throw new Error(`pool ${address.toBase58()} has lent more than it holds`)
  }
  return {
    pool: solanaAddressSchema.parse(address.toBase58()),
    stableMint: solanaAddressSchema.parse(account.stableMint.toBase58()),
    totalDeposits: totalDeposits.toString(),
    borrowed: totalBorrowed.toString(),
    free: (totalDeposits - totalBorrowed).toString(),
    utilisationBps: totalDeposits === 0n ? 0 : Number((totalBorrowed * BPS) / totalDeposits),
    loanAprBps: totalBorrowed === 0n ? null : Number(accrualRate / totalBorrowed),
    lenderAprBps: totalDeposits === 0n ? 0 : Number(accrualRate / totalDeposits),
  }
}

export function createChainPoolSource({
  reader,
  stableMint,
  cacheMs,
  clock,
}: {
  reader: ChainReader
  stableMint: PublicKey
  cacheMs: number
  clock: () => number
}): PoolSource {
  const address = poolAddress(stableMint)
  // Only the RPC call is unavailability: a missing pool or foreign bytes are our setup.
  const chain: ChainReader = {
    getAccountInfo: (at) => reading('the devnet pool', reader.getAccountInfo(at)),
    getProgramAccounts: (programId, config) =>
      reading('the devnet pool', reader.getProgramAccounts(programId, config)),
  }
  let cached: { at: number; pool: Promise<OnChain<PoolAccount>> } | null = null

  return {
    read() {
      if (cached !== null && clock() - cached.at < cacheMs) return cached.pool
      const pool = fetchPool(chain, address)
      const entry = { at: clock(), pool }
      cached = entry
      pool.catch(() => {
        if (cached === entry) cached = null
      })
      return pool
    },
  }
}

export function createPoolRoutes({ pool }: { pool: PoolSource | null }): Hono {
  const routes = new Hono()

  // FR-019: public. Anyone deciding whether to lend sees the same pool.
  routes.get('/pool', async (c) => {
    if (pool === null) {
      return c.json(errorBody('DATA_UNAVAILABLE', 'the pool is not set up'), 503)
    }
    try {
      return c.json(buildPoolState(await pool.read()))
    } catch (error) {
      if (!(error instanceof DataUnavailable)) throw error
      return c.json(errorBody('DATA_UNAVAILABLE', 'the pool could not be read'), 503)
    }
  })

  return routes
}
