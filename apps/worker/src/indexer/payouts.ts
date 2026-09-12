import type { PayoutSourceKind, RewardNetwork, SolanaAddress } from '@drf/shared/schemas'
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

// Емісія не рухає жодного балансу вниз, тож джерело в неї читається тільки з
// інструкції. `parsed` — це те, що видав парсер конкретної програми, і об'єктом
// воно буває не завжди: memo кладе туди голий рядок. Тому форма звіряється там,
// де читається, а не тут.
const instructionSchema = z.object({ parsed: z.unknown().optional() })

const MINT_INSTRUCTION_TYPES = ['mintTo', 'mintToChecked'] as const

const mintInstructionSchema = z.object({
  type: z.enum(MINT_INSTRUCTION_TYPES),
  // `looseObject`, бо авторитет читається наступною схемою з того самого
  // об'єкта: звичайний `object` зрізав би його ще до перевірки.
  info: z.looseObject({ mint: solanaAddressSchema }),
})

const mintAuthoritySchema = z.object({ mintAuthority: solanaAddressSchema })

const transactionSchema = z.object({
  slot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable(),
  transaction: z
    .object({ message: z.object({ instructions: z.array(instructionSchema).default([]) }) })
    .optional(),
  meta: z
    .object({
      err: z.unknown().optional(),
      preTokenBalances: z.array(tokenBalanceSchema).default([]),
      postTokenBalances: z.array(tokenBalanceSchema).default([]),
      innerInstructions: z
        .array(z.object({ instructions: z.array(instructionSchema).default([]) }))
        .default([]),
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

type Instruction = z.infer<typeof instructionSchema>

// Авторитет один на всю виплату, але інструкцій може бути кілька: Hivemapper
// карбує окремо частку водія і частку фліт-менеджера. Тому саме множина
// авторитетів, а не список карбувань.
function mintsOf(
  instructions: readonly Instruction[],
  mint: string,
): { authorities: SolanaAddress[]; unattributed: boolean } {
  const authorities = new Set<SolanaAddress>()
  let unattributed = false

  for (const instruction of instructions) {
    const parsed = mintInstructionSchema.safeParse(instruction.parsed)
    if (!parsed.success || parsed.data.info.mint !== mint) continue

    // Карбування є, а авторитета вузол не назвав — багатопідписний мінт віддає
    // інше поле. Приписати таке надходження нікому, і мовчазна здогадка тут
    // коштувала б завищеного ліміту.
    const authority = mintAuthoritySchema.safeParse(parsed.data.info)
    if (authority.success) authorities.add(authority.data.mintAuthority)
    else unattributed = true
  }

  return { authorities: [...authorities], unattributed }
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
  const instructions = [
    ...(transaction.transaction?.message.instructions ?? []),
    ...transaction.meta.innerInstructions.flatMap((inner) => inner.instructions),
  ]
  const transfers: TokenTransfer[] = []

  for (const [mint, owners] of deltas) {
    const received = owners.get(wallet) ?? 0n
    if (received <= 0n) continue

    const mints = mintsOf(instructions, mint)
    if (mints.unattributed) continue

    // Джерело тут ще рядок з відповіді вузла: брендованою адресою воно стає
    // на `tokenTransferSchema.parse`, як і решта полів.
    const candidates: { via: PayoutSourceKind; source: string }[] = [
      ...[...owners]
        .filter(([owner, delta]) => owner !== wallet && delta < 0n)
        .map(([owner]) => ({ via: 'transfer' as const, source: owner })),
      ...mints.authorities.map((source) => ({ via: 'mint' as const, source })),
    ]

    // Два джерела того самого токена в одній транзакції роблять надходження
    // неоднозначним, а FR-002 розпізнає виплату саме за джерелом. Переказ
    // разом із емісією — такий самий випадок, як двоє відправників.
    const only = candidates.length === 1 ? candidates[0] : undefined
    if (only === undefined) continue

    transfers.push(
      tokenTransferSchema.parse({
        signature,
        via: only.via,
        source: only.source,
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
