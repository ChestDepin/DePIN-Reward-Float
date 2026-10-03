import { rewardFloatIdl } from '@drf/anchor-client'
import type { NetworkCreditLimit } from '@drf/shared/api'
import { type LoanCost, loanCost, type PoolTerms, quoteAprBps } from '@drf/shared/loan'
import type { PublicKey } from '@solana/web3.js'

// The limit the api attests is in base units of the stablecoin, and so is everything
// the program lends; USDC has six decimals, the same as the api's micro-dollars.
export const STABLE_DECIMALS = 6

const amountPattern = new RegExp(`^(\\d+)(?:\\.(\\d{1,${STABLE_DECIMALS}}))?$`)

export function parseStableAmount(text: string): bigint | null {
  const match = amountPattern.exec(text.trim().replaceAll(',', ''))
  if (match === null) return null
  const [, whole = '', fraction = ''] = match
  const units = BigInt(whole + fraction.padEnd(STABLE_DECIMALS, '0'))
  return units > 0n ? units : null
}

// The api signs one limit per wallet, the sum over the networks that have one (FR-012).
export function attestedLimit(networks: readonly NetworkCreditLimit[]): bigint {
  return networks.reduce(
    (sum, network) => (network.limitUsd === null ? sum : sum + BigInt(network.limitUsd)),
    0n,
  )
}

export type NetworkOption = {
  networkId: string
  displayName: string
  limitUsd: bigint
  rewardMint: PublicKey | null
  unavailable: 'no-limit' | 'no-devnet-mint' | null
}

export function borrowableNetworks(
  networks: readonly NetworkCreditLimit[],
  rewardMints: ReadonlyMap<string, PublicKey>,
): NetworkOption[] {
  const options = networks.map((network): NetworkOption => {
    const rewardMint = rewardMints.get(network.networkId) ?? null
    return {
      networkId: network.networkId,
      displayName: network.displayName,
      limitUsd: network.limitUsd === null ? 0n : BigInt(network.limitUsd),
      rewardMint,
      unavailable:
        network.limitUsd === null ? 'no-limit' : rewardMint === null ? 'no-devnet-mint' : null,
    }
  })
  const rank = (option: NetworkOption) => (option.unavailable === null ? 0 : 1)
  return options.sort(
    (a, b) => rank(a) - rank(b) || (b.limitUsd > a.limitUsd ? 1 : b.limitUsd < a.limitUsd ? -1 : 0),
  )
}

export type QuoteView =
  | { kind: 'enter-amount' }
  | { kind: 'over-limit'; available: bigint }
  | { kind: 'insufficient-liquidity'; free: bigint }
  | { kind: 'quote'; aprBps: number; cost: LoanCost }

// `debt` is the debt the operator account last booked; interest accrued since then is
// not in it, so at the very edge of the limit the program may still refuse. It, not
// this page, decides (FR-012).
export function quoteLoan(input: {
  amount: bigint | null
  termPeriods: number
  limit: bigint
  debt: bigint
  pool: PoolTerms
}): QuoteView {
  if (input.amount === null) return { kind: 'enter-amount' }
  const available = input.limit > input.debt ? input.limit - input.debt : 0n
  if (input.amount > available) return { kind: 'over-limit', available }
  const quote = quoteAprBps(input.pool, input.amount)
  if (!quote.ok) {
    const free = input.pool.totalDeposits - input.pool.totalBorrowed
    return { kind: 'insufficient-liquidity', free: free > 0n ? free : 0n }
  }
  return {
    kind: 'quote',
    aprBps: quote.aprBps,
    cost: loanCost({
      principal: input.amount,
      aprBps: quote.aprBps,
      termPeriods: input.termPeriods,
    }),
  }
}

export type BorrowFailure =
  | { kind: 'rejected' }
  | { kind: 'rate-moved' }
  | { kind: 'program'; name: string; message: string }
  | { kind: 'unknown'; message: string }

const RATE_ABOVE_MAXIMUM = 'rateAboveMaximum'

function programErrorCode(text: string): number | null {
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text)
  if (hex?.[1] !== undefined) return Number.parseInt(hex[1], 16)
  const custom = /"Custom":\s*(\d+)/.exec(text)
  return custom?.[1] === undefined ? null : Number(custom[1])
}

// A failed borrow reaches the page as whatever the wallet or the RPC node made of it:
// simulation logs, a confirmation error with the instruction error inside, or the
// wallet's own refusal. All the page needs is which of these it was.
export function describeBorrowFailure(error: unknown): BorrowFailure {
  if (!(error instanceof Error)) return { kind: 'unknown', message: String(error) }
  if (/user rejected/i.test(error.message)) return { kind: 'rejected' }
  const logs: unknown = Reflect.get(error, 'logs')
  const text = [error.message, ...(Array.isArray(logs) ? logs.map(String) : [])].join('\n')
  const code = programErrorCode(text)
  const known = rewardFloatIdl.errors.find((entry) => entry.code === code)
  // Wallet adapters throw some of their errors with no message at all.
  if (known === undefined) return { kind: 'unknown', message: error.message || error.name }
  if (known.name === RATE_ABOVE_MAXIMUM) return { kind: 'rate-moved' }
  return { kind: 'program', name: known.name, message: known.msg }
}
