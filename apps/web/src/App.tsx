import { Navigate, Route, Routes } from 'react-router-dom'
import Terminal from './components/Terminal'
import History from './pages/History'
import Limit from './pages/Limit'
import Lookup from './pages/Lookup'
import NotFound from './pages/NotFound'
import Offer from './pages/Offer'
import Refused from './pages/Refused'

const App = () => {
  return (
    <Routes>
      <Route element={<Terminal />}>
        <Route path="/" element={<Navigate to="/limit" replace />} />
        <Route path="/lookup" element={<Lookup />} />
        <Route path="/history" element={<History />} />
        <Route path="/limit" element={<Limit />} />
        <Route path="/offer" element={<Offer />} />
        <Route path="/refused" element={<Refused />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

export default App
