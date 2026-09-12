import { describe, expect, it } from 'vitest'
import { parseRewardNetworks } from '../schemas/network.ts'
import { solanaAddressSchema } from '../schemas/primitives.ts'
import { classifyTransfer, tokenTransferSchema } from './classify.ts'

const HONEY_MINT = 'B55r1aQEJhL8xba9ncHHrY7w2tsykbtewac2uYUmgLyP'
const HNT_MINT = 'Da5nJidcBhY7Ae6qCJTkJ3yDeGJkMjhURA5Ny9QEDTne'
const GRASS_MINT = 'G95USU96LZUv4MKKUUVfoG6oPbwrszovRykBYfQdBe3Q'
const HIVEMAPPER_AUTHORITY = 'G55iQCAVJt13mvYADJcqUddM3cpXEx5i94L54R6VgUz7'
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
  payoutSources: [{ kind: 'mint', address: HIVEMAPPER_AUTHORITY }],
  payoutCadence: 'weekly',
}

const helium = {
  id: 'helium',
  displayName: 'Helium',
  token: { mint: HNT_MINT, symbol: 'HNT', decimals: 8 },
  payoutSources: [
    { kind: 'transfer', address: HELIUM_DISTRIBUTOR_ONE },
    { kind: 'transfer', address: HELIUM_DISTRIBUTOR_TWO },
  ],
  payoutCadence: 'daily',
}

const networks = parseRewardNetworks([hivemapper, helium])
const operator = solanaAddressSchema.parse(OPERATOR)

// Типове надходження — емісія Hivemapper: у неї немає відправника, і саме вона
// не розпізнавалася до T023c.
const incoming = (overrides: Record<string, unknown> = {}) =>
  tokenTransferSchema.parse({
    signature: SIGNATURE,
    via: 'mint',
    source: HIVEMAPPER_AUTHORITY,
    destination: OPERATOR,
    mint: HONEY_MINT,
    amount: '4090000000000',
    slot: 442_918_004,
    blockTime: 1_756_512_000,
    ...overrides,
  })

const heliumTransfer = (overrides: Record<string, unknown> = {}) =>
  incoming({ via: 'transfer', source: HELIUM_DISTRIBUTOR_ONE, mint: HNT_MINT, ...overrides })

describe('tokenTransferSchema', () => {
  it('reads the shape an RPC returns', () => {
    const parsed = incoming()

    expect(parsed.amount).toBe(4_090_000_000_000n)
    expect(parsed.slot).toBe(442_918_004n)
    expect(parsed.blockTime.toISOString()).toBe('2025-08-30T00:00:00.000Z')
    expect(parsed.via).toBe('mint')
  })

  it('rejects a signature that is not a 64-byte base58 string', () => {
    expect(() => incoming({ signature: OPERATOR })).toThrow()
  })

  it('rejects a fractional amount: minimal units are whole', () => {
    expect(() => incoming({ amount: '4090.5' })).toThrow()
  })

  it('rejects an amount that arrived as a number', () => {
    expect(() => incoming({ amount: 4_090_000_000_000 })).toThrow()
  })

  it('rejects a transfer with no block time: it cannot be placed in a month', () => {
    expect(() => incoming({ blockTime: null })).toThrow()
  })

  it('rejects a way of arriving that no network can name', () => {
    expect(() => incoming({ via: 'burn' })).toThrow()
  })

  it('rejects a transfer that does not say how it arrived', () => {
    expect(() => incoming({ via: undefined })).toThrow()
  })
})

describe('classifyTransfer', () => {
  it('recognises a payout minted by the authority of its network', () => {
    const result = classifyTransfer(incoming(), operator, networks)

    expect(result).toEqual({
      kind: 'payout',
      payout: {
        signature: SIGNATURE,
        wallet: operator,
        networkId: 'hivemapper',
        source: HIVEMAPPER_AUTHORITY,
        amount: 4_090_000_000_000n,
        slot: 442_918_004n,
        blockTime: new Date('2025-08-30T00:00:00.000Z'),
      },
    })
  })

  it('recognises a payout transferred by a distributor', () => {
    expect(classifyTransfer(heliumTransfer(), operator, networks)).toEqual(
      expect.objectContaining({
        kind: 'payout',
        payout: expect.objectContaining({ networkId: 'helium', source: HELIUM_DISTRIBUTOR_ONE }),
      }),
    )
  })

  it('recognises a payout from the second distributor of the same network', () => {
    expect(
      classifyTransfer(heliumTransfer({ source: HELIUM_DISTRIBUTOR_TWO }), operator, networks),
    ).toEqual(
      expect.objectContaining({
        kind: 'payout',
        payout: expect.objectContaining({ networkId: 'helium' }),
      }),
    )
  })

  // Пара, а не адреса: інакше розподільник, чий ключ хтось зробив авторитетом
  // мінта, почав би карбувати собі впізнані виплати.
  it('ignores an emission by an address the network named as a transfer source', () => {
    expect(classifyTransfer(heliumTransfer({ via: 'mint' }), operator, networks)).toEqual({
      kind: 'ignored',
      reason: 'unknown-source',
    })
  })

  it('ignores a transfer from an address the network named as a mint authority', () => {
    expect(classifyTransfer(incoming({ via: 'transfer' }), operator, networks)).toEqual({
      kind: 'ignored',
      reason: 'unknown-source',
    })
  })

  it('ignores the same token sent by anyone but a known source', () => {
    expect(classifyTransfer(incoming({ source: STRANGER }), operator, networks)).toEqual({
      kind: 'ignored',
      reason: 'unknown-source',
    })
  })

  it('ignores a known source sending a token that is not the reward of its network', () => {
    expect(classifyTransfer(incoming({ mint: HNT_MINT }), operator, networks)).toEqual({
      kind: 'ignored',
      reason: 'mint-mismatch',
    })
  })

  it('ignores a payout credited to somebody else', () => {
    expect(
      classifyTransfer(incoming({ destination: ANOTHER_OPERATOR }), operator, networks),
    ).toEqual({ kind: 'ignored', reason: 'not-to-operator' })
  })

  it('ignores the operator sending the token away', () => {
    expect(
      classifyTransfer(
        incoming({ via: 'transfer', source: OPERATOR, destination: HIVEMAPPER_AUTHORITY }),
        operator,
        networks,
      ),
    ).toEqual({ kind: 'ignored', reason: 'not-to-operator' })
  })

  it('ignores a zero-amount transfer: it would count as a month with a payout', () => {
    expect(classifyTransfer(incoming({ amount: '0' }), operator, networks)).toEqual({
      kind: 'ignored',
      reason: 'zero-amount',
    })
  })

  it('recognises a third network added as data, with no code path of its own', () => {
    const grass = {
      id: 'grass',
      displayName: 'Grass',
      token: { mint: GRASS_MINT, symbol: 'GRASS', decimals: 9 },
      payoutSources: [{ kind: 'transfer', address: GRASS_DISTRIBUTOR }],
      payoutCadence: 'monthly',
    }

    const result = classifyTransfer(
      incoming({ via: 'transfer', source: GRASS_DISTRIBUTOR, mint: GRASS_MINT }),
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
