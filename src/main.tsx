import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/plus-jakarta-sans'
import './styles.css'
import App from './App.tsx'
import { routeExternalLinks } from './lib/android'
import { keepFresh } from './lib/freshness'

routeExternalLinks()
keepFresh()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
