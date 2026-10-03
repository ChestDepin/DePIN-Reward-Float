import { type SolanaAddress, solanaAddressSchema } from '@drf/shared/schemas'
import type { Adapter } from '@solana/wallet-adapter-base'
import { ConnectionProvider, useWallet, WalletProvider } from '@solana/wallet-adapter-react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { chainConfig } from './chain'

export type WalletSnapshot = {
  wallets: readonly string[]
  connecting: boolean
  address: string | null
}

export type OperatorIdentity =
  | { status: 'no-wallet' }
  | { status: 'disconnected'; wallets: readonly string[] }
  | { status: 'connecting' }
  | { status: 'connected'; address: SolanaAddress }
  | { status: 'unusable-address' }

export function deriveIdentity({ wallets, connecting, address }: WalletSnapshot): OperatorIdentity {
  if (address !== null) {
    // Розширення гаманця — чужий код у тій самій сторінці, тому адреса від нього
    // перевіряється, а не приймається на слово: далі вона їде у шлях запиту.
    const parsed = solanaAddressSchema.safeParse(address)

    return parsed.success
      ? { status: 'connected', address: parsed.data }
      : { status: 'unusable-address' }
  }

  if (connecting) return { status: 'connecting' }
  if (wallets.length === 0) return { status: 'no-wallet' }

  return { status: 'disconnected', wallets }
}

// Порожньо і назавжди: гаманці реєструються самі через Wallet Standard. Перелік
// адаптерів тут означав би, що ми вирішуємо за оператора, чим йому користуватись.
const NO_PRESET_ADAPTERS: Adapter[] = []

export function OperatorIdentityProvider({ children }: { children: ReactNode }) {
  // History and limits still come from the api, which reads mainnet (FR-024b). This
  // connection is devnet and serves borrowing alone: the page reads the pool and the
  // operator's loans from the chain the program runs on, and sends the loan there.
  //
  // autoConnect keeps only the name of the chosen wallet. It is not a session or an
  // account: there is no token, and the decision to connect stays with the wallet.
  return (
    <ConnectionProvider endpoint={chainConfig.rpcUrl}>
      <WalletProvider wallets={NO_PRESET_ADAPTERS} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  )
}

export function useOperatorIdentity(): OperatorIdentity {
  const { wallets, connecting, publicKey } = useWallet()

  return deriveIdentity({
    wallets: wallets.map((wallet) => String(wallet.adapter.name)),
    connecting,
    address: publicKey?.toBase58() ?? null,
  })
}

// Адреса у шляху приходить із рядка, який набрав хтось інший, тож перевіряється
// тією ж схемою, що й адреса з розширення гаманця.
export function useAddressParam(): SolanaAddress | null {
  const { address } = useParams()
  const parsed = solanaAddressSchema.safeParse(address)

  return parsed.success ? parsed.data : null
}

export function useWalletConnection() {
  const { select, connect, disconnect } = useWallet()

  return { select, connect, disconnect }
}
