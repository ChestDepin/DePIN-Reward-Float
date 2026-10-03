import { utils } from '@coral-xyz/anchor'
import { type PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'

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
