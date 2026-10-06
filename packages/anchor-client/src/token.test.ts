import { utils } from '@coral-xyz/anchor'
import type { AccountInfo, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { ChainReader } from './accounts.ts'
import { key } from './test-support.ts'
import { fetchStableBalance, mintToInstruction, tokenAmount } from './token.ts'

const owner = key(3)
const mint = key(2)
const ata = utils.token.associatedAddress({ mint, owner })

// SPL token account: mint (0), owner (32), amount u64 LE (64), then the rest up to 165.
function tokenAccount(amount: bigint): Buffer {
  const data = Buffer.alloc(165)
  mint.toBuffer().copy(data, 0)
  owner.toBuffer().copy(data, 32)
  data.writeBigUInt64LE(amount, 64)
  return data
}

function reader(accounts: Map<string, AccountInfo<Buffer>>): ChainReader {
  return {
    getAccountInfo: async (address: PublicKey) => accounts.get(address.toBase58()) ?? null,
    getProgramAccounts: async () => [],
  }
}

const info = (data: Buffer, programOwner = utils.token.TOKEN_PROGRAM_ID) => ({
  data,
  owner: programOwner,
  lamports: 1,
  executable: false,
  rentEpoch: 0,
})

describe('fetchStableBalance', () => {
  it('reads the amount held in the owner’s associated account for the mint', async () => {
    const chain = reader(new Map([[ata.toBase58(), info(tokenAccount(123_456_789n))]]))

    await expect(fetchStableBalance(chain, owner, mint)).resolves.toBe(123_456_789n)
  })

  it('counts an associated account that does not exist yet as holding nothing', async () => {
    await expect(fetchStableBalance(reader(new Map()), owner, mint)).resolves.toBe(0n)
  })

  it('refuses an account the token program does not own', async () => {
    const chain = reader(new Map([[ata.toBase58(), info(tokenAccount(5n), key(77))]]))

    await expect(fetchStableBalance(chain, owner, mint)).rejects.toThrow(/token program/)
  })

  it('refuses bytes too short to be a token account', async () => {
    const chain = reader(new Map([[ata.toBase58(), info(Buffer.alloc(64))]]))

    await expect(fetchStableBalance(chain, owner, mint)).rejects.toThrow(/token account/)
  })
})

describe('tokenAmount', () => {
  it('reads the amount out of an account already fetched, missing as nothing', () => {
    expect(tokenAmount(ata, info(tokenAccount(42n)))).toBe(42n)
    expect(tokenAmount(ata, null)).toBe(0n)
    expect(() => tokenAmount(ata, info(tokenAccount(5n), key(77)))).toThrow(/token program/)
  })
})

describe('mint to', () => {
  const wallet = key(1)

  it('mints to an account, amount little-endian', () => {
    const destination = key(5)
    const ix = mintToInstruction({ mint, destination, authority: wallet, amount: 258n })

    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [mint.toBase58(), false, true],
      [destination.toBase58(), false, true],
      [wallet.toBase58(), true, false],
    ])
    expect([...ix.data]).toEqual([7, 2, 1, 0, 0, 0, 0, 0, 0])
  })
})
