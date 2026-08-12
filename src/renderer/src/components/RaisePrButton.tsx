import { useEffect, useRef, useState } from 'react'
import type { Instance } from '../../../shared/types'

/**
 * The other half of the always-there PR button: shown when a clone has no PR
 * yet, in the same slot the status chip will take over. One click pushes the
 * branch, raises the PR (or finds the one that already exists on GitHub), and
 * opens it in the browser ready to review and merge.
 */
export function RaisePrButton(props: {
  sessionId: string
  /** 'chip' = pane strip / focus HUD; 'row' = detail-panel PR list */
  variant: 'chip' | 'row'
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // the raise outlives fast unmounts (pane re-sorts, view switches)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function raise(e: React.MouseEvent): Promise<void> {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    setErr(null)
    const res = await window.fleet.createPr(props.sessionId)
    if (res.ok && res.url) window.fleet.openExternal(res.url)
    if (!alive.current) return
    setBusy(false)
    if (!res.ok) setErr(res.error ?? 'could not raise a PR')
  }

  const title = busy
    ? 'Pushing the branch and raising the PR…'
    : err
      ? `${err} — click to retry`
      : 'No PR yet — push this branch, raise the PR, and open it ready to merge'
  return (
    <button
      className={props.variant === 'chip' ? 'pane-chip pr pr-raise' : 'pr-link pr-raise'}
      data-busy={busy ? 'yes' : undefined}
      data-err={!busy && err ? 'yes' : undefined}
      title={title}
      onClick={raise}
    >
      {busy ? '◌ raising…' : err ? '⇱ PR failed — retry' : '⇱ Raise PR'}
    </button>
  )
}

/** One rule for every surface: the button appears wherever a PR could exist —
 *  alive, yours (not an arbiter), and on a branch there is something to merge
 *  from. On main/master there is nothing to raise, so no button. */
export function canRaisePr(inst: Instance): boolean {
  return (
    inst.state !== 'dead' &&
    !inst.arbiter &&
    !!inst.gitBranch &&
    !['main', 'master'].includes(inst.gitBranch)
  )
}
