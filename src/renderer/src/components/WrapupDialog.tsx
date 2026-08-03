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

export function WrapupDialog(props: { onClose: () => void }): React.JSX.Element {
  const [report, setReport] = useState<WrapupReport | null>(null)
  const [busy, setBusy] = useState(false)

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
            Read-only sweep — tell the clone itself to commit/push/raise the PR.
          </span>
          <button className="btn" onClick={sweep} disabled={busy}>
            {busy ? 'Sweeping…' : 'Sweep again'}
          </button>
        </div>
      </div>
    </div>
  )
}
