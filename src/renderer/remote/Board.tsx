import { useState } from 'react'
import type { RemoteFleetState, RemoteInstance, RemotePty } from '../../shared/types'
import { agoShort, elapsed, prBadge, stateWord } from '../src/format'
import type { Link } from './api'
import { LinkLamp } from './PhoneApp'

/**
 * The board: whoever is waiting on you first, then the ones working, then
 * the idle. Thumb-reach Commission button pinned to the bottom.
 */

const ORDER: Record<string, number> = { 'needs-you': 0, busy: 1, idle: 2, dead: 3 }

export function Board(props: {
  state: RemoteFleetState | null
  link: Link
  now: number
  onOpen: (key: string) => void
  onCommission: () => void
  onReconnect: () => void
}): React.JSX.Element {
  const { state, now } = props
  const [showDead, setShowDead] = useState(false)

  const all = state?.instances ?? []
  const live = all
    .filter((i) => i.state !== 'dead')
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.lastActiveAt - a.lastActiveAt)
  const dead = all.filter((i) => i.state === 'dead').sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  const growing = (state?.ptys ?? []).filter((p) => !p.bound)
  const counts = { 'needs-you': 0, busy: 0, idle: 0 }
  for (const i of live) if (i.state in counts) counts[i.state as keyof typeof counts]++

  return (
    <div className="screen">
      <header className="bar board-bar">
        <div className="brand">
          <span className="brand-word">KAMINO</span>
          <span className="brand-host">{state?.host ?? '…'}</span>
        </div>
        <LinkLamp link={props.link} />
      </header>

      <div className="tally">
        <span className="tally-item" data-state="needs-you">
          <b>{counts['needs-you']}</b> awaiting
        </span>
        <span className="tally-item" data-state="busy">
          <b>{counts.busy}</b> engaged
        </span>
        <span className="tally-item" data-state="idle">
          <b>{counts.idle}</b> standing by
        </span>
      </div>

      <main className="scroll board">
        {props.link === 'offline' && (
          <button className="offline-note" onClick={props.onReconnect}>
            Lost the link to Kamino. Showing the last board seen. Tap to retry.
          </button>
        )}

        {!state && props.link !== 'offline' && <div className="empty">Reaching Kamino…</div>}

        {state && live.length === 0 && growing.length === 0 && (
          <div className="empty">
            No clones on the board.
            <br />
            Commission one below.
          </div>
        )}

        {growing.map((p) => (
          <GrowingCard key={p.ptyId} pty={p} onOpen={() => props.onOpen(p.ptyId)} />
        ))}
        {live.map((i) => (
          <CloneCard key={i.sessionId} inst={i} state={state!} now={now} onOpen={() => props.onOpen(i.sessionId)} />
        ))}

        {dead.length > 0 && (
          <button className="dead-toggle" onClick={() => setShowDead((v) => !v)}>
            {showDead ? '▾' : '▸'} {dead.length} decommissioned
          </button>
        )}
        {showDead &&
          dead.map((i) => (
            <CloneCard key={i.sessionId} inst={i} state={state!} now={now} onOpen={() => props.onOpen(i.sessionId)} />
          ))}
      </main>

      <footer className="dock">
        <button className="btn primary big" onClick={props.onCommission}>
          + Commission clone
        </button>
      </footer>
    </div>
  )
}

function CloneCard(props: {
  inst: RemoteInstance
  state: RemoteFleetState
  now: number
  onOpen: () => void
}): React.JSX.Element {
  const { inst, now } = props
  const n = inst.now
  const word = stateWord(inst.state, n.askKind)
  const tasks = inst.tasks
  const pr = inst.recent.prs[inst.recent.prs.length - 1]
  const badge = pr ? prBadge(props.state.pr[pr.url]) : null
  const ctx = inst.context ? Math.round(inst.context.pct * 100) : null
  const line = inst.state === 'needs-you' ? n.pendingAsk || n.activity : n.activity

  return (
    <button className="card" data-state={inst.state} onClick={props.onOpen}>
      <span className="rail" />
      <span className="card-main">
        <span className="card-top">
          <span className="card-name">{inst.name}</span>
          <span className="state-word" data-state={inst.state}>
            {word}
          </span>
        </span>
        <span className="card-where">
          {inst.repo}
          {inst.gitBranch ? ` · ${inst.gitBranch}` : ''}
          {!inst.ptyId && inst.state !== 'dead' && <span className="tag">view only</span>}
          {inst.arbiter && <span className="tag">arbiter</span>}
        </span>
        {n.title && <span className="card-title">{n.title}</span>}
        {line && <span className="card-activity">{line}</span>}
        <span className="card-foot">
          {tasks && tasks.total > 0 && (
            <span className="mini-track" title={`${tasks.completed}/${tasks.total} tasks`}>
              <span className="mini-track-fill" style={{ width: `${(tasks.completed / tasks.total) * 100}%` }} />
              <span className="mini-track-label">
                {tasks.completed}/{tasks.total}
              </span>
            </span>
          )}
          {pr && (
            <span className="pr-chip" data-tone={badge?.tone ?? 'open'}>
              {badge?.glyph ?? '○'} #{pr.number}
            </span>
          )}
          {ctx !== null && <span className={`ctx${ctx >= 80 ? ' hot' : ''}`}>{ctx}% ctx</span>}
          <span className="card-ago">
            {inst.state === 'busy' && n.turnStartedAt
              ? elapsed(n.turnStartedAt, now)
              : `${agoShort(inst.lastActiveAt, now)} ago`}
          </span>
        </span>
      </span>
    </button>
  )
}

function GrowingCard({ pty, onOpen }: { pty: RemotePty; onOpen: () => void }): React.JSX.Element {
  const folder = pty.cwd.split(/[\\/]/).filter(Boolean).pop() ?? pty.cwd
  return (
    <button className="card" data-state="growing" onClick={onOpen}>
      <span className="rail" />
      <span className="card-main">
        <span className="card-top">
          <span className="card-name">New clone</span>
          <span className="state-word" data-state="busy">
            GROWING…
          </span>
        </span>
        <span className="card-where">{folder}</span>
        <span className="card-activity">Starting up. Tap to watch its screen.</span>
      </span>
    </button>
  )
}
