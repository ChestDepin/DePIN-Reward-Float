import { type NetworkCreditLimit, networkCreditLimitSchema } from '@drf/shared/api'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  attestedLimit,
  borrowableNetworks,
  describeBorrowFailure,
  parseStableAmount,
  quoteLoan,
} from './borrow'

const MINT_A = 'So11111111111111111111111111111111111111112'
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function network(id: string, limitUsd: string | null): NetworkCreditLimit {
  return networkCreditLimitSchema.parse({
    networkId: id,
    displayName: id.toUpperCase(),
    token: { symbol: id.slice(0, 3).toUpperCase(), decimals: 9 },
    limitUsd,
    factors: [],
    reason:
      limitUsd === null
        ? { kind: 'short-history', requiredMonths: 6, thresholdReachedIn: '2027-01' }
        : null,
    computedAt: '2026-10-03T10:00:00.000Z',
    expiresAt: '2026-10-04T10:00:00.000Z',
  })
}

describe('parseStableAmount', () => {
  it('reads dollars and cents into base units', () => {
    expect(parseStableAmount('125')).toBe(125_000_000n)
    expect(parseStableAmount('0.5')).toBe(500_000n)
    expect(parseStableAmount(' 1,234.56 ')).toBe(1_234_560_000n)
  })

  it('has nothing to say about an empty, zero, negative or over-precise amount', () => {
    for (const text of ['', '0', '0.00', '-5', '1.0000001', 'abc', '1.2.3']) {
      expect(parseStableAmount(text)).toBeNull()
    }
  })
})

describe('attestedLimit', () => {
  it('adds the limits of every network that has one, as the attestation does', () => {
    expect(
      attestedLimit([
        network('hivemapper', '300000000'),
        network('helium', '55000000'),
        network('other', null),
      ]),
    ).toBe(355_000_000n)
  })
})

describe('borrowableNetworks', () => {
  const mints = new Map([['hivemapper', new PublicKey(MINT_B)]])

  it('offers the networks with a limit and a devnet mint, the largest limit first', () => {
    const options = borrowableNetworks(
      [network('helium', '9000000'), network('hivemapper', '300000000')],
      new Map([...mints, ['helium', new PublicKey(MINT_A)]]),
    )

    expect(options.map((o) => [o.networkId, o.unavailable])).toEqual([
      ['hivemapper', null],
      ['helium', null],
    ])
  })

  it('names why a network cannot back a loan', () => {
    const options = borrowableNetworks(
      [network('hivemapper', '300000000'), network('helium', '9000000'), network('other', null)],
      mints,
    )

    expect(options.map((o) => [o.networkId, o.unavailable])).toEqual([
      ['hivemapper', null],
      ['helium', 'no-devnet-mint'],
      ['other', 'no-limit'],
    ])
  })
})

describe('quoteLoan', () => {
  const pool = {
    baseAprBps: 800,
    slopeAprBps: 2_000,
    totalBorrowed: 100_000_000n,
    totalDeposits: 1_000_000_000n,
  }
  const base = { limit: 355_000_000n, debt: 55_000_000n, pool, termPeriods: 3 }

  it('quotes the fixed rate and the cost of the loan asked for', () => {
    const view = quoteLoan({ ...base, amount: 200_000_000n })

    expect(view.kind).toBe('quote')
    if (view.kind !== 'quote') return
    expect(view.aprBps).toBe(1_400)
    expect(view.cost.schedule).toHaveLength(3)
  })

  it('lends up to the limit less the debt, and not a unit more', () => {
    expect(quoteLoan({ ...base, amount: 300_000_000n }).kind).toBe('quote')
    expect(quoteLoan({ ...base, amount: 300_000_001n })).toEqual({
      kind: 'over-limit',
      available: 300_000_000n,
    })
  })

  it('names what is free in the pool when the loan would take more', () => {
    const view = quoteLoan({ ...base, limit: 10_000_000_000n, amount: 900_000_001n })

    expect(view).toEqual({ kind: 'insufficient-liquidity', free: 900_000_000n })
  })

  it('waits for an amount', () => {
    expect(quoteLoan({ ...base, amount: null })).toEqual({ kind: 'enter-amount' })
  })

  it('has nothing to lend when the debt already reaches the limit', () => {
    expect(quoteLoan({ ...base, debt: 400_000_000n, amount: 1n })).toEqual({
      kind: 'over-limit',
      available: 0n,
    })
  })
})

describe('describeBorrowFailure', () => {
  it('reads the program error from simulation logs', () => {
    const error = Object.assign(new Error('Simulation failed'), {
      logs: ['Program log: AnchorError ...', 'Program x failed: custom program error: 0x1782'],
    })

    expect(describeBorrowFailure(error)).toEqual({
      kind: 'program',
      name: 'creditLimitExceeded',
      message: "the loan would take the operator's debt over the attested credit limit",
    })
  })

  it('tells a moved rate apart, since the answer to it is a new quote', () => {
    const error = new Error('{"InstructionError":[2,{"Custom":6020}]}')

    expect(describeBorrowFailure(error)).toEqual({ kind: 'rate-moved' })
  })

  it('tells a refusal in the wallet apart from a failure', () => {
    const error = Object.assign(new Error('User rejected the request.'), {
      name: 'WalletSendTransactionError',
    })

    expect(describeBorrowFailure(error)).toEqual({ kind: 'rejected' })
  })

  it('names an error that came without a message by its kind', () => {
    const error = Object.assign(new Error(''), { name: 'WalletSendTransactionError' })

    expect(describeBorrowFailure(error)).toEqual({
      kind: 'unknown',
      message: 'WalletSendTransactionError',
    })
  })

  it('passes anything else through as it is', () => {
    expect(describeBorrowFailure(new Error('blockhash not found'))).toEqual({
      kind: 'unknown',
      message: 'blockhash not found',
    })
    expect(describeBorrowFailure('weird')).toEqual({ kind: 'unknown', message: 'weird' })
  })
})
