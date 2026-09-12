import { describe, expect, it } from 'vitest'
import { parseRewardNetworks, rewardNetworkSchema } from './network.ts'

const MINT_A = '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy'
const MINT_B = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const SOURCE_A = '11111111111111111111111111111111'
const SOURCE_B = 'SysvarC1ock11111111111111111111111111111111'
const SOURCE_C = 'Sysvar1nstructions1111111111111111111111111'
const SOURCE_D = 'SysvarRent111111111111111111111111111111111'

const hivemapper = {
  id: 'hivemapper',
  displayName: 'Hivemapper',
  token: { mint: MINT_A, symbol: 'HONEY', decimals: 9 },
  payoutSources: [{ kind: 'mint', address: SOURCE_A }],
  payoutCadence: 'weekly',
}

const helium = {
  id: 'helium',
  displayName: 'Helium',
  token: { mint: MINT_B, symbol: 'HNT', decimals: 8 },
  payoutSources: [
    { kind: 'transfer', address: SOURCE_B },
    { kind: 'transfer', address: SOURCE_C },
  ],
  payoutCadence: 'daily',
}

describe('rewardNetworkSchema', () => {
  it('reads a network description', () => {
    const network = rewardNetworkSchema.parse(hivemapper)

    expect(network.id).toBe('hivemapper')
    expect(network.token.decimals).toBe(9)
    expect(network.payoutSources).toEqual([{ kind: 'mint', address: SOURCE_A }])
    expect(network.payoutCadence).toBe('weekly')
  })

  it('reads both ways a reward can arrive: a transfer and an emission', () => {
    const network = rewardNetworkSchema.parse({
      ...hivemapper,
      payoutSources: [
        { kind: 'transfer', address: SOURCE_B },
        { kind: 'mint', address: SOURCE_A },
      ],
    })

    expect(network.payoutSources.map((source) => source.kind)).toEqual(['transfer', 'mint'])
  })

  it('requires at least one source: without it no payout can be recognised', () => {
    expect(rewardNetworkSchema.safeParse({ ...hivemapper, payoutSources: [] }).success).toBe(false)
  })

  it('rejects a source that is not an address', () => {
    expect(
      rewardNetworkSchema.safeParse({
        ...hivemapper,
        payoutSources: [{ kind: 'mint', address: 'not-an-address' }],
      }).success,
    ).toBe(false)
  })

  it('rejects a way of arriving that the classifier cannot check', () => {
    expect(
      rewardNetworkSchema.safeParse({
        ...hivemapper,
        payoutSources: [{ kind: 'burn', address: SOURCE_A }],
      }).success,
    ).toBe(false)
  })

  it('rejects a bare address where a source is expected', () => {
    expect(
      rewardNetworkSchema.safeParse({ ...hivemapper, payoutSources: [SOURCE_A] }).success,
    ).toBe(false)
  })

  it('rejects the same source listed twice', () => {
    expect(
      rewardNetworkSchema.safeParse({
        ...hivemapper,
        payoutSources: [
          { kind: 'mint', address: SOURCE_A },
          { kind: 'mint', address: SOURCE_A },
        ],
      }).success,
    ).toBe(false)
  })

  // Дублікатом є пара, а не адреса: той самий ключ може і переказувати токен,
  // і бути авторитетом емісії, і ці два надходження розрізняються способом.
  it('takes one address arriving two ways as two sources, not a duplicate', () => {
    expect(
      rewardNetworkSchema.safeParse({
        ...hivemapper,
        payoutSources: [
          { kind: 'mint', address: SOURCE_A },
          { kind: 'transfer', address: SOURCE_A },
        ],
      }).success,
    ).toBe(true)
  })

  it('rejects an unknown payout cadence', () => {
    expect(rewardNetworkSchema.safeParse({ ...hivemapper, payoutCadence: 'often' }).success).toBe(
      false,
    )
  })

  it('rejects an id that is not a slug', () => {
    expect(rewardNetworkSchema.safeParse({ ...hivemapper, id: 'Hivemapper Inc' }).success).toBe(
      false,
    )
  })

  it('rejects decimals outside what a mint can hold', () => {
    expect(
      rewardNetworkSchema.safeParse({
        ...hivemapper,
        token: { ...hivemapper.token, decimals: 19 },
      }).success,
    ).toBe(false)
  })
})

describe('parseRewardNetworks', () => {
  it('keys the supported networks by id', () => {
    const networks = parseRewardNetworks([hivemapper, helium])

    expect([...networks.keys()]).toEqual(['hivemapper', 'helium'])
    expect(networks.get('helium')?.token.symbol).toBe('HNT')
  })

  it('adds a network without touching any code path', () => {
    const grass = {
      ...hivemapper,
      id: 'grass',
      displayName: 'Grass',
      payoutSources: [{ kind: 'transfer', address: SOURCE_D }],
    }

    expect(parseRewardNetworks([hivemapper, helium, grass]).size).toBe(3)
  })

  it('rejects two networks with the same id', () => {
    expect(() => parseRewardNetworks([hivemapper, { ...helium, id: 'hivemapper' }])).toThrow(
      /hivemapper/,
    )
  })

  it('rejects one source shared by two networks, which would make a payout ambiguous', () => {
    expect(() =>
      parseRewardNetworks([
        hivemapper,
        { ...helium, payoutSources: [{ kind: 'mint', address: SOURCE_A }] },
      ]),
    ).toThrow(new RegExp(SOURCE_A))
  })

  // Та сама адреса під різними видами двозначності не створює: класифікатор
  // звіряє пару, тож надходження однаково впізнається однією мережею.
  it('allows two networks to name one address if it reaches them differently', () => {
    expect(
      parseRewardNetworks([
        hivemapper,
        { ...helium, payoutSources: [{ kind: 'transfer', address: SOURCE_A }] },
      ]).size,
    ).toBe(2)
  })

  it('rejects an empty list: a build with no supported network is a misconfiguration', () => {
    expect(() => parseRewardNetworks([])).toThrow()
  })

  it('rejects anything that is not a list of descriptions', () => {
    expect(() => parseRewardNetworks({ hivemapper })).toThrow()
  })
})
