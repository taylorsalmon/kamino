import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { THEMES } from '../src/term-themes'
import { keys, streamUrl } from './api'

/**
 * The clone's terminal, mirrored read-only at the desktop's exact width (a
 * TUI drawn for 120 columns only makes sense at 120 columns). It starts
 * scaled to fit the phone; A+ zooms in and the strip scrolls sideways. The
 * key strip covers every prompt the one-tap answers don't.
 */

const KEYS: Array<[string, string]> = [
  ['esc', 'Esc'],
  ['up', '↑'],
  ['down', '↓'],
  ['enter', '⏎'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['tab', 'Tab'],
  ['shift-tab', '⇧Tab'],
  ['left', '←'],
  ['right', '→'],
  ['y', 'y'],
  ['n', 'n'],
  ['backspace', '⌫'],
  ['ctrl-c', '^C']
]

const CHAR_W = 0.6 // monospace advance per px of font size, near enough

export function Screen(props: {
  ptyId: string
  theme: 'light' | 'dark'
  act: (fn: () => Promise<unknown>) => Promise<void>
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [zoom, setZoom] = useState(1)
  const [size, setSize] = useState({ cols: 120, rows: 32 })
  const [ended, setEnded] = useState<number | null>(null)
  const [linked, setLinked] = useState(false)

  useEffect(() => {
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      scrollback: 3000,
      fontFamily: "'Cascadia Mono', Menlo, 'SF Mono', Consolas, monospace",
      fontSize: 6,
      theme: THEMES[props.theme]
    })
    termRef.current = term
    term.open(host.current!)

    const es = new EventSource(streamUrl(`pty/${encodeURIComponent(props.ptyId)}/stream`))
    es.addEventListener('init', (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as { cols: number; rows: number; backlog: string }
      term.reset()
      term.resize(d.cols, d.rows)
      setSize({ cols: d.cols, rows: d.rows })
      term.write(d.backlog, () => term.scrollToBottom())
      setLinked(true)
    })
    es.addEventListener('data', (ev) => term.write(JSON.parse((ev as MessageEvent).data)))
    es.addEventListener('resize', (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as { cols: number; rows: number }
      term.resize(d.cols, d.rows)
      setSize(d)
    })
    es.addEventListener('exit', (ev) => {
      setEnded(JSON.parse((ev as MessageEvent).data).code)
      es.close()
    })
    es.onerror = () => setLinked(false)
    return () => {
      es.close()
      term.dispose()
      termRef.current = null
    }
  }, [props.ptyId, props.theme])

  // fit the desktop's column count to the phone's width, then apply zoom
  useEffect(() => {
    const fit = (): void => {
      const term = termRef.current
      const w = wrap.current?.clientWidth ?? 360
      if (!term) return
      const base = (w - 12) / (size.cols * CHAR_W)
      term.options.fontSize = Math.max(4, Math.min(14, Math.floor(base * zoom * 10) / 10))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [size.cols, zoom])

  return (
    <div className="screen-tab">
      <div className="term-tools">
        <span className={`term-link${linked ? ' on' : ''}`}>
          {ended !== null ? `ended (exit ${ended})` : linked ? `${size.cols}×${size.rows} live` : 'linking…'}
        </span>
        <button className="chip" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z - 0.5))}>
          A−
        </button>
        <button className="chip" disabled={zoom >= 3} onClick={() => setZoom((z) => Math.min(3, z + 0.5))}>
          A+
        </button>
        <button className="chip" onClick={() => termRef.current?.scrollToBottom()}>
          ⤓
        </button>
      </div>
      <div className="term-wrap" ref={wrap} style={{ background: THEMES[props.theme].background }}>
        <div className="term-host" ref={host} />
      </div>
      <div className="keystrip">
        {KEYS.map(([k, label]) => (
          <button key={k} className="key" onClick={() => void props.act(() => keys(props.ptyId, [k]))}>
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
