import { useCallback, useEffect, useState } from 'react'
import type { HyperdriveEvent, HyperdriveState } from '../../../shared/types'
import { agoShort } from '../format'

/**
 * Hyperdrive — the switches for automatic fixes. Both behaviours ship OFF, and
 * the panel shows the exact orders each one will send, because an automation
 * that types into your terminals should never be a surprise.
 */

const OUTCOME_WORD: Record<string, string> = {
  sent: 'orders sent',
  blocked: 'held',
  exhausted: 'out of attempts — yours now'
}

export function HyperdriveDialog(props: { onClose: () => void; now: number }): React.JSX.Element {
  const [state, setState] = useState<HyperdriveState | null>(null)

  const refresh = useCallback(() => {
    window.fleet.hyperdriveGet().then(setState)
  }, [])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    return window.fleet.onHyperdriveEvent((ev: HyperdriveEvent) =>
      setState((s) => (s ? { ...s, events: [ev, ...s.events].slice(0, 200) } : s))
    )
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  const s = state?.settings
  const events = state?.events ?? []
  const pending = state?.pending ?? []
  const engaged = !!(s?.ci || s?.conflict)

  function toggle(key: 'ci' | 'conflict', value: boolean): void {
    setState((prev) => (prev ? { ...prev, settings: { ...prev.settings, [key]: value } } : prev))
    void window.fleet.hyperdriveSet({ [key]: value })
  }

  function setAttempts(n: number): void {
    setState((prev) => (prev ? { ...prev, settings: { ...prev.settings, maxAttempts: n } } : prev))
    void window.fleet.hyperdriveSet({ maxAttempts: n })
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal hyperdrive" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs">
          <span className="modal-tab active">HYPERDRIVE</span>
          <span className={`hd-lamp${engaged ? ' on' : ''}`}>{engaged ? 'ENGAGED' : 'STANDING BY'}</span>
          <button className="modal-close" onClick={props.onClose}>
            ✕ esc
          </button>
        </div>

        <div className="modal-body">
          <div className="hd-intro">
            A clone ends its turn the moment it opens a PR, but CI takes minutes — so by the time the
            checks go red the clone is idle and nothing wakes it. With several clones shipping into
            one repo it&apos;s worse: the first PR to merge leaves the rest unmergeable, and they all
            just sit there. Hyperdrive sends them back in.
            <br />
            <br />
            Both triggers are facts reported by GitHub, never guesses about what a clone is
            &ldquo;probably&rdquo; doing — so it can&apos;t interrupt a clone that was working fine.
          </div>

          <div className="hd-switches">
            <label className={`hd-switch${s?.ci ? ' on' : ''}`}>
              <span className="hd-switch-head">
                <input type="checkbox" checked={!!s?.ci} onChange={(e) => toggle('ci', e.target.checked)} />
                <span className="hd-switch-title">Fix red CI</span>
              </span>
              <span className="hd-switch-body">
                When a PR&apos;s checks fail, the clone that raised it is told to get the failing
                logs, fix the real cause, and push — explicitly not to disable, skip or weaken the
                tests, and never to force-push. If it can&apos;t reproduce the failure it&apos;s told
                to stop and say so rather than guess.
              </span>
            </label>

            <label className={`hd-switch${s?.conflict ? ' on' : ''}`}>
              <span className="hd-switch-head">
                <input
                  type="checkbox"
                  checked={!!s?.conflict}
                  onChange={(e) => toggle('conflict', e.target.checked)}
                />
                <span className="hd-switch-title">Resolve merge conflicts</span>
              </span>
              <span className="hd-switch-body">
                When a branch stops merging into its base, the clone is told to merge the base back
                in and resolve — merge rather than rebase, never force-push, and keep{' '}
                <b>both</b> intents where they&apos;re compatible, because the other side is
                somebody else&apos;s finished work. A real design clash gets handed back to you
                instead.
              </span>
            </label>
          </div>

          <div className="hd-attempts">
            <span>Give up after</span>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                className={`view-btn${s?.maxAttempts === n ? ' active' : ''}`}
                onClick={() => setAttempts(n)}
              >
                {n}
              </button>
            ))}
            <span>
              attempt{s?.maxAttempts === 1 ? '' : 's'} per PR, then leave it to you. The budget
              resets if the PR comes good on its own.
            </span>
          </div>

          <div className="airspace-scoreboard">
            <span className="airspace-stat">
              <b>{state?.dispatched ?? 0}</b> fixes dispatched
            </span>
            <span className="airspace-stat soft">
              <b>{pending.length}</b> waiting on a reachable clone
            </span>
          </div>

          <div className="airspace-section">
            LOG
            <span className="airspace-section-note">
              every automatic action and every skip — an automation you can&apos;t audit is one you
              can&apos;t trust
            </span>
          </div>
          {events.length === 0 ? (
            <div className="airspace-empty">
              {engaged
                ? 'Nothing yet. It only acts on a PR going red or unmergeable while Kamino is watching — never on a failure that was already there when the app started.'
                : 'Standing by. Switch a behaviour on above and it starts watching your open PRs.'}
            </div>
          ) : (
            <div className="airspace-log">
              {events.map((ev) => (
                <div key={ev.id} className={`airspace-row${ev.outcome === 'sent' ? ' denied' : ''}`}>
                  <span className="airspace-row-glyph">
                    {ev.outcome === 'sent' ? '⚡' : ev.outcome === 'exhausted' ? '✋' : '⏸'}
                  </span>
                  <span className="airspace-row-body">
                    <span className="airspace-row-top">
                      <b>{ev.cloneName}</b> · PR #{ev.prNumber} ·{' '}
                      {ev.kind === 'ci' ? 'CI red' : 'conflicting'}
                    </span>
                    <span className="airspace-row-sub">
                      {OUTCOME_WORD[ev.outcome] ?? ev.outcome}
                      {ev.outcome === 'sent' && ` (attempt ${ev.attempt})`}
                      {ev.note && ` — ${ev.note}`}
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
            Orders go into the clone&apos;s own terminal, so you can read exactly what it was told
            and take over at any point. Clones running outside Kamino can&apos;t be reached — those
            show as held.
          </span>
          <button className="btn" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>
    </div>
  )
}
