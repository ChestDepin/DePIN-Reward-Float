import type { RewardNetwork, SolanaAddress } from '@drf/shared/schemas'
import { solanaAddressSchema } from '@drf/shared/schemas'
import {
  classifyTransfer,
  type RecognisedPayout,
  type TokenTransfer,
  tokenTransferSchema,
} from '@drf/shared/scoring'
import { z } from 'zod'

const HISTORY_MONTHS = 12
const SIGNATURE_PAGE_SIZE = 1000

const signatureInfoSchema = z.object({
  signature: z.string(),
  slot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable(),
  err: z.unknown().optional(),
})

const signaturePageSchema = z.array(signatureInfoSchema)

const tokenBalanceSchema = z.object({
  mint: solanaAddressSchema,
  // Власника немає у відповідях старих вузлів. Без нього переказ нікому не
  // приписати, тож такий запис пропускається, а не здогадується.
  owner: solanaAddressSchema.optional(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
})

const transactionSchema = z.object({
  slot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable(),
  meta: z
    .object({
      err: z.unknown().optional(),
      preTokenBalances: z.array(tokenBalanceSchema).default([]),
      postTokenBalances: z.array(tokenBalanceSchema).default([]),
    })
    .nullable(),
})

export type SolanaRpc = {
  listSignatures(input: {
    address: SolanaAddress
    before: string | null
    limit: number
  }): Promise<unknown>
  getTransaction(signature: string): Promise<unknown>
}

export type IndexPayoutsInput = {
  wallet: SolanaAddress
  networks: ReadonlyMap<string, RewardNetwork>
  rpc: SolanaRpc
  now: Date
  pageSize?: number
  until?: string | null
}

function failed(err: unknown): boolean {
  return err !== null && err !== undefined
}

export function historyWindowStart(now: Date): Date {
  const start = new Date(now)
  start.setUTCMonth(start.getUTCMonth() - HISTORY_MONTHS)
  return start
}

type TokenBalance = z.infer<typeof tokenBalanceSchema>

function balanceDeltas(
  pre: readonly TokenBalance[],
  post: readonly TokenBalance[],
): Map<string, Map<string, bigint>> {
  const byMint = new Map<string, Map<string, bigint>>()

  const apply = (balances: readonly TokenBalance[], sign: bigint) => {
    for (const balance of balances) {
      if (balance.owner === undefined) continue
      const owners = byMint.get(balance.mint) ?? new Map<string, bigint>()
      const amount = BigInt(balance.uiTokenAmount.amount) * sign
      owners.set(balance.owner, (owners.get(balance.owner) ?? 0n) + amount)
      byMint.set(balance.mint, owners)
    }
  }

  apply(pre, -1n)
  apply(post, 1n)

  return byMint
}

export function readIncomingTransfers(
  raw: unknown,
  wallet: SolanaAddress,
  signature: string,
): TokenTransfer[] {
  const transaction = transactionSchema.parse(raw)

  if (transaction.meta === null || failed(transaction.meta.err)) return []
  if (transaction.blockTime === null) return []

  const deltas = balanceDeltas(
    transaction.meta.preTokenBalances,
    transaction.meta.postTokenBalances,
  )
  const transfers: TokenTransfer[] = []

  for (const [mint, owners] of deltas) {
    const received = owners.get(wallet) ?? 0n
    if (received <= 0n) continue

    const senders = [...owners].filter(([owner, delta]) => owner !== wallet && delta < 0n)

    // Двоє відправників того самого токена в одній транзакції роблять джерело
    // неоднозначним, а FR-002 розпізнає виплату саме за джерелом.
    const sender = senders.length === 1 ? senders[0] : undefined
    if (sender === undefined) continue

    transfers.push(
      tokenTransferSchema.parse({
        signature,
        source: sender[0],
        destination: wallet,
        mint,
        amount: received.toString(),
        slot: transaction.slot,
        blockTime: transaction.blockTime,
      }),
    )
  }

  return transfers
}

export async function indexPayouts({
  wallet,
  networks,
  rpc,
  now,
  pageSize = SIGNATURE_PAGE_SIZE,
  until = null,
}: IndexPayoutsInput): Promise<RecognisedPayout[]> {
  const windowStart = historyWindowStart(now).getTime()
  const payouts: RecognisedPayout[] = []
  let before: string | null = null

  for (;;) {
    const page = signaturePageSchema.parse(
      await rpc.listSignatures({ address: wallet, before, limit: pageSize }),
    )

    for (const info of page) {
      if (info.signature === until) return payouts
      if (info.blockTime === null) continue
      if (info.blockTime * 1000 < windowStart) return payouts
      if (failed(info.err)) continue

      const raw = await rpc.getTransaction(info.signature)
      // Вузол може не мати транзакції, яку щойно перелічив, — історію обрізають.
      // Пропущена виплата занижує ліміт, вигадана завищила б його.
      if (raw === null) continue

      for (const transfer of readIncomingTransfers(raw, wallet, info.signature)) {
        const classified = classifyTransfer(transfer, wallet, networks)
        if (classified.kind === 'payout') payouts.push(classified.payout)
      }
    }

    const last = page[page.length - 1]
    if (last === undefined || page.length < pageSize) return payouts
    before = last.signature
  }
}
