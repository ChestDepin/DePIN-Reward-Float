import { rewardNetworkSchema, solanaAddressSchema } from '@drf/shared/schemas'
import { describe, expect, it } from 'vitest'
import { createJupiterRateSource, createRpcBlockTime, rateMints } from './jupiter.ts'
import { DataUnavailable } from './routes/errors.ts'

const MAINNET_HONEY = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')
const MAINNET_HNT = solanaAddressSchema.parse('hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux')
const DEVNET_HONEY = solanaAddressSchema.parse('5pbCV2sjzLPiYoY48ic1kmS5juTpjeN27ProW6v3QFS')
const DEVNET_HNT = solanaAddressSchema.parse('Hvfc8s2Z7EU3dcY4LDNHbkHrJ7EgDg5iaFnLzaUdALYh')

const NETWORKS = new Map(
  [
    { id: 'hivemapper', mint: MAINNET_HONEY, symbol: 'HONEY', decimals: 9 },
    { id: 'helium', mint: MAINNET_HNT, symbol: 'HNT', decimals: 8 },
  ].map(({ id, mint, symbol, decimals }) => [
    id,
    rewardNetworkSchema.parse({
      id,
      displayName: symbol,
      token: { mint, symbol, decimals },
      payoutSources: [{ kind: 'mint', address: mint }],
      payoutCadence: 'weekly',
    }),
  ]),
)

// api.jup.ag/price/v3 for both tokens, recorded 2026-10-06.
const JUPITER_RESPONSE = {
  [MAINNET_HONEY]: {
    createdAt: '2024-06-07T10:15:02.516Z',
    liquidity: 23201.008677599773,
    usdPrice: 0.0023922837836002826,
    blockId: 453872967,
    decimals: 9,
    priceChange24h: -4.085873423296767,
  },
  [MAINNET_HNT]: {
    createdAt: '2024-06-07T10:15:02.516Z',
    liquidity: 308470.29205238447,
    usdPrice: 0.5121938205874286,
    blockId: 453872202,
    decimals: 8,
    priceChange24h: -6.625703897082989,
  },
}

const BLOCK_TIME = 1_791_288_000

describe('rateMints', () => {
  it('ties each devnet stand-in to the mainnet token that is priced for it', () => {
    const mints = rateMints(
      new Map([
        ['hivemapper', DEVNET_HONEY],
        ['helium', DEVNET_HNT],
      ]),
      NETWORKS,
    )

    expect(mints.get(DEVNET_HONEY)).toEqual({ mint: MAINNET_HONEY, decimals: 9 })
    expect(mints.get(DEVNET_HNT)).toEqual({ mint: MAINNET_HNT, decimals: 8 })
  })

  it('refuses a stand-in for a network the product does not support', () => {
    expect(() => rateMints(new Map([['render', DEVNET_HONEY]]), NETWORKS)).toThrow(/render/)
  })
})

function harness(input: { response?: unknown; blockTime?: number | null; fail?: Error } = {}) {
  const requests: { url: string; headers: Record<string, string> }[] = []
  let clock = 0
  const rates = createJupiterRateSource({
    mints: new Map([
      [DEVNET_HONEY, { mint: MAINNET_HONEY, decimals: 9 }],
      [DEVNET_HNT, { mint: MAINNET_HNT, decimals: 8 }],
    ]),
    apiKey: 'test-key',
    async get(url, headers) {
      requests.push({ url, headers })
      if (input.fail !== undefined) throw input.fail
      return input.response ?? JUPITER_RESPONSE
    },
    blockTime: async () => (input.blockTime === undefined ? BLOCK_TIME : input.blockTime),
    cacheMs: 15_000,
    clock: () => clock,
  })
  return { rates, requests, advance: (ms: number) => (clock += ms) }
}

describe('createJupiterRateSource', () => {
  it('prices the mainnet token and dates it by its block', async () => {
    const { rates, requests } = harness()

    expect(await rates.quote(DEVNET_HONEY)).toEqual({
      usdPrice: 0.0023922837836002826,
      decimals: 9,
      pricedAt: new Date(BLOCK_TIME * 1000),
    })
    expect(requests).toEqual([
      {
        url: `https://api.jup.ag/price/v3?ids=${MAINNET_HONEY}`,
        headers: { 'x-api-key': 'test-key' },
      },
    ])
  })

  it('knows only the configured stand-ins', () => {
    const { rates } = harness()

    expect(rates.supports(DEVNET_HNT)).toBe(true)
    expect(rates.supports(MAINNET_HONEY)).toBe(false)
  })

  // The endpoint is public: without this, every caller would be a request against the
  // key's 60 a minute.
  it('asks Jupiter at most once per mint while a price is fresh enough to reuse', async () => {
    const { rates, requests, advance } = harness()

    await Promise.all([rates.quote(DEVNET_HONEY), rates.quote(DEVNET_HONEY)])
    advance(14_999)
    await rates.quote(DEVNET_HONEY)
    expect(requests).toHaveLength(1)

    advance(1)
    await rates.quote(DEVNET_HONEY)
    expect(requests).toHaveLength(2)
  })

  it('has no price when Jupiter does not list the token', async () => {
    const { rates } = harness({ response: {} })

    expect(await rates.quote(DEVNET_HONEY)).toBeNull()
  })

  it('has no price when the block of the price has no known time', async () => {
    const { rates } = harness({ blockTime: null })

    expect(await rates.quote(DEVNET_HONEY)).toBeNull()
  })

  it('refuses a token whose decimals disagree with the network config', async () => {
    const { rates } = harness({
      response: { [MAINNET_HONEY]: { ...JUPITER_RESPONSE[MAINNET_HONEY], decimals: 6 } },
    })

    await expect(rates.quote(DEVNET_HONEY)).rejects.toThrow(/decimals/)
  })

  it('reports an unreachable Jupiter as unavailable data and asks again next time', async () => {
    const { rates, requests } = harness({ fail: new Error('ECONNRESET') })

    await expect(rates.quote(DEVNET_HONEY)).rejects.toBeInstanceOf(DataUnavailable)
    await expect(rates.quote(DEVNET_HONEY)).rejects.toBeInstanceOf(DataUnavailable)
    expect(requests).toHaveLength(2)
  })

  it('reports a malformed answer as unavailable data', async () => {
    const { rates } = harness({ response: { [MAINNET_HONEY]: { usdPrice: 'cheap' } } })

    await expect(rates.quote(DEVNET_HONEY)).rejects.toBeInstanceOf(DataUnavailable)
  })
})

describe('createRpcBlockTime', () => {
  it('asks the mainnet RPC for the time of a slot', async () => {
    const calls: unknown[] = []
    const blockTime = createRpcBlockTime(async (body) => {
      calls.push(body)
      return { jsonrpc: '2.0', id: 1, result: BLOCK_TIME }
    })

    expect(await blockTime(453872967)).toBe(BLOCK_TIME)
    expect(calls).toEqual([{ jsonrpc: '2.0', id: 1, method: 'getBlockTime', params: [453872967] }])
  })

  it('has no time for a skipped or unknown slot', async () => {
    const blockTime = createRpcBlockTime(async () => ({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32009, message: 'Slot 453872967 was skipped' },
    }))

    expect(await blockTime(453872967)).toBeNull()
  })
})
