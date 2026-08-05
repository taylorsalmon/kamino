import { useEffect, useRef, useState } from 'react'
import type { HandoffProgress, Instance } from '../../../shared/types'
import { fmtTokens } from '../format'

/**
 * Reincarnation dialog — what to do about a clone whose memory is filling up.
 * Two ways out, both explained before you pick: transfer the working state to a
 * fresh clone, or let the CLI squash this one's history in place.
 *
 * Transfer runs itself once started — brief, successor, seed — and streams its
 * progress here so you can read the brief as the old clone writes it.
 */

const STAGE_LINE: Record<string, string> = {
  briefing: 'Clone is writing its handoff brief…',
  brief: 'Brief received. Commissioning the successor…',
  commissioning: 'Successor growing…',
  seeding: 'Handing the brief over…',
  done: 'Transfer complete.',
  error: 'Transfer failed.'
}

export function HandoffDialog(props: {
  instance: Instance
  /** null for a field-deployed clone — no input channel, so no transfer */
  ptyId: string | null
  onClose: () => void
  /** jump the user to the successor's terminal */
  onSuccessor: (ptyId: string, pid: number) => void
}): React.JSX.Element {
  const inst = props.instance
  const ctx = inst.context
  const pct = ctx ? Math.round(ctx.pct * 100) : 0
  const [progress, setProgress] = useState<HandoffProgress | null>(null)
  const [killOld, setKillOld] = useState(true)
  const [compacted, setCompacted] = useState(false)
  const briefRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const off = window.fleet.onHandoff((p) => {
      if (p.sessionId !== inst.sessionId) return
      setProgress(p)
      // announce the successor as soon as it spawns, so its pane appears on the
      // board and you can watch it grow rather than waiting for the seed
      if ((p.stage === 'commissioning' || p.stage === 'done') && p.successor) {
        props.onSuccessor(p.successor.ptyId, p.successor.pid)
      }
    })
    return off
  }, [inst.sessionId, props.onSuccessor])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  // keep the newest lines of the streaming brief in view
  useEffect(() => {
    const el = briefRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [progress?.brief])

  const running = progress !== null && progress.stage !== 'done' && progress.stage !== 'error'
  const finished = progress?.stage === 'done'

  function startTransfer(): void {
    setProgress({ sessionId: inst.sessionId, stage: 'briefing' })
    void window.fleet.handoffStart(inst.sessionId, killOld)
  }

  function compactNow(): void {
    setCompacted(true)
    void window.fleet.handoffCompact(inst.sessionId)
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal handoff" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs">
          <span className="modal-tab active">CONTEXT ROT — {inst.name}</span>
          <button className="modal-close" onClick={props.onClose}>
            ✕ esc
          </button>
        </div>

        <div className="modal-body">
          <div className="handoff-gauge" data-hot={pct >= 85 ? 'yes' : 'no'}>
            <span className="handoff-pct">{pct}% full</span>
            {ctx && (
              <span className="handoff-tokens">
                {fmtTokens(ctx.tokens)} / {fmtTokens(ctx.window)}
                {ctx.compactions > 0 &&
                  ` · already compacted ${ctx.compactions}×`}
              </span>
            )}
          </div>

          {!progress && !compacted && (
            <>
              <div className="handoff-intro">
                At ~100% Claude Code compacts on its own: it squashes this conversation into a
                summary you never see, at a moment you don&apos;t choose, and the details rot away.
                Get ahead of it.
              </div>

              <div className="handoff-choice">
                <div className="handoff-option">
                  <div className="handoff-option-head">
                    <span className="handoff-option-title">✦ Transfer knowledge</span>
                    <span className="handoff-option-tag">recommended</span>
                  </div>
                  <div className="handoff-option-body">
                    This clone writes a handoff brief — goal, what&apos;s done, where it&apos;s up
                    to, next steps, decisions already made, gotchas, files to read. Kamino then
                    commissions a fresh clone in <b>{inst.repo}</b> and hands the brief straight to
                    it. The successor starts on an empty context window and re-reads the repo, so
                    anything the brief missed is still recoverable from disk.
                  </div>
                  <ol className="handoff-steps">
                    <li>Order the brief (queues if it&apos;s mid-turn)</li>
                    <li>Commission a successor in the same folder</li>
                    <li>Paste the brief in as its first orders</li>
                  </ol>
                  <label className="handoff-check">
                    <input
                      type="checkbox"
                      checked={killOld}
                      onChange={(e) => setKillOld(e.target.checked)}
                    />
                    Decommission this clone once the successor has its orders
                  </label>
                  <button
                    className="btn primary"
                    disabled={!props.ptyId}
                    title={
                      props.ptyId
                        ? 'Runs the whole handoff automatically'
                        : "This clone runs outside Kamino — Kamino can't type into its terminal"
                    }
                    onClick={startTransfer}
                  >
                    ✦ Transfer to a fresh clone
                  </button>
                  {!props.ptyId && (
                    <div className="handoff-warn">
                      Field-deployed clone — Kamino has no input channel into its terminal. Run
                      /compact in that window instead.
                    </div>
                  )}
                </div>

                <div className="handoff-option">
                  <div className="handoff-option-head">
                    <span className="handoff-option-title">⌦ Compress in place</span>
                  </div>
                  <div className="handoff-option-body">
                    Runs <code>/compact</code> now: the CLI summarises the conversation itself and
                    the same session carries on with room again. Faster and keeps the session id —
                    but it&apos;s the lossy step you were trying to avoid, just on your schedule
                    instead of at 100%. Good mid-task; a transfer is better at a phase boundary or
                    once a session has gone muddled.
                  </div>
                  <button className="btn" disabled={!props.ptyId} onClick={compactNow}>
                    ⌦ Compact now
                  </button>
                </div>
              </div>
            </>
          )}

          {compacted && !progress && (
            <div className="handoff-verdict ok">
              ✓ <code>/compact</code> sent to {inst.name}. Watch its terminal — the rot meter drops
              once the summary lands.
            </div>
          )}

          {progress && (
            <>
              <div className={`handoff-verdict${progress.stage === 'error' ? ' bad' : finished ? ' ok' : ' pending'}`}>
                {progress.stage === 'error'
                  ? progress.error
                  : STAGE_LINE[progress.stage] ?? progress.stage}
              </div>

              <ol className="handoff-track">
                {(
                  [
                    ['briefing', 'Brief written'],
                    ['commissioning', 'Successor commissioned'],
                    ['seeding', 'Orders handed over']
                  ] as const
                ).map(([stage, label], i) => {
                  const order = ['briefing', 'brief', 'commissioning', 'seeding', 'done']
                  const at = order.indexOf(progress.stage)
                  const mine = order.indexOf(stage)
                  const state = finished || at > mine ? 'done' : at === mine ? 'active' : 'todo'
                  return (
                    <li key={stage} data-state={state}>
                      <span className="handoff-track-glyph">{state === 'done' ? '✓' : i + 1}</span>
                      {label}
                    </li>
                  )
                })}
              </ol>

              {progress.brief && (
                <>
                  <div className="handoff-brief-head">
                    HANDOFF BRIEF
                    {progress.partial && (
                      <span className="handoff-warn inline">
                        cut short — the successor gets it as-is
                      </span>
                    )}
                  </div>
                  <pre className="handoff-brief" ref={briefRef}>
                    {progress.brief}
                  </pre>
                </>
              )}

              {finished && (
                <div className="handoff-done-note">
                  {progress.killedOld
                    ? 'The old clone has been decommissioned.'
                    : 'The old clone is still running — decommission it when you’re happy the successor picked up.'}{' '}
                  Its terminal is on the board now, working from the brief.
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-body modal-actions">
          {running && (
            <button
              className="btn"
              onClick={() => {
                void window.fleet.handoffCancel(inst.sessionId)
                props.onClose()
              }}
            >
              Cancel transfer
            </button>
          )}
          {progress?.stage === 'error' && (
            <button className="btn" onClick={() => setProgress(null)}>
              Back
            </button>
          )}
          {(finished || compacted) && (
            <button className="btn primary" onClick={props.onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
