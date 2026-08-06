import type { Instance, PrStatusMap } from '../../../shared/types'
import { agoShort, elapsed, KIND_WORD, prBadge, stateWord } from '../format'
import { RotBar } from './RotBar'

export function InstanceCard(props: {
  instance: Instance
  now: number
  selected: boolean
  prStatus?: PrStatusMap
  onSelect: () => void
}): React.JSX.Element {
  const { instance: inst, now } = props

  const rightTime =
    inst.state === 'busy' && inst.now.turnStartedAt
      ? elapsed(inst.now.turnStartedAt, now)
      : agoShort(inst.lastActiveAt, now)

  return (
    <button
      className={`card${props.selected ? ' selected' : ''}`}
      data-state={inst.state}
      data-arbiter={inst.arbiter ? 'yes' : undefined}
      onClick={props.onSelect}
    >
      <span className="rail" />
      <span className="card-body">
        <span className="card-top">
          {/* the roster has to carry this too — an arbiter is unmistakable on
              the wall and then just another name in the list otherwise */}
          {inst.arbiter && (
            <span
              className="pane-arbiter-badge"
              title="An airspace arbiter Kamino dispatched to settle a collision. It stages; it never commits. Don't give it work."
            >
              ⚖ ARBITER
            </span>
          )}
          <span className="card-name">{inst.name}</span>
          <span className="state-word" data-state={inst.state} data-arbiter={inst.arbiter ? 'yes' : undefined}>
            {stateWord(inst.state, inst.now.askKind)}
          </span>
          <span className="card-elapsed">{rightTime}</span>
        </span>
        <span className="card-title">{inst.now.title}</span>
        <span className="card-activity">
          <span className="caret">▸</span>
          {inst.now.activity}
        </span>
        {/* progress through its own task list — spans only, this card is a
            <button> and a <div> here would be invalid nesting */}
        {inst.tasks && (
          <span className="card-tasks" data-done={inst.tasks.completed === inst.tasks.total ? 'yes' : undefined}>
            <span className="tt-bar" aria-hidden>
              {inst.tasks.total <= 16 ? (
                inst.tasks.items.map((it) => (
                  <span key={it.id} className="tt-seg" data-status={it.status} />
                ))
              ) : (
                <span
                  className="tt-fill"
                  style={{ width: `${(inst.tasks.completed / inst.tasks.total) * 100}%` }}
                />
              )}
            </span>
            <span className="tt-count">
              {inst.tasks.completed}/{inst.tasks.total}
            </span>
            <span className="tt-label">
              {inst.tasks.completed === inst.tasks.total
                ? 'all tasks complete'
                : (inst.tasks.activeLabel ?? '')}
            </span>
          </span>
        )}
        <span className="card-meta">
          <span className="kind-tag">{KIND_WORD[inst.kind] ?? inst.kind}</span>
          <span className="branch">
            {inst.repo}
            {inst.gitBranch ? ` · ${inst.gitBranch}` : ''}
          </span>
          {inst.recent.prs.length > 0 && (
            <span className="pr-chip" title={inst.recent.prs.map((p) => `#${p.number}`).join(' ')}>
              PR{' '}
              {inst.recent.prs.slice(-2).map((p) => {
                const badge = prBadge(props.prStatus?.[p.url])
                return (
                  <span key={p.url} className="pr-chip-item" title={badge?.title}>
                    #{p.number}
                    {badge && (
                      <span className="pr-glyph" data-tone={badge.tone}>
                        {badge.glyph}
                      </span>
                    )}
                  </span>
                )
              })}
              {inst.recent.prs.length > 2 && ` +${inst.recent.prs.length - 2}`}
            </span>
          )}
          {inst.now.queued.length > 0 && (
            <span className="queue-chip">⧗ {inst.now.queued.length} queued</span>
          )}
          {inst.state !== 'dead' && (
            <RotBar context={inst.context} now={now} sessionId={inst.sessionId} />
          )}
        </span>
      </span>
    </button>
  )
}
