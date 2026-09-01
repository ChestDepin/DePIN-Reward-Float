import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { OperatorIdentityProvider } from './lib/wallet'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Failed to find the root element')

createRoot(rootElement).render(
  <StrictMode>
    <OperatorIdentityProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </OperatorIdentityProvider>
  </StrictMode>,
)
