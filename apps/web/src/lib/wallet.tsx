import { type SolanaAddress, solanaAddressSchema } from '@drf/shared/schemas'
import type { Adapter } from '@solana/wallet-adapter-base'
import { useWallet, WalletProvider } from '@solana/wallet-adapter-react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'

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
  // ConnectionProvider свідомо відсутній: браузер до RPC не ходить взагалі —
  // ланцюг читає indexer, а сторінка бачить його результат через api (FR-024b).
  //
  // autoConnect зберігає лише ім'я обраного гаманця. Це не сесія і не обліковий
  // запис: жодного токена, і рішення підключитись щоразу лишається за гаманцем.
  return (
    <WalletProvider wallets={NO_PRESET_ADAPTERS} autoConnect>
      {children}
    </WalletProvider>
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
