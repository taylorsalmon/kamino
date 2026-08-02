import type { Instance } from '../../../shared/types'
import { agoShort, elapsed, STATE_WORD } from '../format'

export function InstanceCard(props: {
  instance: Instance
  now: number
  selected: boolean
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
      onClick={props.onSelect}
    >
      <span className="rail" />
      <span className="card-body">
        <span className="card-top">
          <span className="card-name">{inst.name}</span>
          <span className="state-word" data-state={inst.state}>
            {STATE_WORD[inst.state]}
          </span>
          <span className="card-elapsed">{rightTime}</span>
        </span>
        <span className="card-title">{inst.now.title}</span>
        <span className="card-activity">
          <span className="caret">▸</span>
          {inst.now.activity}
        </span>
        <span className="card-meta">
          <span className="kind-tag">{inst.kind}</span>
          <span className="branch">
            {inst.repo}
            {inst.gitBranch ? ` · ${inst.gitBranch}` : ''}
          </span>
          {inst.recent.prs.length > 0 && (
            <span className="pr-chip">
              PR {inst.recent.prs.map((p) => `#${p.number}`).join(' ')}
            </span>
          )}
          {inst.now.queued.length > 0 && (
            <span className="queue-chip">⧗ {inst.now.queued.length} queued</span>
          )}
        </span>
      </span>
    </button>
  )
}
