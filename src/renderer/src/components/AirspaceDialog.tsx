import { useCallback, useEffect, useState } from 'react'
import type {
  AirspaceState,
  ArbiterCase,
  ArbiterState,
  DeconflictEvent,
  DeconflictMode
} from '../../../shared/types'
import { agoShort } from '../format'

/**
 * Airspace control — what Kamino does when two clones share a folder and one is
 * about to run a git command that would bury or destroy the other's in-flight
 * work. Warn-only is the default: it logs what it would have stopped so you can
 * see whether this actually happens in your fleet before anything is enforced.
 */

const MODES: Array<{ mode: DeconflictMode; title: string; body: string }> = [
  {
    mode: 'off',
    title: 'Stood down',
    body: 'No interception at all. Clones can stage and destroy each other’s work freely.'
  },
  {
    mode: 'warn',
    title: 'Warn only',
    body:
      'Logs every collision it sees but lets the command run. Start here — a week of real traffic tells you whether enforcing is worth it.'
  },
  {
    mode: 'enforce',
    title: 'Enforce',
    body:
      'Denies the command and tells the clone why, so it stages only its own files instead. This is the setting that actually prevents lost work.'
  }
]

const RISK_WORD: Record<string, string> = {
  'stage-all': 'would have committed their work',
  destructive: 'would have destroyed their changes'
}

const STAGE_WORD: Record<ArbiterCase['stage'], string> = {
  gathering: 'READING TREE',
  dispatched: 'DISPATCHED',
  working: 'ARBITRATING',
  resolved: 'SETTLED',
  escalated: 'YOURS',
  failed: 'FAILED'
}

