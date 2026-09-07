import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { wireZoomWheel } from './zoom'

// Ctrl+wheel zoom, caught ahead of every terminal pane
wireZoomWheel()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
