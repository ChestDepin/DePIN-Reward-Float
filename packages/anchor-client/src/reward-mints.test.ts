import { Keypair, type PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { formatRewardMints, rewardMintsSchema } from './reward-mints.ts'

function key(seed: number): PublicKey {
  return Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey
}

describe('reward mints', () => {
  it('reads one mint per network and tolerates spaces and an empty list', () => {
    const mints = rewardMintsSchema.parse(
      `hivemapper:${key(1).toBase58()}, helium:${key(2).toBase58()}`,
    )

    expect([...mints.keys()]).toEqual(['hivemapper', 'helium'])
    expect(mints.get('helium')?.equals(key(2))).toBe(true)
    expect(rewardMintsSchema.parse('').size).toBe(0)
    expect(rewardMintsSchema.parse(undefined).size).toBe(0)
  })

  it('writes a list that reads back as the same mints', () => {
    const mints = new Map([
      ['hivemapper', key(1)],
      ['helium', key(2)],
    ])

    const written = formatRewardMints(mints)

    expect(written).toBe(`hivemapper:${key(1).toBase58()},helium:${key(2).toBase58()}`)
    expect(rewardMintsSchema.parse(written)).toEqual(mints)
  })

  it('refuses a malformed list rather than lending against the wrong token', () => {
    expect(rewardMintsSchema.safeParse(`hivemapper=${key(1).toBase58()}`).success).toBe(false)
    expect(rewardMintsSchema.safeParse('hivemapper:not-a-key').success).toBe(false)
    expect(
      rewardMintsSchema.safeParse(`helium:${key(1).toBase58()},helium:${key(2).toBase58()}`)
        .success,
    ).toBe(false)
  })
})
