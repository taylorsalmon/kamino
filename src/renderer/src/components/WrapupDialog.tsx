import { useCallback, useEffect, useState } from 'react'
import type { WrapupReport, WrapupRepo } from '../../../shared/types'

/** what would be stranded on this machine if you closed the lid right now */
function issues(r: WrapupRepo): string[] {
  if (r.error) return [r.error]
  const out: string[] = []
  if (r.dirty > 0) out.push(`${r.dirty} uncommitted file${r.dirty === 1 ? '' : 's'}`)
  if (r.noUpstream && r.branch !== '(detached)') out.push('branch never pushed')
  if (r.ahead > 0) out.push(`${r.ahead} unpushed commit${r.ahead === 1 ? '' : 's'}`)
  if (r.branch === '(detached)') out.push('detached HEAD')
  if (!r.defaultBranch && r.branch !== '(detached)' && !r.pr && !r.prError) out.push('no open PR')
  return out
}

/** the orders a clone gets when you hit "wrap up" — one line so it lands in
 *  the CLI composer as a single prompt (queued if the clone is mid-turn) */
const WRAPUP_ORDER =
  'End-of-shift wrap-up: commit all outstanding work in this repo with clear messages, push the branch, ' +
  'and open a PR (or update the existing one) describing where the work is up to. Get it to a state that ' +
  'could be merged to main — fix failing checks or lint if quick. Anything unfinished or known-broken goes ' +
  'in a Follow-ups section of the PR description (or as issues) so nothing is lost. Reply with the PR URL when done.'

/** an embedded clone Kamino can type into, working in this repo */
export interface WrapupTarget {
  ptyId: string
  name: string
}

export function WrapupDialog(props: {
  onClose: () => void
  /** repo cwd → dispatchable clone, or null (external/background clone) */
  resolveTarget: (repo: WrapupRepo) => WrapupTarget | null
}): React.JSX.Element {
  const [report, setReport] = useState<WrapupReport | null>(null)
  const [busy, setBusy] = useState(false)
  /** cwd → clone name the orders went to */
  const [sent, setSent] = useState<Record<string, string>>({})

  const sweep = useCallback(() => {
    setBusy(true)
    window.fleet
      .wrapupCheck()
      .then(setReport)
      .finally(() => setBusy(false))
  }, [])
  useEffect(sweep, [sweep])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  const rows = report?.repos ?? []
  const blocked = rows.filter((r) => issues(r).length > 0)
  const allClear = report && blocked.length === 0
  const dispatchable = blocked.filter((r) => !sent[r.cwd] && props.resolveTarget(r))

  function dispatch(r: WrapupRepo): void {
    const target = props.resolveTarget(r)
    if (!target) return
    window.fleet.ptyInput(target.ptyId, WRAPUP_ORDER + '\r')
    setSent((m) => ({ ...m, [r.cwd]: target.name }))
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal wrapup" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs">
          <span className="modal-tab active">END-OF-SHIFT SWEEP</span>
          <button className="modal-close" onClick={props.onClose}>
            ✕ esc
          </button>
        </div>
        <div className="modal-body">
          {!report ? (
            <div className="wrapup-verdict pending">Sweeping the fleet&apos;s repos…</div>
          ) : rows.length === 0 ? (
            <div className="wrapup-verdict ok">No live clones — nothing to check.</div>
          ) : allClear ? (
            <div className="wrapup-verdict ok">
              ✓ All clear. Every repo is committed, pushed, and on a PR (or main). Safe to power
              down.
            </div>
          ) : (
            <div className="wrapup-verdict warn">
              {blocked.length} of {rows.length} repo{rows.length === 1 ? '' : 's'} would strand
              work on this machine:
            </div>
          )}

          <div className="wrapup-list">
            {rows.map((r) => {
              const probs = issues(r)
              const target = props.resolveTarget(r)
              return (
                <div key={r.cwd} className={`wrapup-row${probs.length ? ' bad' : ''}`}>
                  <div className="wrapup-top">
                    <span className="wrapup-glyph">{probs.length ? '✗' : '✓'}</span>
                    <span className="wrapup-repo" title={r.cwd}>
                      {r.repo}
                    </span>
                    <span className="wrapup-branch">{r.branch}</span>
                    {r.pr && (
                      <button
                        className="pane-chip pr"
                        title={`${r.pr.title} — click to open`}
                        onClick={() => window.fleet.openExternal(r.pr!.url)}
                      >
                        PR #{r.pr.number}
                      </button>
                    )}
                    <span className="wrapup-clones" title={r.clones.join(', ')}>
                      {r.clones.join(' · ')}
                    </span>
                    {probs.length > 0 &&
                      (sent[r.cwd] ? (
                        <span className="wrapup-sent" title={`Wrap-up orders sent to ${sent[r.cwd]}`}>
                          ✓ orders sent
                        </span>
                      ) : (
                        <button
                          className="btn wrapup-send"
                          disabled={!target}
                          title={
                            target
                              ? `Tell ${target.name} to commit, push, raise/update the PR, and log follow-ups`
                              : "This clone runs outside Kamino — can't type into its terminal"
                          }
                          onClick={() => dispatch(r)}
                        >
                          ⚡ Wrap up
                        </button>
                      ))}
                  </div>
                  {probs.length > 0 && (
                    <div className="wrapup-issues">
                      {probs.map((p) => (
                        <span key={p} className="wrapup-issue">
                          {p}
                        </span>
                      ))}
                      {r.prError && (
                        <span className="wrapup-issue soft" title={r.prError}>
                          PR state unknown
                        </span>
                      )}
                    </div>
                  )}
                  {probs.length === 0 && r.prError && (
                    <div className="wrapup-issues">
                      <span className="wrapup-issue soft" title={r.prError}>
                        PR state unknown — gh unavailable
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        <div className="modal-body modal-actions">
          <span className="wrapup-hint">
            ⚡ Wrap up sends the orders straight into the clone&apos;s terminal — commit, push, PR,
            follow-ups. Sweep again to watch the list go green.
          </span>
          {dispatchable.length > 1 && (
            <button
              className="btn primary"
              title="Send wrap-up orders to every repo that still has one"
              onClick={() => dispatchable.forEach(dispatch)}
            >
              ⚡ Wrap up all ({dispatchable.length})
            </button>
          )}
          <button className="btn" onClick={sweep} disabled={busy}>
            {busy ? 'Sweeping…' : 'Sweep again'}
          </button>
        </div>
      </div>
    </div>
  )
}
