import type { RewardNetwork, SolanaAddress } from '@drf/shared/schemas'
import { z } from 'zod'
import { DataUnavailable } from './routes/errors.ts'
import type { RateQuote, RateSource } from './routes/rate.ts'

const PRICE_URL = 'https://api.jup.ag/price/v3'

// Jupiter prices the mainnet token; the program sees its devnet stand-in.
export type RateMint = { mint: SolanaAddress; decimals: number }

export function rateMints(
  rewardMints: ReadonlyMap<string, SolanaAddress>,
  networks: ReadonlyMap<string, RewardNetwork>,
): ReadonlyMap<SolanaAddress, RateMint> {
  const mints = new Map<SolanaAddress, RateMint>()
  for (const [networkId, standIn] of rewardMints) {
    const network = networks.get(networkId)
    if (network === undefined) {
      throw new Error(`REWARD_MINTS lists ${networkId}, which is not a supported network`)
    }
    mints.set(standIn, {
      mint: network.token.mint,
      decimals: network.token.decimals,
    })
  }
  return mints
}

const priceSchema = z.object({
  usdPrice: z.number().positive(),
  blockId: z.number().int().nonnegative(),
  decimals: z.number().int().nonnegative(),
})
const responseSchema = z.record(z.string(), priceSchema)

export function createJupiterRateSource(deps: {
  mints: ReadonlyMap<SolanaAddress, RateMint>
  apiKey: string
  get: (url: string, headers: Record<string, string>) => Promise<unknown>
  blockTime: (slot: number) => Promise<number | null>
  cacheMs: number
  clock: () => number
}): RateSource {
  const { mints, apiKey, get, blockTime, cacheMs, clock } = deps
  // Keyed by the promise, so callers that arrive together share one request.
  const cache = new Map<SolanaAddress, { at: number; quote: Promise<RateQuote | null> }>()

  async function fetchQuote({ mint, decimals }: RateMint): Promise<RateQuote | null> {
    let price: z.infer<typeof priceSchema> | undefined
    let time: number | null
    try {
      price = responseSchema.parse(await get(`${PRICE_URL}?ids=${mint}`, { 'x-api-key': apiKey }))[
        mint
      ]
      if (price === undefined) return null
      time = await blockTime(price.blockId)
    } catch (cause) {
      throw new DataUnavailable('the Jupiter price', { cause })
    }
    // Not unavailable data but a wrong network config: amounts would be off by powers of ten.
    if (price.decimals !== decimals) {
      throw new Error(`Jupiter gives ${mint} ${price.decimals} decimals, the config ${decimals}`)
    }
    if (time === null) return null
    return { usdPrice: price.usdPrice, decimals, pricedAt: new Date(time * 1000) }
  }

  return {
    supports: (rewardMint) => mints.has(rewardMint),
    quote(rewardMint) {
      const target = mints.get(rewardMint)
      if (target === undefined) return Promise.resolve(null)
      const cached = cache.get(rewardMint)
      if (cached !== undefined && clock() - cached.at < cacheMs) return cached.quote
      const quote = fetchQuote(target)
      cache.set(rewardMint, { at: clock(), quote })
      quote.catch(() => cache.delete(rewardMint))
      return quote
    },
  }
}

const blockTimeResponseSchema = z.union([
  z.object({ result: z.number().int().nullable() }),
  z.object({ error: z.object({ code: z.number() }) }),
])

export function createRpcBlockTime(
  post: (body: unknown) => Promise<unknown>,
): (slot: number) => Promise<number | null> {
  return async (slot) => {
    const response = blockTimeResponseSchema.parse(
      await post({ jsonrpc: '2.0', id: 1, method: 'getBlockTime', params: [slot] }),
    )
    // A skipped slot or one the node no longer keeps has no time, and then no price age.
    return 'result' in response ? response.result : null
  }
}
