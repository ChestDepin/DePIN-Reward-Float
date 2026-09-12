import { base58 } from '@scure/base'
import { z } from 'zod'
import {
  PAYOUT_SOURCE_KINDS,
  type PayoutSourceKind,
  payoutSourceKey,
  type RewardNetwork,
} from '../schemas/network.ts'
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
// виглядала б переказом до третьої сторони. У емісії відправника немає взагалі,
// і `source` там — авторитет мінта; `via` каже, що саме з двох перед нами.
export const tokenTransferSchema = z.object({
  signature: transactionSignatureSchema,
  via: z.enum(PAYOUT_SOURCE_KINDS),
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
  source: SolanaAddress
  amount: bigint
  slot: bigint
  blockTime: Date
}

export type IgnoredReason = 'not-to-operator' | 'unknown-source' | 'mint-mismatch' | 'zero-amount'

export type TransferClassification =
  | { kind: 'payout'; payout: RecognisedPayout }
  | { kind: 'ignored'; reason: IgnoredReason }

function findNetworkBySource(
  via: PayoutSourceKind,
  address: SolanaAddress,
  networks: ReadonlyMap<string, RewardNetwork>,
): RewardNetwork | undefined {
  const wanted = payoutSourceKey({ kind: via, address })

  for (const network of networks.values()) {
    if (network.payoutSources.some((source) => payoutSourceKey(source) === wanted)) return network
  }
  return undefined
}

export function classifyTransfer(
  transfer: TokenTransfer,
  operator: SolanaAddress,
  networks: ReadonlyMap<string, RewardNetwork>,
): TransferClassification {
  if (transfer.destination !== operator) return { kind: 'ignored', reason: 'not-to-operator' }

  // Звіряється пара, а не адреса: емісія від адреси, записаної як розподільник
  // переказів, виплатою не є — інакше чужий ключ, що став авторитетом мінта,
  // карбував би собі впізнану історію.
  const network = findNetworkBySource(transfer.via, transfer.source, networks)
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
      source: transfer.source,
      amount: transfer.amount,
      slot: transfer.slot,
      blockTime: transfer.blockTime,
    },
  }
}
