import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FleetSnapshot, Instance } from '../../shared/types'
import { InstanceCard } from './components/InstanceCard'
import { DetailPanel } from './components/DetailPanel'
import { TerminalView } from './components/TerminalView'
import { LaunchDialog } from './components/LaunchDialog'
import { GridPane } from './components/GridPane'
import { STATE_WORD } from './format'

type ViewMode = 'grid' | 'focus'
type Theme = 'light' | 'dark'

interface PtyRef {
  ptyId: string
  pid: number
  cwd: string
}

export default function App(): React.JSX.Element {
  const [snap, setSnap] = useState<FleetSnapshot>({ instances: [], updatedAt: 0 })
  const [selectedId, setSelectedId] = useState<string | null>(null) // sessionId or ptyId
  const [now, setNow] = useState(Date.now())
  const [ptyRefs, setPtyRefs] = useState<PtyRef[]>([])
  const [showLaunch, setShowLaunch] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [view, setView] = useState<ViewMode>(
    () => (localStorage.getItem('fleet:view') as ViewMode) || 'grid'
  )
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('fleet:theme') as Theme) || 'light'
  )

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

  useEffect(() => {
    window.fleet.getFleet().then(setSnap)
    window.fleet.ptyList().then(setPtyRefs) // survive renderer reloads
    window.fleet.hooksStatus().then(setHooksOk)
    const offFleet = window.fleet.onFleet(setSnap)
    const offExit = window.fleet.onPtyExit(() => window.fleet.ptyList().then(setPtyRefs))
    const offSelect = window.fleet.onSelectSession((sessionId) => {
      setSelectedId(sessionId)
      setShowInfo(false)
    })
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      offFleet()
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

  function executeOrder66(): void {
    const targets = snap.instances.filter((i) => i.state !== 'dead')
    const n = targets.length + startingPtys.length
    if (n === 0) return
    if (
      !confirm(
        `Execute Order 66?\n\nAll ${n} clone${n === 1 ? '' : 's'} on this board will be terminated — embedded, outside terminals, and background sessions alike.\n\nGood soldiers follow orders.`
      )
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
            title="Terminate every clone on the board"
            onClick={executeOrder66}
          >
            Order 66
          </button>
        )}
        <button className="btn primary new-btn" onClick={() => setShowLaunch(true)}>
          + Commission clone
        </button>
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
        <div className="grid-view">
          {snap.instances.length === 0 && startingPtys.length === 0 && (
            <div className="detail-empty">
              <div className="big">KAMINO</div>
              <div>The facility is quiet. Commission a clone with “+ Commission clone”, or start one in any terminal</div>
            </div>
          )}
          {startingPtys.map((p) => (
            <GridPane
              key={p.ptyId}
              instance={null}
              ptyId={p.ptyId}
              now={now}
              adoptPending={false}
              onAdopt={() => {}}
              onFocus={() => {
                setSelectedId(p.ptyId)
                switchView('focus')
              }}
            />
          ))}
          {snap.instances
            .filter((i) => i.state !== 'dead') // ended sessions live in Resume, not the wall
            .map((inst) => (
              <GridPane
                key={inst.sessionId}
                instance={inst}
                ptyId={ptyByPid.get(inst.pid)?.ptyId ?? null}
                now={now}
                adoptPending={inst.sessionId in pendingAdopt}
                onAdopt={() => setPendingAdopt((m) => ({ ...m, [inst.sessionId]: { cwd: inst.cwd } }))}
                onFocus={() => {
                  setSelectedId(inst.sessionId)
                  setShowInfo(false)
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
            <div className="workspace-bar">
              <span className="workspace-name">
                {selectedInstance?.name ?? 'growing…'}
                {selectedInstance && (
                  <span className="state-pill" data-state={selectedInstance.state}>
                    {STATE_WORD[selectedInstance.state]}
                  </span>
                )}
              </span>
              <span className="workspace-activity">{selectedInstance?.now.activity ?? ''}</span>
              <span className="topbar-spacer" />
              {selectedInstance && (
                <button className="btn" onClick={() => setShowInfo((v) => !v)}>
                  {showInfo ? 'Terminal' : 'Info'}
                </button>
              )}
              <button
                className="btn danger"
                onClick={() => {
                  if (confirm('Decommission this clone? Unsaved work in its turn is lost.')) {
                    window.fleet.ptyKill(selectedPty.ptyId)
                  }
                }}
              >
                Decommission
              </button>
            </div>
          )}
          {showTerminal ? (
            <TerminalView ptyId={selectedPty.ptyId} />
          ) : selectedInstance ? (
            <DetailPanel
              instance={selectedInstance}
              now={now}
              adoptPending={selectedInstance.sessionId in pendingAdopt}
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
            </div>
          )}
        </section>
      </div>
      )}

      {showLaunch && <LaunchDialog onClose={() => setShowLaunch(false)} onLaunched={onLaunched} />}
    </div>
  )
}
