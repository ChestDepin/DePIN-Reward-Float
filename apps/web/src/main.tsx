import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { legacyAppPath } from './lib/legacy-path'
import { OperatorIdentityProvider } from './lib/wallet'

const moved = legacyAppPath(window.location.pathname, import.meta.env.BASE_URL)
if (moved !== null) {
  window.history.replaceState(null, '', moved + window.location.search + window.location.hash)
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Failed to find the root element')

createRoot(rootElement).render(
  <StrictMode>
    <OperatorIdentityProvider>
      {/* Under GitHub Pages the site lives at /<repo>/, and Vite's base is the
          only place that knows it: the router has to start from the same root. */}
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <App />
      </BrowserRouter>
    </OperatorIdentityProvider>
  </StrictMode>,
)
