/**
 * zoom — the whole board scales like a browser page. Ctrl+= / Ctrl+- / Ctrl+0
 * and Ctrl+wheel, remembered across restarts.
 *
 * The chords are caught here in the main process on the way in
 * (before-input-event), so they work even while an xterm pane owns the
 * keyboard — the renderer never sees the keystroke, so nothing can swallow it.
 * The wheel comes the other way: xterm consumes wheel events over a pane, so
 * the renderer catches Ctrl+wheel at window capture (renderer/zoom.ts) and
 * asks us to step.
 */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import type { BrowserWindow, WebContents } from 'electron'
import type { ZoomState } from '../shared/types'

/** one Chromium zoom level is ×1.2; half-levels give browser-like ~10% moves */
const STEP = 0.5
const MIN_LEVEL = -3 // ≈ 58%
const MAX_LEVEL = 5 // ≈ 249%

type ZoomAction = 'zoomIn' | 'zoomOut' | 'reset'

export class Zoom extends EventEmitter {
  private level = 0
  private wc: WebContents | null = null

  constructor(private readonly file: string) {
    super()
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { level?: unknown }
      if (typeof raw.level === 'number' && Number.isFinite(raw.level)) this.level = clamp(raw.level)
    } catch {
      // first run, or an unreadable file — 100% it is
    }
  }

  snapshot(): ZoomState {
    return { level: this.level, percent: percentOf(this.level) }
  }

  attach(win: BrowserWindow): void {
    const wc = win.webContents
    this.wc = wc
    // Chromium keeps zoom per origin and resets it on navigation — reapply on
    // every load so the first paint (and any renderer reload) lands at the
    // saved level instead of flashing 100%
    wc.on('did-finish-load', () => wc.setZoomLevel(this.level))
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return
      const action = chord(input)
      if (!action) return
      e.preventDefault() // neither the page nor xterm gets this keystroke
      this[action]()
    })
  }

  zoomIn(): void {
    this.set(this.level + STEP)
  }

  zoomOut(): void {
    this.set(this.level - STEP)
  }

  reset(): void {
    this.set(0)
  }

  private set(level: number): void {
    this.level = clamp(level)
    this.wc?.setZoomLevel(this.level)
    try {
      fs.writeFileSync(this.file, JSON.stringify({ level: this.level }))
    } catch {
      // a lost preference is not worth a dialog
    }
    // emitted even at the limits, so the HUD can show you're pinned there
    this.emit('change', this.snapshot())
  }
}

/** Which zoom a Ctrl chord asks for. `key` first — it's what the user sees on
 *  the cap, so Ctrl+= and Ctrl+Shift+= (the + key) both zoom in on any layout;
 *  `code` catches the numpad and 0, whose key varies with Shift. */
function chord(input: { key: string; code: string }): ZoomAction | null {
  if (input.key === '+' || input.key === '=') return 'zoomIn'
  if (input.key === '-') return 'zoomOut'
  if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') return 'reset'
  switch (input.code) {
    case 'Equal':
    case 'NumpadAdd':
      return 'zoomIn'
    case 'Minus':
    case 'NumpadSubtract':
      return 'zoomOut'
    default:
      return null
  }
}

function clamp(level: number): number {
  const snapped = Math.round(level / STEP) * STEP
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, snapped))
}

function percentOf(level: number): number {
  return Math.round(Math.pow(1.2, level) * 100)
}
