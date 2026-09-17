import { Navigate } from 'react-router-dom'
import { useOperatorIdentity } from '../lib/wallet'

// Адреса живе у шляху, тож своя сторінка — це просто шлях зі своєю адресою.
// Без цього переходу посилання в шапці не мали б куди вести до підключення.
const Mine = ({ section }: { section: 'history' | 'limit' }) => {
  const identity = useOperatorIdentity()

  if (identity.status === 'connected') {
    return <Navigate to={`/${section}/${identity.address}`} replace />
  }

  if (identity.status === 'connecting') {
    return <p className="text-[13px] text-dim">connecting the wallet…</p>
  }

  return <Navigate to="/lookup" replace />
}

export default Mine
