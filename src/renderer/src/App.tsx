import { useEffect, useMemo, useState } from 'react'
import type { FleetSnapshot, Instance } from '../../shared/types'
import { InstanceCard } from './components/InstanceCard'
import { DetailPanel } from './components/DetailPanel'

export default function App(): React.JSX.Element {
  const [snap, setSnap] = useState<FleetSnapshot>({ instances: [], updatedAt: 0 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    window.fleet.getFleet().then(setSnap)
    const off = window.fleet.onFleet(setSnap)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      off()
      clearInterval(tick)
    }
  }, [])

  const selected = useMemo(
    () => snap.instances.find((i) => i.sessionId === selectedId) ?? null,
    [snap, selectedId]
  )

  const counts = useMemo(() => {
    const c = { busy: 0, 'needs-you': 0, idle: 0, dead: 0 }
    for (const i of snap.instances) c[i.state]++
    return c
  }, [snap])

  const live = counts.busy + counts['needs-you'] + counts.idle

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
        <div className="topbar-clock">
          {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </header>

      <div className="main">
        <aside className="roster">
          {snap.instances.length === 0 ? (
            <div className="roster-empty">
              No Claude Code instances found.
              <br />
              Start one in any terminal and it appears here.
            </div>
          ) : (
            snap.instances.map((inst: Instance) => (
              <InstanceCard
                key={inst.sessionId}
                instance={inst}
                now={now}
                selected={inst.sessionId === selectedId}
                onSelect={() => setSelectedId(inst.sessionId)}
              />
            ))
          )}
        </aside>
        <section className="detail">
          {selected ? (
            <DetailPanel instance={selected} now={now} />
          ) : (
            <div className="detail-empty">
              <div className="big">CLAUDE FLEET</div>
              <div>Select an instance to see what it&apos;s doing</div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
