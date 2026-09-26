import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { UiProvider } from './components/Ui'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiProvider>
      <App />
    </UiProvider>
  </StrictMode>
)