export function AirspaceDialog(props: { onClose: () => void; now: number }): React.JSX.Element {
  const [state, setState] = useState<AirspaceState | null>(null)
  const [arb, setArb] = useState<ArbiterState | null>(null)

  const refresh = useCallback(() => {
    window.fleet.airspaceGet().then(setState)
    window.fleet.arbiterGet().then(setArb)
  }, [])
  // claims and contested files change as clones work — poll while open so the
  // panel is worth leaving on a second monitor
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [refresh])

  // live: a collision while the panel is open lands straight in the log
  useEffect(() => {
    return window.fleet.onAirspaceEvent((ev: DeconflictEvent) =>
      setState((s) => (s ? { ...s, events: [ev, ...s.events].slice(0, 200) } : s))
    )
  }, [])

  // an arbitration in progress is worth watching in real time — the case
  // arrives repeatedly as it moves through its stages, keyed by id
  useEffect(() => {
    return window.fleet.onArbiterCase((c: ArbiterCase) =>
      setArb((s) => {
        if (!s) return s
        const cases = s.cases.some((x) => x.id === c.id)
          ? s.cases.map((x) => (x.id === c.id ? c : x))
          : [c, ...s.cases].slice(0, 100)
        return { ...s, cases }
      })
    )
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  function setMode(mode: DeconflictMode): void {
    setState((s) => (s ? { ...s, mode } : s))
    void window.fleet.airspaceSetMode(mode)
  }

  function setArbiter(enabled: boolean): void {
    setArb((s) => (s ? { ...s, settings: { ...s.settings, enabled } } : s))
    void window.fleet.arbiterSet({ enabled }).then(() => refresh())
  }

  const events = state?.events ?? []
  const claims = state?.claims ?? []
  const contested = state?.contested ?? []
  const wouldHave = events.filter((e) => !e.denied).length

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal airspace" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs">
          <span className="modal-tab active">AIRSPACE CONTROL</span>
          <button className="modal-close" onClick={props.onClose}>
            ✕ esc
          </button>
        </div>

        <div className="modal-body">
          <div className="airspace-intro">
            When two clones share a folder, one running <code>git add -A</code> commits the
            other&apos;s half-finished work into its own branch — and{' '}
            <code>git checkout</code>, <code>reset --hard</code> or <code>stash</code> simply
            destroy it. A clone can&apos;t defend against this: it has no way to tell a sibling&apos;s
            edits from your own stray changes. Kamino can, so it answers the CLI before those
            commands run.
          </div>

          <div className="airspace-scoreboard">
            <span className="airspace-stat">
              <b>{state?.prevented ?? 0}</b> collisions stopped
            </span>
            <span className="airspace-stat soft">
              <b>{wouldHave}</b> logged but allowed
            </span>
            <span className="airspace-stat soft">
              <b>{claims.length}</b> clones with work in flight
            </span>
            <span className="airspace-stat soft">
              <b>{contested.length}</b> contested files
            </span>
          </div>

          <div className="airspace-modes">
            {MODES.map((m) => (
              <label
                key={m.mode}
                className={`airspace-mode${state?.mode === m.mode ? ' active' : ''}`}
                onClick={() => setMode(m.mode)}
              >
                <span className="airspace-mode-head">
                  <input type="radio" checked={state?.mode === m.mode} readOnly />
                  {m.title}
                </span>
                <span className="airspace-mode-body">{m.body}</span>
              </label>
            ))}
          </div>

          <div className="airspace-section">
            THE ARBITER
            <span className="airspace-section-note">
              what happens after a collision is stopped — because stopping one and then handing the
              decision to you is only half a job
            </span>
          </div>
          <label
            className={`arbiter-toggle${arb?.settings.enabled ? ' active' : ''}`}
            onClick={() => setArbiter(!arb?.settings.enabled)}
          >
            <input type="checkbox" checked={arb?.settings.enabled ?? false} readOnly />
            <span className="arbiter-toggle-body">
              <span className="arbiter-toggle-title">
                Dispatch an arbiter to settle it
                {arb && (
                  <>
                    {' '}
                    · <b>{arb.resolved}</b> settled without you · <b>{arb.escalated}</b> came back
                  </>
                )}
              </span>
              <span className="arbiter-toggle-note">
                Kamino spawns a third clone in that folder — badged{' '}
                <b style={{ color: 'var(--violet)' }}>⚖ ARBITER</b> and skinned so it can&apos;t be
                mistaken for one of yours. It sees both clones&apos; tasks, the whole working tree and
                who touched what, works out whether the collision is one file with two authors, two
                files doing one job, or a false alarm, then stages the right side and sends the
                blocked clone on its way. It never commits, never runs destructive git, and never
                deletes a sibling&apos;s work. Any doubt at all and it stops and asks you instead —
                that&apos;s the setting, and it&apos;s deliberate.
              </span>
              {arb?.settings.enabled && state?.mode !== 'enforce' && (
                <span className="arbiter-toggle-note" style={{ color: 'var(--amber)' }}>
                  Nothing will dispatch while airspace is on {state?.mode === 'off' ? 'stood down' : 'warn only'}.
                  An arbiter only ever follows a real denial — switch to Enforce above.
                </span>
              )}
              <span className="arbiter-toggle-note" style={{ color: 'var(--faint)' }}>
                It runs with permissions bypassed, or it would stall on a prompt for{' '}
                <code>git diff</code>. What bounds it is its standing orders, which forbid commit,
                checkout, reset, stash, clean, rebase and push outright.
              </span>
            </span>
          </label>

          {arb && arb.cases.length > 0 && (
            <>
              <div className="airspace-section">ARBITRATIONS</div>
              <div className="arbiter-cases">
                {arb.cases.map((c) => (
                  <div key={c.id} className="arbiter-case" data-stage={c.stage}>
                    <span className="arbiter-stage">{STAGE_WORD[c.stage]}</span>
                    <span className="arbiter-case-body">
                      <span className="arbiter-case-top">
                        <b>{c.blockedClone}</b> ran <code>{c.command}</code> in {c.repo}
                        {c.siblings.length > 0 && <> · against {c.siblings.join(', ')}</>}
                      </span>
                      {c.summary && <span className="arbiter-case-sub">{c.summary}</span>}
                      {c.action && <span className="arbiter-case-sub">{c.action}</span>}
                      {c.error && (
                        <span className="arbiter-case-question">{c.error}</span>
                      )}
                      {c.question && <span className="arbiter-case-question">{c.question}</span>}
                      {c.options && c.options.length > 0 && (
                        <span className="arbiter-case-options">
                          {c.options.map((o, i) => (
                            <span key={i} className="arbiter-case-option">
                              {o}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="arbiter-case-ago">{agoShort(c.at, props.now)} ago</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {claims.length > 0 && (
            <>
              <div className="airspace-section">WORK IN FLIGHT</div>
              <div className="airspace-claims">
                {claims.map((c) => (
                  <div key={c.sessionId} className="airspace-claim">
                    <span className="airspace-claim-name">{c.name}</span>
                    <span className="airspace-claim-files" title={c.files.join('\n')}>
                      {c.files.map((f) => f.split(/[\\/]/).pop()).join(' · ') || 'no edits yet'}
                    </span>
                    <span className="airspace-claim-ago">{agoShort(c.lastEditAt, props.now)} ago</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="airspace-section">
            CONTESTED FILES
            <span className="airspace-section-note">
              edited by more than one clone in the last hour — nothing is blocked over this, it just
              shows you where your clones keep meeting
            </span>
          </div>
          {contested.length === 0 ? (
            <div className="airspace-empty">
              No overlap. Your clones are working on genuinely separate files — no reason to split
              them into worktrees or hand out narrower lanes.
            </div>
          ) : (
            <div className="airspace-contested">
              {contested.map((c) => (
                <div key={c.file} className="airspace-contest" data-hot={c.clones.length > 2 ? 'yes' : 'no'}>
                  <span className="airspace-contest-file" title={c.file}>
                    {c.file.split(/[\\/]/).slice(-2).join('/')}
                  </span>
                  <span className="airspace-contest-clones">
                    {c.clones.map((cl) => (
                      <span key={cl.sessionId} className="airspace-contest-clone">
                        {cl.name}
                        <span className="airspace-contest-edits">×{cl.edits}</span>
                      </span>
                    ))}
                  </span>
                  <span className="airspace-claim-ago">{agoShort(c.lastAt, props.now)} ago</span>
                </div>
              ))}
            </div>
          )}

          <div className="airspace-section">COLLISION LOG</div>
          {events.length === 0 ? (
            <div className="airspace-empty">
              Nothing yet. Either your clones stay out of each other&apos;s way, or they haven&apos;t
              shared a folder — both good news.
            </div>
          ) : (
            <div className="airspace-log">
              {events.map((ev) => (
                <div key={ev.id} className={`airspace-row${ev.denied ? ' denied' : ''}`}>
                  <span className="airspace-row-glyph">{ev.denied ? '⛔' : '⚠'}</span>
                  <span className="airspace-row-body">
                    <span className="airspace-row-top">
                      <b>{ev.cloneName}</b> ran <code>{ev.command}</code>
                    </span>
                    <span className="airspace-row-sub">
                      {ev.denied ? 'Denied — it ' : 'Allowed — it '}
                      {RISK_WORD[ev.risk] ?? 'risked their work'} ({ev.siblings.join(', ')})
                      {ev.siblingFiles.length > 0 &&
                        ` · ${ev.siblingFiles.map((f) => f.split(/[\\/]/).pop()).join(', ')}`}
                    </span>
                  </span>
                  <span className="airspace-row-ago">{agoShort(ev.at, props.now)} ago</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-body modal-actions">
          <span className="airspace-hint">
            Guards git only — file edits already protect themselves, since the CLI refuses an edit
            whose file moved underneath it. Contested files are tracked in every mode, since
            watching costs nothing.
          </span>
          <button className="btn" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>
    </div>
  )
}
