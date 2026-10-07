import { type Keypair, VersionedTransaction } from '@solana/web3.js'
import type { BrowserContext } from 'playwright'
import { z } from 'zod'

// What the page sees is a Wallet Standard wallet like Phantom: it registers itself, the
// site lists it, the operator clicks it. The key never enters the page: every signature
// is made here, in the test process, through one exposed function.
const SIGN_BINDING = 'drfDemoWalletSign'
const ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4='

export function signAs(wallet: Keypair, bytes: Uint8Array): Uint8Array {
  const transaction = VersionedTransaction.deserialize(bytes)
  const { header, staticAccountKeys } = transaction.message
  const signers = staticAccountKeys.slice(0, header.numRequiredSignatures)
  if (!signers.some((key) => key.equals(wallet.publicKey))) {
    throw new Error(`the transaction does not ask ${wallet.publicKey.toBase58()} to sign`)
  }
  transaction.sign([wallet])

  return transaction.serialize()
}

const bytesSchema = z.array(z.number().int().min(0).max(255))

export async function installDemoWallet(
  context: BrowserContext,
  input: { wallet: Keypair; name: string },
): Promise<void> {
  const { wallet, name } = input
  await context.exposeFunction(SIGN_BINDING, (bytes: unknown) => [
    ...signAs(wallet, Uint8Array.from(bytesSchema.parse(bytes))),
  ])

  const config = JSON.stringify({
    name,
    icon: ICON,
    binding: SIGN_BINDING,
    address: wallet.publicKey.toBase58(),
    publicKey: [...wallet.publicKey.toBytes()],
  })
  // Runs in the page, before the site's own code, so the wallet is there when the site
  // asks who is installed, and answers if it registers later.
  await context.addInitScript({
    content: `(() => {
  const config = ${config}
  const chains = ['solana:devnet']
  const account = Object.freeze({
    address: config.address,
    publicKey: new Uint8Array(config.publicKey),
    chains,
    features: ['solana:signTransaction'],
  })
  let accounts = []
  const listeners = new Set()
  const changed = () => { for (const listener of listeners) listener({ accounts }) }
  const wallet = {
    version: '1.0.0',
    name: config.name,
    icon: config.icon,
    chains,
    get accounts() { return accounts },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => { accounts = [account]; changed(); return { accounts } },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => { accounts = []; changed() },
      },
      'standard:events': {
        version: '1.0.0',
        on: (event, listener) => {
          if (event !== 'change') return () => {}
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: (...inputs) => Promise.all(inputs.map(async (input) => ({
          signedTransaction: new Uint8Array(await window[config.binding](Array.from(input.transaction))),
        }))),
      },
    },
  }
  const register = (api) => api.register(wallet)
  window.addEventListener('wallet-standard:app-ready', (event) => register(event.detail))
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
})()`,
  })
}
