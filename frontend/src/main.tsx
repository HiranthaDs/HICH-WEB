import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './context/AuthContext'
import { ToastProvider } from './context/ToastContext'
import './styles.css'

const preloadReloadKey = 'hich-preload-reload-at'
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  const lastReload = Number(sessionStorage.getItem(preloadReloadKey) || 0)
  if (Date.now() - lastReload > 15_000) {
    sessionStorage.setItem(preloadReloadKey, String(Date.now()))
    window.location.reload()
  }
})
window.setTimeout(() => sessionStorage.removeItem(preloadReloadKey), 15_000)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
)
