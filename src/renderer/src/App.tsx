import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FleetSnapshot, Instance } from '../../shared/types'
import { InstanceCard } from './components/InstanceCard'
import { DetailPanel } from './components/DetailPanel'
import { TerminalView } from './components/TerminalView'
import { LaunchDialog } from './components/LaunchDialog'
import { STATE_WORD } from './format'

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

  const showTerminal = selectedPty && !showInfo

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          <span className="claude">CLAUDE</span> FLEET
        </div>
        <div className="fleet-counts">
          <span className="count">
            <span className="count-dot" style={{ background: 'var(--sage)' }} />
            {live} live
          </span>
          <span className="count">
            <span className="count-dot" style={{ background: 'var(--amber)' }} />
            {counts.busy} working
          </span>
          {counts['needs-you'] > 0 && (
            <span className="count needs-you">
              <span className="count-dot" style={{ background: 'var(--coral)' }} />
              {counts['needs-you']} need you
            </span>
          )}
        </div>
        <div className="topbar-spacer" />
        <button className="btn primary new-btn" onClick={() => setShowLaunch(true)}>
          + New instance
        </button>
        <div className="topbar-clock">
          {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </header>

      {!hooksOk && (
        <div className="hooks-banner">
          Alerts are off — Fleet can&apos;t tell when an instance is waiting on you.
          <button
            className="btn primary"
            onClick={async () => {
              await window.fleet.hooksInstall()
              setHooksOk(await window.fleet.hooksStatus())
            }}
          >
            Enable alerts
          </button>
          <span className="hooks-note">adds Notification/Stop hooks to ~/.claude/settings.json — applies to newly started instances</span>
        </div>
      )}

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
                  <span className="card-name">{p.cwd.split(/[\\/]/).pop() || 'new instance'}</span>
                  <span className="state-word" data-state="busy">
                    STARTING
                  </span>
                </span>
                <span className="card-activity">
                  <span className="caret">▸</span>Launching Claude Code…
                </span>
              </span>
            </button>
          ))}
          {snap.instances.length === 0 && startingPtys.length === 0 ? (
            <div className="roster-empty">
              No Claude Code instances found.
              <br />
              Launch one with “+ New instance”, or start one in any terminal and it appears here.
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
                {selectedInstance?.name ?? 'starting…'}
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
                  if (confirm('Kill this instance? Unsaved work in its turn is lost.')) {
                    window.fleet.ptyKill(selectedPty.ptyId)
                  }
                }}
              >
                Kill
              </button>
            </div>
          )}
          {showTerminal ? (
            <TerminalView ptyId={selectedPty.ptyId} />
          ) : selectedInstance ? (
            <DetailPanel instance={selectedInstance} now={now} />
          ) : (
            <div className="detail-empty">
              <div className="big">CLAUDE FLEET</div>
              <div>Select an instance to see what it&apos;s doing</div>
            </div>
          )}
        </section>
      </div>

      {showLaunch && <LaunchDialog onClose={() => setShowLaunch(false)} onLaunched={onLaunched} />}
    </div>
  )
}
