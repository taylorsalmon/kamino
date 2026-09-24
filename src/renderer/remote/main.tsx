import React from 'react'
import ReactDOM from 'react-dom/client'
import { PhoneApp } from './PhoneApp'
import './remote.css'

// iOS keeps the layout viewport full height when the keyboard opens; track
// the visible part so the composer stays above the keyboard
function trackViewport(): void {
  const vv = window.visualViewport
  const set = (): void =>
    document.documentElement.style.setProperty('--vvh', `${vv ? vv.height : window.innerHeight}px`)
  set()
  vv?.addEventListener('resize', set)
  window.addEventListener('resize', set)
}
trackViewport()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PhoneApp />
  </React.StrictMode>
)
