import { Navigate, Route, Routes } from 'react-router-dom'
import Terminal from './components/Terminal'
import History from './pages/History'
import Limit from './pages/Limit'
import Lookup from './pages/Lookup'
import Mine from './pages/Mine'
import NotFound from './pages/NotFound'
import Offer from './pages/Offer'

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
        <Route path="/offer" element={<Offer />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

export default App
