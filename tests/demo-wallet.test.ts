import { Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { signAs } from './demo-wallet.ts'

const BLOCKHASH = '11111111111111111111111111111111'

function unsigned(feePayer: Keypair, to: Keypair): Uint8Array {
  return new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: BLOCKHASH })
    .add(
      SystemProgram.transfer({
        fromPubkey: feePayer.publicKey,
        toPubkey: to.publicKey,
        lamports: 1,
      }),
    )
    .serialize({ requireAllSignatures: false, verifySignatures: false })
}

describe('signAs', () => {
  it('returns the transaction signed by the wallet, verifiably', () => {
    const wallet = Keypair.generate()
    const signed = Transaction.from(signAs(wallet, unsigned(wallet, Keypair.generate())))

    expect(signed.signatures[0]?.publicKey.toBase58()).toBe(wallet.publicKey.toBase58())
    expect(signed.verifySignatures()).toBe(true)
  })

  it('keeps the message as the page built it', () => {
    const wallet = Keypair.generate()
    const bytes = unsigned(wallet, Keypair.generate())
    const signed = Transaction.from(signAs(wallet, bytes))

    expect(signed.serializeMessage()).toEqual(Transaction.from(bytes).serializeMessage())
  })

  // A test wallet that signed whatever it was handed would hide a page asking the wrong
  // key for its signature.
  it('refuses a transaction that does not ask for its signature', () => {
    const wallet = Keypair.generate()
    const stranger = Keypair.generate()

    expect(() => signAs(wallet, unsigned(stranger, wallet))).toThrow(/does not ask/)
  })
})
