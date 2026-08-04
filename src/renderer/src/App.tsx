import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FleetSnapshot, Instance, PrStatusMap } from '../../shared/types'
import { InstanceCard } from './components/InstanceCard'
import { DetailPanel } from './components/DetailPanel'
import { TerminalView } from './components/TerminalView'
import { LaunchDialog } from './components/LaunchDialog'
import { WrapupDialog } from './components/WrapupDialog'
import { GridPane } from './components/GridPane'
import { focusTerminal, setTermFontSize } from './terminals'
import { agoShort, elapsed, jediQuote, KIND_WORD, prBadge, STATE_WORD } from './format'

type ViewMode = 'grid' | 'focus'
type Theme = 'light' | 'dark'
type Density = 'roomy' | 'fit' | 'max'

/** grid density: how hard the wall packs clones onto the screen.
 *  min   — column min-width; narrower columns = more side by side
 *  rowMin— pane floor; below this the wall scrolls instead of shrinking
 *          panes into unusable slivers
 *  font  — terminal glyph size, so Max actually fits more columns of text */
const DENSITY: Record<Density, { min: number; rowMin: number; font: number }> = {
  roomy: { min: 560, rowMin: 320, font: 14 },
  fit: { min: 430, rowMin: 240, font: 13 },
  max: { min: 330, rowMin: 185, font: 11 }
}

interface PtyRef {
  ptyId: string
  pid: number
  cwd: string
}

/** pane size in grid tracks — snaps to whole tracks, never per-pixel */
export interface PaneSize {
  w: number
  h: number
}

/** wall geometry — must match .grid-view gap/padding in styles.css */
const GRID_GAP = 6
const GRID_PAD = 6

function loadJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || '') as T
  } catch {
    return fallback
  }
}

