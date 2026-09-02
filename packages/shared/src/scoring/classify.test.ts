import { describe, expect, it } from 'vitest'
import { parseRewardNetworks } from '../schemas/network.ts'
import { solanaAddressSchema } from '../schemas/primitives.ts'
import { classifyTransfer, tokenTransferSchema } from './classify.ts'

const HONEY_MINT = 'B55r1aQEJhL8xba9ncHHrY7w2tsykbtewac2uYUmgLyP'
const HNT_MINT = 'Da5nJidcBhY7Ae6qCJTkJ3yDeGJkMjhURA5Ny9QEDTne'
const GRASS_MINT = 'G95USU96LZUv4MKKUUVfoG6oPbwrszovRykBYfQdBe3Q'
const HIVEMAPPER_DISTRIBUTOR = 'G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7'
const HELIUM_DISTRIBUTOR_ONE = 'GqzFuskZTGHjVWKFid1J45FfbWYWCikuHnjP1viPrUx'
const HELIUM_DISTRIBUTOR_TWO = '3mqvZ478SVFftqm6Pmh14SdUhUHuaG7KkKqaBDqNZADs'
const GRASS_DISTRIBUTOR = '2RZMt9LwzUzSUNfprdLSUF33gS2Y3EJL3jqN6g6a9oP1'
const OPERATOR = '61G2U72VLHjSsAvTArQwb2Wg7vaVkVoEzPN8sdgxBLde'
const STRANGER = '9axh44i2g6U3q4KZxG9ieH4Z8Khx4N8npn4hWotr8zeZ'
const ANOTHER_OPERATOR = 'DAfMe2NyHFfCgsqa2PgrUaVHouLKmkY7FRdNirhXavLz'
const SIGNATURE =
  'mHhyPe2Am14FUfW89ak1Hut2cALVwKTtK3iKxomPkpamC7B17HTknFAgoSwT7zpz3shFoXhugio8pjPb9eRS6Ca'

const hivemapper = {
  id: 'hivemapper',
  displayName: 'Hivemapper',
  token: { mint: HONEY_MINT, symbol: 'HONEY', decimals: 9 },
  distributors: [HIVEMAPPER_DISTRIBUTOR],
  payoutCadence: 'weekly',
}

const helium = {
  id: 'helium',
  displayName: 'Helium',
  token: { mint: HNT_MINT, symbol: 'HNT', decimals: 8 },
  distributors: [HELIUM_DISTRIBUTOR_ONE, HELIUM_DISTRIBUTOR_TWO],
  payoutCadence: 'daily',
}

const networks = parseRewardNetworks([hivemapper, helium])
const operator = solanaAddressSchema.parse(OPERATOR)

const transfer = (overrides: Record<string, unknown> = {}) =>
  tokenTransferSchema.parse({
    signature: SIGNATURE,
    source: HIVEMAPPER_DISTRIBUTOR,
    destination: OPERATOR,
    mint: HONEY_MINT,
    amount: '4090000000000',
    slot: 442_918_004,
    blockTime: 1_756_512_000,
    ...overrides,
  })

describe('tokenTransferSchema', () => {
  it('reads the shape an RPC returns', () => {
    const parsed = transfer()

    expect(parsed.amount).toBe(4_090_000_000_000n)
    expect(parsed.slot).toBe(442_918_004n)
    expect(parsed.blockTime.toISOString()).toBe('2025-08-30T00:00:00.000Z')
  })

  it('rejects a signature that is not a 64-byte base58 string', () => {
    expect(() => transfer({ signature: OPERATOR })).toThrow()
  })

  it('rejects a fractional amount: minimal units are whole', () => {
    expect(() => transfer({ amount: '4090.5' })).toThrow()
  })

  it('rejects an amount that arrived as a number', () => {
    expect(() => transfer({ amount: 4_090_000_000_000 })).toThrow()
  })

  it('rejects a transfer with no block time: it cannot be placed in a month', () => {
    expect(() => transfer({ blockTime: null })).toThrow()
  })
})

describe('classifyTransfer', () => {
  it('recognises a payout by its distributor', () => {
    const result = classifyTransfer(transfer(), operator, networks)

    expect(result).toEqual({
      kind: 'payout',
      payout: {
        signature: SIGNATURE,
        wallet: operator,
        networkId: 'hivemapper',
        distributor: HIVEMAPPER_DISTRIBUTOR,
        amount: 4_090_000_000_000n,
        slot: 442_918_004n,
        blockTime: new Date('2025-08-30T00:00:00.000Z'),
      },
    })
  })

  it('recognises a payout from the second distributor of the same network', () => {
    const result = classifyTransfer(
      transfer({ source: HELIUM_DISTRIBUTOR_TWO, mint: HNT_MINT }),
      operator,
      networks,
    )

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'payout',
        payout: expect.objectContaining({ networkId: 'helium' }),
      }),
    )
  })

  it('ignores the same token sent by anyone but a distributor', () => {
    expect(classifyTransfer(transfer({ source: STRANGER }), operator, networks)).toEqual({
      kind: 'ignored',
      reason: 'unknown-source',
    })
  })

  it('ignores a distributor sending a token that is not the reward of its network', () => {
    expect(classifyTransfer(transfer({ mint: HNT_MINT }), operator, networks)).toEqual({
      kind: 'ignored',
      reason: 'mint-mismatch',
    })
  })

  it('ignores a payout credited to somebody else', () => {
    expect(
      classifyTransfer(transfer({ destination: ANOTHER_OPERATOR }), operator, networks),
    ).toEqual({ kind: 'ignored', reason: 'not-to-operator' })
  })

  it('ignores the operator sending the token away', () => {
    expect(
      classifyTransfer(
        transfer({ source: OPERATOR, destination: HIVEMAPPER_DISTRIBUTOR }),
        operator,
        networks,
      ),
    ).toEqual({ kind: 'ignored', reason: 'not-to-operator' })
  })

  it('ignores a zero-amount transfer: it would count as a month with a payout', () => {
    expect(classifyTransfer(transfer({ amount: '0' }), operator, networks)).toEqual({
      kind: 'ignored',
      reason: 'zero-amount',
    })
  })

  it('recognises a third network added as data, with no code path of its own', () => {
    const grass = {
      id: 'grass',
      displayName: 'Grass',
      token: { mint: GRASS_MINT, symbol: 'GRASS', decimals: 9 },
      distributors: [GRASS_DISTRIBUTOR],
      payoutCadence: 'monthly',
    }

    const result = classifyTransfer(
      transfer({ source: GRASS_DISTRIBUTOR, mint: GRASS_MINT }),
      operator,
      parseRewardNetworks([hivemapper, helium, grass]),
    )

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'payout',
        payout: expect.objectContaining({ networkId: 'grass' }),
      }),
    )
  })
})
