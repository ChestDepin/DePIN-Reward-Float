import { type SolanaAddress, solanaAddressSchema } from '@drf/shared/schemas'
import {
  type Adapter,
  WalletAccountError,
  WalletConnectionError,
  type WalletError,
  WalletPublicKeyError,
  WalletWindowClosedError,
} from '@solana/wallet-adapter-base'
import { ConnectionProvider, useWallet, WalletProvider } from '@solana/wallet-adapter-react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
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

// What the operator is told when the wallet they picked does not connect. Only the wallet's
// own answer counts: errors from signing or sending belong to the page that asked for them.
const CONNECT_FAILURES = [
  WalletConnectionError,
  WalletAccountError,
  WalletPublicKeyError,
  WalletWindowClosedError,
]

export function connectFailureText(error: WalletError): string | null {
  return CONNECT_FAILURES.some((kind) => error instanceof kind)
    ? 'the wallet refused to connect'
    : null
}

type ConnectFailure = {
  text: string | null
  // Called on the operator's own click: a failure counts from then on, and an old one is cleared.
  ask: () => void
}

const ConnectFailureContext = createContext<ConnectFailure>({ text: null, ask: () => {} })

export function OperatorIdentityProvider({ children }: { children: ReactNode }) {
  const [failure, setFailure] = useState<string | null>(null)
  const asked = useRef(false)

  // Once a wallet is selected, the provider connects it itself (autoConnect), so its answer
  // arrives here and not from a promise at the click. The silent reconnect on page load fails
  // the same way for a site the wallet does not trust yet; nobody asked, so it is not shown.
  const onError = useCallback((error: WalletError) => {
    if (!asked.current) return
    const text = connectFailureText(error)
    if (text === null) return
    asked.current = false
    setFailure(text)
  }, [])
  const ask = useCallback(() => {
    asked.current = true
    setFailure(null)
  }, [])
  const connectFailure = useMemo(() => ({ text: failure, ask }), [failure, ask])

  // History and limits still come from the api, which reads mainnet (FR-024b). This
  // connection is devnet and serves borrowing alone: the page reads the pool and the
  // operator's loans from the chain the program runs on, and sends the loan there.
  //
  // autoConnect keeps only the name of the chosen wallet. It is not a session or an
  // account: there is no token, and the decision to connect stays with the wallet.
  return (
    <ConnectionProvider endpoint={chainConfig.rpcUrl}>
      <WalletProvider wallets={NO_PRESET_ADAPTERS} autoConnect onError={onError}>
        <ConnectFailureContext.Provider value={connectFailure}>
          {children}
        </ConnectFailureContext.Provider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

export function useConnectFailure(): ConnectFailure {
  return useContext(ConnectFailureContext)
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

// No `connect` here: right after `select` it runs against the previous selection and fails
// with WalletNotSelectedError, while the provider connects the new wallet on its own.
export function useWalletConnection() {
  const { select, disconnect } = useWallet()

  return { select, disconnect }
}
