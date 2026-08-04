import { useEffect, useState } from 'react'
import type { Instance, PrStatusMap } from '../../../shared/types'
import { agoShort, elapsed, prBadge, STATE_WORD } from '../format'
import { TerminalView } from './TerminalView'
import { DetailPanel } from './DetailPanel'

/**
 * One cell of the grid view: a live status strip on top and, below it, the
 * interactive terminal (embedded instances) or the status detail (external
 * instances Fleet doesn't host).
 */
export function GridPane(props: {
  /** stable wall identity — sessionId (or ptyId while starting) */
  paneId: string
  instance: Instance | null
  ptyId: string | null
  now: number
  /** position on the wall — slots 0-8 get a Ctrl+n jump badge */
  slot?: number
  /** span in grid tracks (1 or 2 per axis) — fixed steps, never pixels */
  size?: { w: 1 | 2; h: 1 | 2 }
  onToggleSize?: (axis: 'w' | 'h') => void
  /** another pane's grip was dropped here — it takes this slot */
  onDropPane?: (srcPaneId: string) => void
  adoptPending: boolean
  prStatus?: PrStatusMap
  onAdopt: () => void
  onFocus: () => void
}): React.JSX.Element {
  const { instance: inst, ptyId, now } = props
  const state = inst?.state ?? 'busy'
  // per-pane flip between the live terminal and the intel/detail view
  const [showIntel, setShowIntel] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const size = props.size ?? { w: 1, h: 1 }
  // needs-you banner dismissal — comes back if a NEW ask appears
  const [askDismissed, setAskDismissed] = useState(false)
  const pendingAsk = state === 'needs-you' ? inst?.now.pendingAsk : undefined
  useEffect(() => setAskDismissed(false), [pendingAsk])

  const rightTime = inst
    ? state === 'busy' && inst.now.turnStartedAt
      ? elapsed(inst.now.turnStartedAt, now)
      : agoShort(inst.lastActiveAt, now)
    : ''

  return (
    <div
      className={`pane${dragOver ? ' drag-over' : ''}`}
      data-state={state}
      style={{
        gridColumn: size.w === 2 ? 'span 2' : undefined,
        gridRow: size.h === 2 ? 'span 2' : undefined
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-kamino-pane')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false)
        const src = e.dataTransfer.getData('application/x-kamino-pane')
        if (src) props.onDropPane?.(src)
      }}
    >
      <div className="pane-strip" data-state={state}>
        <span className="pane-rail" />
        <span
          className="pane-grip"
          title="Drag to another pane to swap slots"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-kamino-pane', props.paneId)
            e.dataTransfer.effectAllowed = 'move'
          }}
        >
          ⠿
        </span>
        {props.slot != null && props.slot < 9 && (
          <span className="pane-slot" title={`Ctrl+${props.slot + 1} puts your keyboard here`}>
            {props.slot + 1}
          </span>
        )}
        <span className="pane-name">{inst?.name ?? 'growing…'}</span>
        <span className="state-word" data-state={state}>
          {inst ? STATE_WORD[inst.state] : 'CLONING'}
        </span>
        <span className="pane-activity" title={inst?.now.activity}>
          <span className="caret">▸</span>
          {inst?.now.activity ?? 'Growing clone… roger roger.'}
        </span>
        <span className="pane-chips">
          {inst &&
            inst.recent.prs.length > 0 &&
            (() => {
              const prs = inst.recent.prs
              const latest = prs[prs.length - 1]
              const badge = prBadge(props.prStatus?.[latest.url])
              const all = prs.map((p) => `#${p.number}`).join(' ')
              return (
                <button
                  className="pane-chip pr"
                  title={`${badge ? badge.title : all} — click to open latest`}
                  onClick={() => window.fleet.openExternal(latest.url)}
                >
                  PR #{latest.number}
                  {prs.length > 1 && ` +${prs.length - 1}`}
                  {badge && (
                    <span className="pr-glyph" data-tone={badge.tone}>
                      {badge.glyph}
                    </span>
                  )}
                </button>
              )
            })()}
          {inst && inst.now.queued.length > 0 && (
            <span className="pane-chip queue">⧗ {inst.now.queued.length}</span>
          )}
          <span className="pane-chip time">{rightTime}</span>
          {ptyId && inst && (
            <button
              className="pane-chip focus-btn"
              title={showIntel ? 'Back to the terminal' : 'Intel view — status, recap, PRs'}
              onClick={() => setShowIntel((v) => !v)}
            >
              {showIntel ? '⌨' : '✦'}
            </button>
          )}
          <button
            className={`pane-chip size-btn${size.w === 2 ? ' on' : ''}`}
            title={size.w === 2 ? 'Back to single width' : 'Widen — span two columns'}
            onClick={() => props.onToggleSize?.('w')}
          >
            ⬌
          </button>
          <button
            className={`pane-chip size-btn${size.h === 2 ? ' on' : ''}`}
            title={size.h === 2 ? 'Back to single height' : 'Stretch — span two rows'}
            onClick={() => props.onToggleSize?.('h')}
          >
            ⬍
          </button>
          <button className="pane-chip focus-btn" title="Open in focus view" onClick={props.onFocus}>
            ⤢
          </button>
          <button
            className="pane-chip kill-btn"
            title="Decommission this clone"
            onClick={async () => {
              const name = inst?.name ?? 'this clone'
              if (!(await window.fleet.confirm(`Decommission ${name}?`, 'Unsaved work in its turn is lost.'))) return
              if (ptyId) window.fleet.ptyKill(ptyId)
              else if (inst) window.fleet.killPid(inst.pid)
            }}
          >
            ✕
          </button>
        </span>
      </div>
      {inst && (
        <div className="pane-title">
          {inst.now.title && <span className="pane-task">{inst.now.title}</span>}
          <span className="pane-branch">
            {inst.repo}
            {inst.gitBranch ? ` · ${inst.gitBranch}` : ''}
          </span>
          {inst.kind !== 'embedded' && (
            <span className="pane-kind" data-kind={inst.kind} title={inst.kind === 'external' ? 'Running in an outside terminal' : 'Headless background session'}>
              {inst.kind === 'external' ? 'field-deployed' : 'covert ops'}
            </span>
          )}
        </div>
      )}
      {/* always rendered while a session exists — constant height keeps the
          terminal below from resizing mid-typing (ConPTY redraw mangles the
          composer) */}
      {inst && (
        <div className="pane-quotes">
          <span className="pane-quote" title={inst.recent.lastPrompt}>
            <span className="who">❯ you</span> {inst.recent.lastPrompt || '—'}
          </span>
          <span className="pane-quote" title={inst.recent.lastAssistantText}>
            <span className="who">✦ clone</span> {inst.recent.lastAssistantText || '—'}
          </span>
        </div>
      )}
      <div className="pane-body">
        {/* overlay, not a row — pane height must not change or ConPTY redraws
            mangle the composer mid-typing */}
        {pendingAsk && !askDismissed && !showIntel && (
          <div className="pane-ask" title={pendingAsk}>
            <span className="pane-ask-label">NEEDS YOU</span>
            <span className="pane-ask-text">{pendingAsk}</span>
            <button className="pane-ask-close" title="Dismiss" onClick={() => setAskDismissed(true)}>
              ✕
            </button>
          </div>
        )}
        {ptyId && !(showIntel && inst) ? (
          <TerminalView ptyId={ptyId} autoFocus={false} />
        ) : inst ? (
          <div className="pane-detail">
            {inst.kind === 'background' && (
              <div className="pane-external-note">Covert ops — status only.</div>
            )}
            <DetailPanel
              instance={inst}
              now={now}
              adoptPending={props.adoptPending}
              prStatus={props.prStatus}
              onAdopt={props.onAdopt}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
