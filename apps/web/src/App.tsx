import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Terminal from './components/Terminal'
import History from './pages/History'
import Limit from './pages/Limit'
import Lookup from './pages/Lookup'
import Mine from './pages/Mine'
import NotFound from './pages/NotFound'

// The program client, Anchor among it, is most of the bundle and only this page needs
// it; loaded with the rest, it would weigh on every first screen (SC-009).
const Borrow = lazy(() => import('./pages/Borrow'))

const App = () => {
  return (
    <Routes>
      <Route element={<Terminal />}>
        <Route path="/" element={<Navigate to="/lookup" replace />} />
        <Route path="/lookup" element={<Lookup />} />
        <Route path="/history" element={<Mine section="history" />} />
        <Route path="/history/:address" element={<History />} />
        <Route path="/limit" element={<Mine section="limit" />} />
        <Route path="/limit/:address" element={<Limit />} />
        <Route
          path="/borrow"
          element={
            <Suspense fallback={<p className="text-[13px] text-dim">loading…</p>}>
              <Borrow />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

export default App
