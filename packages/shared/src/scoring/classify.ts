import { base58 } from '@scure/base'
import { z } from 'zod'
import type { RewardNetwork } from '../schemas/network.ts'
import {
  baseUnitsSchema,
  blockTimeSchema,
  type SolanaAddress,
  solanaAddressSchema,
} from '../schemas/primitives.ts'

const SIGNATURE_BYTES = 64

const transactionSignatureSchema = z.string().refine((value) => {
  try {
    return base58.decode(value).length === SIGNATURE_BYTES
  } catch {
    return false
  }
}, 'not a base58-encoded 64-byte signature')

// `source` і `destination` — власники токен-акаунтів, а не самі акаунти: адреса
// токен-акаунта ніколи не дорівнює гаманцю оператора, тож виплата йому
// виглядала б переказом до третьої сторони.
export const tokenTransferSchema = z.object({
  signature: transactionSignatureSchema,
  source: solanaAddressSchema,
  destination: solanaAddressSchema,
  mint: solanaAddressSchema,
  amount: baseUnitsSchema,
  slot: z.union([z.bigint(), z.number().int().nonnegative()]).transform((value) => BigInt(value)),
  blockTime: blockTimeSchema,
})

export type TokenTransfer = z.infer<typeof tokenTransferSchema>

export type RecognisedPayout = {
  signature: string
  wallet: SolanaAddress
  networkId: string
  distributor: SolanaAddress
  amount: bigint
  slot: bigint
  blockTime: Date
}

export type IgnoredReason = 'not-to-operator' | 'unknown-source' | 'mint-mismatch' | 'zero-amount'

export type TransferClassification =
  | { kind: 'payout'; payout: RecognisedPayout }
  | { kind: 'ignored'; reason: IgnoredReason }

function findNetworkByDistributor(
  distributor: SolanaAddress,
  networks: ReadonlyMap<string, RewardNetwork>,
): RewardNetwork | undefined {
  for (const network of networks.values()) {
    if (network.distributors.includes(distributor)) return network
  }
  return undefined
}

export function classifyTransfer(
  transfer: TokenTransfer,
  operator: SolanaAddress,
  networks: ReadonlyMap<string, RewardNetwork>,
): TransferClassification {
  if (transfer.destination !== operator) return { kind: 'ignored', reason: 'not-to-operator' }

  const network = findNetworkByDistributor(transfer.source, networks)
  if (network === undefined) return { kind: 'ignored', reason: 'unknown-source' }

  if (transfer.mint !== network.token.mint) return { kind: 'ignored', reason: 'mint-mismatch' }

  // Нульовий переказ від розподільника виплатою не є: інакше місяць порахується
  // як «з виплатою» і підніме стабільність у скорингу.
  if (transfer.amount === 0n) return { kind: 'ignored', reason: 'zero-amount' }

  return {
    kind: 'payout',
    payout: {
      signature: transfer.signature,
      wallet: operator,
      networkId: network.id,
      distributor: transfer.source,
      amount: transfer.amount,
      slot: transfer.slot,
      blockTime: transfer.blockTime,
    },
  }
}
