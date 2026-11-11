import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

document.documentElement.dataset.theme = localStorage.getItem('theme') || 'system'
createRoot(document.getElementById('root')!).render(<App />)
