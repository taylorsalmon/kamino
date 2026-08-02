import type { Instance } from '../../../shared/types'
import { agoShort, elapsed, STATE_WORD } from '../format'
import { TerminalView } from './TerminalView'
import { DetailPanel } from './DetailPanel'

/**
 * One cell of the grid view: a live status strip on top and, below it, the
 * interactive terminal (embedded instances) or the status detail (external
 * instances Fleet doesn't host).
 */
export function GridPane(props: {
  instance: Instance | null
  ptyId: string | null
  now: number
  adoptPending: boolean
  onAdopt: () => void
  onFocus: () => void
}): React.JSX.Element {
  const { instance: inst, ptyId, now } = props
  const state = inst?.state ?? 'busy'

  const rightTime = inst
    ? state === 'busy' && inst.now.turnStartedAt
      ? elapsed(inst.now.turnStartedAt, now)
      : agoShort(inst.lastActiveAt, now)
    : ''

  return (
    <div className="pane" data-state={state}>
      <div className="pane-strip" data-state={state}>
        <span className="pane-rail" />
        <span className="pane-name">{inst?.name ?? 'starting…'}</span>
        <span className="state-word" data-state={state}>
          {inst ? STATE_WORD[inst.state] : 'STARTING'}
        </span>
        <span className="pane-activity" title={inst?.now.activity}>
          <span className="caret">▸</span>
          {inst?.now.activity ?? 'Launching Claude Code…'}
        </span>
        <span className="pane-chips">
          {inst && inst.recent.prs.length > 0 && (
            <button
              className="pane-chip pr"
              title="Open latest PR"
              onClick={() => window.fleet.openExternal(inst.recent.prs[inst.recent.prs.length - 1].url)}
            >
              PR {inst.recent.prs.map((p) => `#${p.number}`).join(' ')}
            </button>
          )}
          {inst && inst.now.queued.length > 0 && (
            <span className="pane-chip queue">⧗ {inst.now.queued.length}</span>
          )}
          <span className="pane-chip time">{rightTime}</span>
          <button className="pane-chip focus-btn" title="Open in focus view" onClick={props.onFocus}>
            ⤢
          </button>
        </span>
      </div>
      {inst?.now.title && <div className="pane-title">{inst.now.title}</div>}
      <div className="pane-body">
        {ptyId ? (
          <TerminalView ptyId={ptyId} autoFocus={false} />
        ) : inst ? (
          <div className="pane-detail">
            {inst.kind === 'background' && (
              <div className="pane-external-note">Background session — status only.</div>
            )}
            <DetailPanel
              instance={inst}
              now={now}
              adoptPending={props.adoptPending}
              onAdopt={props.onAdopt}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
