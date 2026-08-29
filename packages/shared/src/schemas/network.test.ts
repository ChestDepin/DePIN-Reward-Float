import { describe, expect, it } from 'vitest'
import { parseRewardNetworks, rewardNetworkSchema } from './network.ts'

const MINT_A = '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy'
const MINT_B = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const DISTRIBUTOR_A = '11111111111111111111111111111111'
const DISTRIBUTOR_B = 'SysvarC1ock11111111111111111111111111111111'
const DISTRIBUTOR_C = 'Sysvar1nstructions1111111111111111111111111'
const DISTRIBUTOR_D = 'SysvarRent111111111111111111111111111111111'

const hivemapper = {
  id: 'hivemapper',
  displayName: 'Hivemapper',
  token: { mint: MINT_A, symbol: 'HONEY', decimals: 9 },
  distributors: [DISTRIBUTOR_A],
  payoutCadence: 'weekly',
}

const helium = {
  id: 'helium',
  displayName: 'Helium',
  token: { mint: MINT_B, symbol: 'HNT', decimals: 8 },
  distributors: [DISTRIBUTOR_B, DISTRIBUTOR_C],
  payoutCadence: 'daily',
}

describe('rewardNetworkSchema', () => {
  it('reads a network description', () => {
    const network = rewardNetworkSchema.parse(hivemapper)

    expect(network.id).toBe('hivemapper')
    expect(network.token.decimals).toBe(9)
    expect(network.distributors).toEqual([DISTRIBUTOR_A])
    expect(network.payoutCadence).toBe('weekly')
  })

  it('requires at least one distributor: without it no payout can be recognised', () => {
    expect(rewardNetworkSchema.safeParse({ ...hivemapper, distributors: [] }).success).toBe(false)
  })

  it('rejects a distributor that is not an address', () => {
    expect(
      rewardNetworkSchema.safeParse({ ...hivemapper, distributors: ['not-an-address'] }).success,
    ).toBe(false)
  })

  it('rejects the same distributor listed twice', () => {
    expect(
      rewardNetworkSchema.safeParse({
        ...hivemapper,
        distributors: [DISTRIBUTOR_A, DISTRIBUTOR_A],
      }).success,
    ).toBe(false)
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
      distributors: [DISTRIBUTOR_D],
    }

    expect(parseRewardNetworks([hivemapper, helium, grass]).size).toBe(3)
  })

  it('rejects two networks with the same id', () => {
    expect(() => parseRewardNetworks([hivemapper, { ...helium, id: 'hivemapper' }])).toThrow(
      /hivemapper/,
    )
  })

  it('rejects one distributor shared by two networks, which would make a payout ambiguous', () => {
    expect(() =>
      parseRewardNetworks([hivemapper, { ...helium, distributors: [DISTRIBUTOR_A] }]),
    ).toThrow(new RegExp(DISTRIBUTOR_A))
  })

  it('rejects an empty list: a build with no supported network is a misconfiguration', () => {
    expect(() => parseRewardNetworks([])).toThrow()
  })

  it('rejects anything that is not a list of descriptions', () => {
    expect(() => parseRewardNetworks({ hivemapper })).toThrow()
  })
})
