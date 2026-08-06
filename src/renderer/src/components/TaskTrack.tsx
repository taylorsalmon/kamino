import { useRef, useState } from 'react'
import type { TaskProgress } from '../../../shared/types'

const TIP_W = 320
const TIP_EST_H = 240

/** Above this the per-task segments get too thin to read — show a plain fill. */
const MAX_SEGMENTS = 16

/**
 * TaskTrack — where a clone is up to in its own task list, as one row.
 *
 * Every other live signal in a pane is instantaneous (state word, activity,
 * last reply): true right now, silent about trajectory. This row is the only
 * one that answers "how far through is it", so it earns its own line of height
 * rather than another chip competing for width. One segment per task, the
 * in-progress one pulsing; the full checklist is in the hover tip.
 */
export function TaskTrack(props: {
  tasks: TaskProgress
  /** dead clones get no pulse — nothing is running */
  live?: boolean
}): React.JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null)
  const [tipPos, setTipPos] = useState<React.CSSProperties | null>(null)
  const tasks = props.tasks
  if (tasks.total === 0) return null

  const done = tasks.completed === tasks.total
  const segments = tasks.total <= MAX_SEGMENTS ? tasks.items : null
  const label = done ? 'all tasks complete' : (tasks.activeLabel ?? '')

  function showTip(): void {
    const r = rootRef.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.max(8, Math.min(r.left, window.innerWidth - TIP_W - 12))
    const below = r.bottom + TIP_EST_H < window.innerHeight
    setTipPos(
      below ? { left, top: r.bottom + 6 } : { left, bottom: window.innerHeight - r.top + 6 }
    )
  }

  return (
    <div
      ref={rootRef}
      className="tasktrack"
      data-done={done ? 'yes' : undefined}
      data-live={props.live ? 'yes' : undefined}
      onMouseEnter={showTip}
      onMouseLeave={() => setTipPos(null)}
    >
      <span className="tt-bar" aria-hidden>
        {segments ? (
          segments.map((it) => <span key={it.id} className="tt-seg" data-status={it.status} />)
        ) : (
          <span className="tt-fill" style={{ width: `${(tasks.completed / tasks.total) * 100}%` }} />
        )}
      </span>
      <span className="tt-count">
        {tasks.completed}/{tasks.total}
      </span>
      {label && (
        <span className="tt-label" data-next={tasks.activeIsNext ? 'yes' : undefined}>
          {tasks.activeIsNext && !done && <span className="tt-next">next</span>}
          {label}
        </span>
      )}
      {tipPos && (
        <div className="tt-tip" style={tipPos}>
          <div className="tt-tip-head">
            <span className="tt-tip-title">TASK LIST</span>
            <span className="tt-tip-count">
              {tasks.completed} of {tasks.total} done
              {tasks.inProgress > 0 && ` · ${tasks.inProgress} running`}
            </span>
          </div>
          <div className="tt-tip-list">
            {tasks.items.map((it) => (
              <div key={it.id} className="tt-item" data-status={it.status}>
                <span className="tt-glyph">
                  {it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '▸' : '○'}
                </span>
                <span className="tt-subject">
                  {it.status === 'in_progress' ? it.activeForm || it.subject : it.subject}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
