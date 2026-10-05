import { utils } from '@coral-xyz/anchor'
import { type PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import type { ChainReader } from './accounts.ts'

const CREATE_IDEMPOTENT = 1

// One instruction of the associated token program, written out rather than taken from
// @solana/spl-token, which the rest of the client has no use for.
export function createAssociatedTokenAccountIdempotent(input: {
  payer: PublicKey
  owner: PublicKey
  mint: PublicKey
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: utils.token.ASSOCIATED_PROGRAM_ID,
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      {
        pubkey: utils.token.associatedAddress({ mint: input.mint, owner: input.owner }),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: input.owner, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: utils.token.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([CREATE_IDEMPOTENT]),
  })
}

const TOKEN_ACCOUNT_SIZE = 165
const AMOUNT_OFFSET = 64

// An associated account is created on first receipt; until then the wallet holds none.
export async function fetchStableBalance(
  reader: ChainReader,
  owner: PublicKey,
  mint: PublicKey,
): Promise<bigint> {
  const address = utils.token.associatedAddress({ mint, owner })
  const info = await reader.getAccountInfo(address)
  if (info === null) return 0n
  if (!info.owner.equals(utils.token.TOKEN_PROGRAM_ID)) {
    throw new Error(`${address.toBase58()} is not owned by the token program`)
  }
  if (info.data.length < TOKEN_ACCOUNT_SIZE) {
    throw new Error(`${address.toBase58()} is too short to be a token account`)
  }
  return info.data.readBigUInt64LE(AMOUNT_OFFSET)
}