export default function App(): React.JSX.Element {
  const [snap, setSnap] = useState<FleetSnapshot>({ instances: [], updatedAt: 0 })
  const [prStatus, setPrStatus] = useState<PrStatusMap>({})
  const [selectedId, setSelectedId] = useState<string | null>(null) // sessionId or ptyId
  const [now, setNow] = useState(Date.now())
  const [ptyRefs, setPtyRefs] = useState<PtyRef[]>([])
  const [showLaunch, setShowLaunch] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [showWrapup, setShowWrapup] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [view, setView] = useState<ViewMode>(
    () => (localStorage.getItem('fleet:view') as ViewMode) || 'grid'
  )
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('fleet:theme') as Theme) || 'light'
  )
  const [density, setDensity] = useState<Density>(() => {
    const d = localStorage.getItem('fleet:density') as Density
    return d in DENSITY ? d : 'fit'
  })

  useEffect(() => {
    localStorage.setItem('fleet:density', density)
    setTermFontSize(DENSITY[density].font)
  }, [density])

  // wall layout — manual slot order (drag & drop) and per-pane spans, both
  // in fixed grid steps. Keyed by sessionId/ptyId, survives restarts.
  const [paneOrder, setPaneOrder] = useState<string[]>(() => loadJson('fleet:pane-order', []))
  const [paneSizes, setPaneSizes] = useState<Record<string, PaneSize>>(() =>
    loadJson('fleet:pane-sizes', {})
  )
  useEffect(() => {
    localStorage.setItem('fleet:pane-order', JSON.stringify(paneOrder))
  }, [paneOrder])
  useEffect(() => {
    localStorage.setItem('fleet:pane-sizes', JSON.stringify(paneSizes))
  }, [paneSizes])

  const setPaneSize = useCallback((id: string, size: PaneSize) => {
    setPaneSizes((m) => {
      const cur = m[id]
      if (cur?.w === size.w && cur?.h === size.h) return m
      return { ...m, [id]: size }
    })
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('fleet:theme', theme)
  }, [theme])

  function switchView(v: ViewMode): void {
    setView(v)
    localStorage.setItem('fleet:view', v)
  }

  /**
   * "Move into Fleet": an external instance can't be re-parented while its
   * terminal owns it — so we arm an adoption. The moment the outside process
   * exits (user closes the tab), Fleet resumes the same session embedded.
   */
  const [pendingAdopt, setPendingAdopt] = useState<Record<string, { cwd: string }>>({})
  const adoptingRef = useRef(new Set<string>())

  useEffect(() => {
    for (const [sessionId, info] of Object.entries(pendingAdopt)) {
      const inst = snap.instances.find((i) => i.sessionId === sessionId)
      const gone = !inst || inst.state === 'dead'
      if (gone && !adoptingRef.current.has(sessionId)) {
        adoptingRef.current.add(sessionId)
        window.fleet
          .spawn({ cwd: info.cwd, resumeSessionId: sessionId })
          .then((p) => {
            setPendingAdopt((m) => {
              const next = { ...m }
              delete next[sessionId]
              return next
            })
            window.fleet.ptyList().then(setPtyRefs)
            setSelectedId(p.ptyId)
          })
          .finally(() => adoptingRef.current.delete(sessionId))
      }
    }
  }, [snap, pendingAdopt])

  const [hooksOk, setHooksOk] = useState(true)

  // F2 flips Terminal ⇄ Intel from anywhere — the terminal forwards it via
  // a window event since xterm otherwise owns the keyboard
  useEffect(() => {
    const toggle = (): void => setShowInfo((v) => !v)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F2') return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('kamino:toggle-info', toggle)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('kamino:toggle-info', toggle)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    window.fleet.getFleet().then(setSnap)
    window.fleet.getPrStatus().then(setPrStatus)
    window.fleet.ptyList().then(setPtyRefs) // survive renderer reloads
    window.fleet.hooksStatus().then(setHooksOk)
    const offFleet = window.fleet.onFleet(setSnap)
    const offPr = window.fleet.onPrStatus(setPrStatus)
    const offExit = window.fleet.onPtyExit(() => window.fleet.ptyList().then(setPtyRefs))
    const offSelect = window.fleet.onSelectSession((sessionId) => {
      setSelectedId(sessionId)
      setShowInfo(false)
    })
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      offFleet()
      offPr()
      offExit()
      offSelect()
      clearInterval(tick)
    }
  }, [])


  const ptyByPid = useMemo(() => {
    const m = new Map<number, PtyRef>()
    for (const p of ptyRefs) m.set(p.pid, p)
    return m
  }, [ptyRefs])

  /** ptys that haven't shown up in the session registry yet */
  const startingPtys = useMemo(
    () => ptyRefs.filter((p) => !snap.instances.some((i) => i.pid === p.pid && i.state !== 'dead')),
    [ptyRefs, snap]
  )

  /** wall order — stable launch-time sort, then any manual drag order on
   *  top. Manual positions win; new clones append in launch order. */
  const gridInstances = useMemo(() => {
    const base = snap.instances
      .filter((i) => i.state !== 'dead')
      .sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId))
    const pos = new Map(paneOrder.map((id, i) => [id, i]))
    return base
      .map((inst, i) => ({ inst, key: pos.get(inst.sessionId) ?? paneOrder.length + i }))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.inst)
  }, [snap, paneOrder])

  /** drop src onto dst: src takes dst's slot, everything between shifts */
  const movePane = useCallback(
    (srcId: string, dstId: string) => {
      if (srcId === dstId) return
      const ids = [
        ...gridInstances.map((i) => i.sessionId),
        ...startingPtys.map((p) => p.ptyId)
      ]
      const from = ids.indexOf(srcId)
      const to = ids.indexOf(dstId)
      if (from < 0 || to < 0) return
      ids.splice(to, 0, ...ids.splice(from, 1))
      setPaneOrder(ids)
    },
    [gridInstances, startingPtys]
  )

  // a starting pane is keyed by ptyId; once it binds to a session, carry its
  // size and slot over — otherwise a resize/reorder silently vanishes
  useEffect(() => {
    for (const inst of snap.instances) {
      const ptyId = ptyByPid.get(inst.pid)?.ptyId
      if (!ptyId) continue
      if (paneSizes[ptyId] && !paneSizes[inst.sessionId]) {
        setPaneSizes((m) => {
          const next = { ...m, [inst.sessionId]: m[ptyId] }
          delete next[ptyId]
          return next
        })
      }
      if (paneOrder.includes(ptyId) && !paneOrder.includes(inst.sessionId)) {
        setPaneOrder((o) => o.map((x) => (x === ptyId ? inst.sessionId : x)))
      }
    }
  }, [snap, ptyByPid, paneSizes, paneOrder])

  // wall measurements — drives explicit column/row math below
  const gridRef = useRef<HTMLDivElement>(null)
  const [gridBox, setGridBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    if (view !== 'grid') return
    const el = gridRef.current
    if (!el) return
    const measure = (): void => setGridBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [view])

  /** explicit grid math. auto-fit + spans lets the browser reflow panes into
   *  different slots (looks like the wrong pane resized), and 1fr rows shrink
   *  every OTHER pane when one grows taller. So: we pick the column count,
   *  and rows are a FIXED pixel height — a taller pane takes real space and
   *  the wall scrolls; its neighbours keep their size. */
  const layout = useMemo(() => {
    const { min, rowMin } = DENSITY[density]
    const w = Math.max(0, gridBox.w - GRID_PAD * 2)
    const h = Math.max(0, gridBox.h - GRID_PAD * 2)
    const cols = Math.max(1, Math.floor((w + GRID_GAP) / (min + GRID_GAP)))
    const rowsFit = Math.max(1, Math.floor((h + GRID_GAP) / (rowMin + GRID_GAP)))
    // stretch rows to fill when everything fits; fixed floor (scroll) when not
    const ids = [...gridInstances.map((i) => i.sessionId), ...startingPtys.map((p) => p.ptyId)]
    const cells = ids.reduce((n, id) => {
      const s = paneSizes[id]
      return n + Math.min(s?.w ?? 1, cols) * Math.min(s?.h ?? 1, rowsFit)
    }, 0)
    const rows = Math.max(1, Math.min(Math.ceil(cells / cols), rowsFit))
    const rowH = h > 0 ? Math.floor((h - (rows - 1) * GRID_GAP) / rows) : rowMin
    return { cols, rowsFit, rowH }
  }, [density, gridBox, gridInstances, startingPtys, paneSizes])

  /** stored span, clamped to what the current wall can actually hold */
  const paneSize = useCallback(
    (id: string): PaneSize => {
      const s = paneSizes[id] ?? { w: 1, h: 1 }
      return {
        w: Math.max(1, Math.min(s.w, layout.cols)),
        h: Math.max(1, Math.min(s.h, layout.rowsFit))
      }
    },
    [paneSizes, layout]
  )

  // Ctrl+1..9 / Ctrl+` targets, kept in refs so the mount-once key listener
  // always sees the current wall without rebinding
  const slotTargets = useMemo(
    () => [
      ...gridInstances.map((i) => ({ id: i.sessionId, ptyId: ptyByPid.get(i.pid)?.ptyId ?? null })),
      ...startingPtys.map((p) => ({ id: p.ptyId, ptyId: p.ptyId }))
    ],
    [gridInstances, ptyByPid, startingPtys]
  )
  const askTargets = useMemo(
    () =>
      gridInstances
        .filter((i) => i.state === 'needs-you')
        .map((i) => ({ id: i.sessionId, ptyId: ptyByPid.get(i.pid)?.ptyId ?? null })),
    [gridInstances, ptyByPid]
  )
  const slotRef = useRef(slotTargets)
  slotRef.current = slotTargets
  const askRef = useRef(askTargets)
  askRef.current = askTargets
  const viewRef = useRef(view)
  viewRef.current = view
  const askCursor = useRef(0)

  useEffect(() => {
    const goto = (t: { id: string; ptyId: string | null } | undefined): void => {
      if (!t) return
      if (viewRef.current === 'grid') {
        if (t.ptyId) focusTerminal(t.ptyId)
      } else {
        setSelectedId(t.id)
        setShowInfo(false)
      }
    }
    const onSlot = (e: Event): void => goto(slotRef.current[(e as CustomEvent<number>).detail])
    const onAsk = (): void => {
      const list = askRef.current
      if (list.length === 0) return
      askCursor.current %= list.length
      goto(list[askCursor.current])
      askCursor.current++
    }
    // terminals forward these shortcuts via events (xterm owns their
    // keyboard); this keydown covers presses everywhere else
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      const digit = /^Digit([1-9])$/.exec(e.code)
      if (digit) {
        e.preventDefault()
        goto(slotRef.current[Number(digit[1]) - 1])
      } else if (e.code === 'Backquote') {
        e.preventDefault()
        onAsk()
      }
    }
    window.addEventListener('kamino:focus-slot', onSlot)
    window.addEventListener('kamino:next-ask', onAsk)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('kamino:focus-slot', onSlot)
      window.removeEventListener('kamino:next-ask', onAsk)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const selectedInstance = useMemo(
    () => snap.instances.find((i) => i.sessionId === selectedId) ?? null,
    [snap, selectedId]
  )
  const selectedPty = useMemo(() => {
    if (selectedInstance) return ptyByPid.get(selectedInstance.pid) ?? null
    return ptyRefs.find((p) => p.ptyId === selectedId) ?? null
  }, [selectedInstance, ptyByPid, ptyRefs, selectedId])

  // let main know which card is on screen so it can skip redundant toasts
  useEffect(() => {
    window.fleet.reportSelected(selectedInstance?.sessionId ?? null)
  }, [selectedInstance?.sessionId])

  // once a starting pty registers a session, upgrade selection to the session
  useEffect(() => {
    if (selectedId?.startsWith('pty-')) {
      const ref = ptyRefs.find((p) => p.ptyId === selectedId)
      const inst = ref && snap.instances.find((i) => i.pid === ref.pid && i.state !== 'dead')
      if (inst) setSelectedId(inst.sessionId)
    }
  }, [snap, selectedId, ptyRefs])

  const onLaunched = useCallback((ptyId: string, pid: number) => {
    setShowLaunch(false)
    setShowInfo(false)
    window.fleet.ptyList().then(setPtyRefs)
    setPtyRefs((refs) => (refs.some((r) => r.ptyId === ptyId) ? refs : [...refs, { ptyId, pid, cwd: '' }]))
    setSelectedId(ptyId)
  }, [])

  const counts = useMemo(() => {
    const c = { busy: 0, 'needs-you': 0, idle: 0, dead: 0 }
    for (const i of snap.instances) c[i.state]++
    return c
  }, [snap])
  const live = counts.busy + counts['needs-you'] + counts.idle
  const kinds = useMemo(() => {
    const k = { embedded: 0, external: 0, background: 0 }
    for (const i of snap.instances) {
      if (i.state !== 'dead' && i.kind in k) k[i.kind as keyof typeof k]++
    }
    return k
  }, [snap])

  const showTerminal = selectedPty && !showInfo

  async function executeOrder66(): Promise<void> {
    const targets = snap.instances.filter((i) => i.state !== 'dead')
    const n = targets.length + startingPtys.length
    if (n === 0) return
    if (
      !(await window.fleet.confirm(
        'Execute Order 66?',
        `All ${n} clone${n === 1 ? '' : 's'} on this board will be terminated — embedded, outside terminals, and background sessions alike.\n\nGood soldiers follow orders.`
      ))
    )
      return
    for (const p of startingPtys) window.fleet.ptyKill(p.ptyId)
    for (const inst of targets) {
      const pty = ptyByPid.get(inst.pid)
      if (pty) window.fleet.ptyKill(pty.ptyId)
      else window.fleet.killPid(inst.pid)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark" title="Clone production facility">
          <span className="claude">KAM</span>INO
          <span className="wordmark-sub">CLONE PRODUCTION FACILITY</span>
        </div>
        <div className="fleet-counts">
          <span className="count">
            <span className="count-dot" style={{ background: 'var(--sage)' }} />
            {live} clones active
          </span>
          <span className="count">
            <span className="count-dot" style={{ background: 'var(--amber)' }} />
            {counts.busy} engaged
          </span>
          {counts['needs-you'] > 0 && (
            <span className="count needs-you">
              <span className="count-dot" style={{ background: 'var(--coral)' }} />
              {counts['needs-you']} awaiting orders
            </span>
          )}
          <span
            className="count kind-split"
            title="Fleet sees every Claude Code process on this machine — including ones running in other terminals and headless/background sessions, not just the terminals you have open"
          >
            {kinds.embedded} in bays · {kinds.external} field-deployed · {kinds.background} covert ops
          </span>
        </div>
        <div className="topbar-spacer" />
        <div className="view-toggle">
          <button
            className={`view-btn${view === 'grid' ? ' active' : ''}`}
            onClick={() => switchView('grid')}
            title="All terminals side by side"
          >
            ▦ Grid
          </button>
          <button
            className={`view-btn${view === 'focus' ? ' active' : ''}`}
            onClick={() => switchView('focus')}
            title="One terminal, full size"
          >
            ▣ Focus
          </button>
        </div>
        {view === 'grid' && (
          <div className="view-toggle density-toggle">
            <button
              className={`view-btn${density === 'roomy' ? ' active' : ''}`}
              onClick={() => setDensity('roomy')}
              title="Roomy — big panes, few clones"
            >
              ▢
            </button>
            <button
              className={`view-btn${density === 'fit' ? ' active' : ''}`}
              onClick={() => setDensity('fit')}
              title="Fit — balanced"
            >
              ▦
            </button>
            <button
              className={`view-btn${density === 'max' ? ' active' : ''}`}
              onClick={() => setDensity('max')}
              title="Max — smallest readable panes, as many clones as fit"
            >
              ▩
            </button>
          </div>
        )}
        <button
          className="btn theme-btn"
          title={theme === 'light' ? 'Night cycle' : 'Day cycle'}
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        >
          {theme === 'light' ? '☾' : '☀'}
        </button>
        {live > 0 && (
          <button
            className="btn order66-btn"
            title="Terminate every clone on the board. Unlimited power."
            onClick={executeOrder66}
          >
            Order 66
          </button>
        )}
        <button className="btn primary new-btn" onClick={() => setShowLaunch(true)}>
          + Commission clone
        </button>
        <div className="topbar-menu">
          <button
            className={`btn menu-btn${menuOpen ? ' active' : ''}`}
            title="Fleet actions"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen && (
            <>
              {/* invisible backdrop: any outside click closes the menu */}
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="menu-panel">
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    setShowWrapup(true)
                  }}
                >
                  <span className="menu-item-title">🧹 End-of-shift sweep</span>
                  <span className="menu-item-sub">
                    check every repo is committed, pushed &amp; on a PR before you close out
                  </span>
                </button>
              </div>
            </>
          )}
        </div>
        <div className="topbar-clock">
          {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </header>

      {!hooksOk && (
        <div className="hooks-banner">
          Long-range comms are down — Kamino can&apos;t tell when a clone is awaiting your orders.
          <button
            className="btn primary"
            onClick={async () => {
              await window.fleet.hooksInstall()
              setHooksOk(await window.fleet.hooksStatus())
            }}
          >
            Restore comms
          </button>
          <span className="hooks-note">adds Notification/Stop hooks to ~/.claude/settings.json — applies to newly started instances</span>
        </div>
      )}

      {view === 'grid' ? (
        <div
          ref={gridRef}
          className="grid-view"
          data-density={density}
          style={
            {
              '--pane-min': `${DENSITY[density].min}px`,
              '--pane-row-min': `${DENSITY[density].rowMin}px`,
              // explicit tracks once measured — see layout memo for why
              ...(gridBox.w > 0
                ? {
                    gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
                    gridAutoRows: `${layout.rowH}px`
                  }
                : {})
            } as React.CSSProperties
          }
        >
          {snap.instances.length === 0 && startingPtys.length === 0 && (
            <div className="detail-empty">
              <div className="big">HELLO THERE.</div>
              <div>The facility is quiet. Commission a clone with “+ Commission clone”, or start one in any terminal</div>
              <div className="jedi-quote">{jediQuote()}</div>
            </div>
          )}
          {/* gridInstances keeps slots STABLE while you type — the store
              sorts by state for the roster, but the wall orders by launch
              time, which never changes, so a pane keeps its slot (and its
              Ctrl+n number) for its whole life */}
          {gridInstances.map((inst, ix) => (
              <GridPane
                key={inst.sessionId}
                paneId={inst.sessionId}
                instance={inst}
                ptyId={ptyByPid.get(inst.pid)?.ptyId ?? null}
                now={now}
                slot={ix}
                size={paneSize(inst.sessionId)}
                onSizeChange={(s) => setPaneSize(inst.sessionId, s)}
                maxSpan={{ w: layout.cols, h: layout.rowsFit }}
                onDropPane={(srcId) => movePane(srcId, inst.sessionId)}
                adoptPending={inst.sessionId in pendingAdopt}
                prStatus={prStatus}
                onAdopt={() => setPendingAdopt((m) => ({ ...m, [inst.sessionId]: { cwd: inst.cwd } }))}
                onFocus={() => {
                  setSelectedId(inst.sessionId)
                  setShowInfo(false)
                  switchView('focus')
                }}
              />
            ))}
          {/* freshly commissioned clones append at the end — when one binds
              to a session its startedAt is newest, so it stays in that slot */}
          {startingPtys.map((p, ix) => (
            <GridPane
              key={p.ptyId}
              paneId={p.ptyId}
              instance={null}
              ptyId={p.ptyId}
              now={now}
              slot={gridInstances.length + ix}
              size={paneSize(p.ptyId)}
              onSizeChange={(s) => setPaneSize(p.ptyId, s)}
              maxSpan={{ w: layout.cols, h: layout.rowsFit }}
              onDropPane={(srcId) => movePane(srcId, p.ptyId)}
              adoptPending={false}
              onAdopt={() => {}}
              onFocus={() => {
                setSelectedId(p.ptyId)
                switchView('focus')
              }}
            />
          ))}
        </div>
      ) : (
      <div className="main">
        <aside className="roster">
          {startingPtys.map((p) => (
            <button
              key={p.ptyId}
              className={`card${selectedId === p.ptyId ? ' selected' : ''}`}
              data-state="busy"
              onClick={() => {
                setSelectedId(p.ptyId)
                setShowInfo(false)
              }}
            >
              <span className="rail" />
              <span className="card-body">
                <span className="card-top">
                  <span className="card-name">{p.cwd.split(/[\\/]/).pop() || 'new clone'}</span>
                  <span className="state-word" data-state="busy">
                    CLONING
                  </span>
                </span>
                <span className="card-activity">
                  <span className="caret">▸</span>Growing clone… roger roger.
                </span>
              </span>
            </button>
          ))}
          {snap.instances.length === 0 && startingPtys.length === 0 ? (
            <div className="roster-empty">
              No clones in production.
              <br />
              Commission one with “+ Commission clone”, or start one in any terminal and it appears here.
            </div>
          ) : (
            snap.instances.map((inst: Instance) => (
              <InstanceCard
                key={inst.sessionId}
                instance={inst}
                now={now}
                selected={inst.sessionId === selectedId}
                prStatus={prStatus}
                onSelect={() => {
                  setSelectedId(inst.sessionId)
                  setShowInfo(false)
                }}
              />
            ))
          )}
        </aside>

        <section className={showTerminal ? 'workspace' : 'detail'}>
          {selectedPty && (
            <div className="workspace-bar hud">
              <div className="hud-row">
                <span className="workspace-name">
                  {selectedInstance?.name ?? 'growing…'}
                  {selectedInstance && (
                    <span className="state-pill" data-state={selectedInstance.state}>
                      {STATE_WORD[selectedInstance.state]}
                    </span>
                  )}
                  {selectedInstance && (
                    <span className="hud-elapsed">
                      {selectedInstance.state === 'busy' && selectedInstance.now.turnStartedAt
                        ? elapsed(selectedInstance.now.turnStartedAt, now)
                        : agoShort(selectedInstance.lastActiveAt, now)}
                    </span>
                  )}
                </span>
                {selectedInstance?.now.title && (
                  <span className="hud-title" title={selectedInstance.now.title}>
                    {selectedInstance.now.title}
                  </span>
                )}
                <span className="topbar-spacer" />
                {selectedInstance && (
                  <div className="view-toggle" title="F2 to switch">
                    <button
                      className={`view-btn${!showInfo ? ' active' : ''}`}
                      onClick={() => setShowInfo(false)}
                    >
                      ⌨ Terminal
                    </button>
                    <button
                      className={`view-btn${showInfo ? ' active' : ''}`}
                      onClick={() => setShowInfo(true)}
                    >
                      ✦ Intel
                    </button>
                  </div>
                )}
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (await window.fleet.confirm('Decommission this clone?', 'Unsaved work in its turn is lost.')) {
                      window.fleet.ptyKill(selectedPty.ptyId)
                    }
                  }}
                >
                  Decommission
                </button>
              </div>
              {selectedInstance && (
                <div className="hud-row sub">
                  <span className="workspace-activity">
                    <span className="caret">▸</span>
                    {selectedInstance.now.activity}
                  </span>
                  <span className="topbar-spacer" />
                  {selectedInstance.recent.prs.slice(-3).map((pr) => {
                    const badge = prBadge(prStatus[pr.url])
                    return (
                      <button
                        key={pr.url}
                        className="pane-chip pr"
                        title={badge ? `${badge.title} — click to open` : 'Open PR'}
                        onClick={() => window.fleet.openExternal(pr.url)}
                      >
                        PR #{pr.number}
                        {badge && (
                          <span className="pr-glyph" data-tone={badge.tone}>
                            {badge.glyph}
                          </span>
                        )}
                      </button>
                    )
                  })}
                  {selectedInstance.recent.prs.length > 3 && (
                    <span
                      className="pane-chip"
                      title={selectedInstance.recent.prs.map((p) => `#${p.number}`).join(' ')}
                    >
                      +{selectedInstance.recent.prs.length - 3}
                    </span>
                  )}
                  {selectedInstance.now.queued.length > 0 && (
                    <span className="pane-chip queue">⧗ {selectedInstance.now.queued.length} queued</span>
                  )}
                </div>
              )}
              {selectedInstance && (
                <div className="hud-row sub">
                  <span className="hud-meta">
                    <span>{KIND_WORD[selectedInstance.kind] ?? selectedInstance.kind}</span>
                    <span>
                      {selectedInstance.repo}
                      {selectedInstance.gitBranch ? ` · ${selectedInstance.gitBranch}` : ''}
                    </span>
                    {selectedInstance.model && <span>{selectedInstance.model}</span>}
                    {selectedInstance.permissionMode && <span>{selectedInstance.permissionMode}</span>}
                    <span>{selectedInstance.recent.turns} turns</span>
                  </span>
                </div>
              )}
              {/* always rendered: if this row appeared only once text existed,
                  the terminal below would resize mid-typing and ConPTY's
                  forced redraw can mangle the CLI composer */}
              {selectedInstance && (
                <div className="hud-row sub">
                  <span className="hud-quote" title={selectedInstance.recent.lastPrompt}>
                    <span className="who">❯ you</span>{' '}
                    {selectedInstance.recent.lastPrompt || '—'}
                  </span>
                  <span className="hud-quote" title={selectedInstance.recent.lastAssistantText}>
                    <span className="who">✦ clone</span>{' '}
                    {selectedInstance.recent.lastAssistantText || '—'}
                  </span>
                </div>
              )}
            </div>
          )}
          {showTerminal ? (
            <TerminalView ptyId={selectedPty.ptyId} />
          ) : selectedInstance ? (
            <DetailPanel
              instance={selectedInstance}
              now={now}
              adoptPending={selectedInstance.sessionId in pendingAdopt}
              prStatus={prStatus}
              onAdopt={() =>
                setPendingAdopt((m) => ({
                  ...m,
                  [selectedInstance.sessionId]: { cwd: selectedInstance.cwd }
                }))
              }
            />
          ) : (
            <div className="detail-empty">
              <div className="big">KAMINO</div>
              <div>Select a clone to see what it&apos;s doing</div>
              <div className="jedi-quote">{jediQuote(1)}</div>
            </div>
          )}
        </section>
      </div>
      )}

      {showLaunch && <LaunchDialog onClose={() => setShowLaunch(false)} onLaunched={onLaunched} />}
      {showWrapup && <WrapupDialog onClose={() => setShowWrapup(false)} />}
    </div>
  )
}
