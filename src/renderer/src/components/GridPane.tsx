import { useEffect, useRef, useState } from 'react'
import type { Instance, PrStatusMap, TranscriptTailMsg } from '../../../shared/types'
import { agoShort, elapsed, prBadge, stateWord } from '../format'
import { TerminalView } from './TerminalView'
import { DetailPanel } from './DetailPanel'
import { RotBar } from './RotBar'
import { TaskTrack } from './TaskTrack'

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
  /** span in grid tracks — whole tracks, never pixels */
  size?: { w: number; h: number }
  /** live while dragging an edge handle — each snap to a new track fires once */
  onSizeChange?: (size: { w: number; h: number }) => void
  /** how far this pane may grow: columns on the wall, rows in the viewport */
  maxSpan?: { w: number; h: number }
  /** another pane's grip was dropped here — it takes this slot */
  onDropPane?: (srcPaneId: string) => void
  adoptPending: boolean
  prStatus?: PrStatusMap
  onAdopt: () => void
  onFocus: () => void
}): React.JSX.Element {
  const { instance: inst, ptyId, now } = props
  const state = inst?.state ?? 'busy'
  // an arbiter is Kamino's own clone, not one of yours — it gets a different
  // skin entirely so it is never mistaken for a pane you can hand work to
  const isArbiter = inst?.arbiter === true
  // per-pane flip between the live terminal and the intel/detail view
  const [showIntel, setShowIntel] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [resizing, setResizing] = useState(false)
  const paneRef = useRef<HTMLDivElement>(null)
  const size = props.size ?? { w: 1, h: 1 }

  // must match .grid-view gap in styles.css — track math depends on it
  const GRID_GAP = 6

  /** edge-handle drag: snap the span to whole grid tracks as the cursor
   *  crosses track midpoints. Discrete snaps, so the terminal refits a
   *  couple of times per drag instead of every pixel (ConPTY redraw). */
  function startResize(e: React.PointerEvent, axes: { x?: boolean; y?: boolean }): void {
    const el = paneRef.current
    if (!el || !props.onSizeChange) return
    e.preventDefault()
    e.stopPropagation()
    const rect = el.getBoundingClientRect()
    const start = props.size ?? { w: 1, h: 1 }
    const colW = (rect.width - GRID_GAP * (start.w - 1)) / start.w
    const rowH = (rect.height - GRID_GAP * (start.h - 1)) / start.h
    const max = props.maxSpan ?? { w: 2, h: 2 }
    let cur = { ...start }
    setResizing(true)
    document.body.classList.add('pane-resizing')
    document.body.style.cursor = axes.x && axes.y ? 'nwse-resize' : axes.x ? 'ew-resize' : 'ns-resize'
    const onMove = (ev: PointerEvent): void => {
      const w = axes.x
        ? Math.min(max.w, Math.max(1, Math.round((ev.clientX - rect.left + GRID_GAP) / (colW + GRID_GAP))))
        : cur.w
      const h = axes.y
        ? Math.min(max.h, Math.max(1, Math.round((ev.clientY - rect.top + GRID_GAP) / (rowH + GRID_GAP))))
        : cur.h
      if (w !== cur.w || h !== cur.h) {
        cur = { w, h }
        props.onSizeChange?.(cur)
      }
    }
    const onUp = (): void => {
      setResizing(false)
      document.body.classList.remove('pane-resizing')
      document.body.style.cursor = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  // hover peek — linger on the quote rows and the last few exchanges of the
  // conversation pop up, so "wait, what did it just say?" needs no click
  const [peek, setPeek] = useState<TranscriptTailMsg[] | null>(null)
  const peekSeq = useRef(0)
  function peekEnter(): void {
    if (!inst) return
    const sessionId = inst.sessionId
    const seq = ++peekSeq.current
    setTimeout(async () => {
      if (peekSeq.current !== seq) return // pointer already left
      const tail = await window.fleet.transcriptTail(sessionId)
      if (peekSeq.current === seq && tail.length > 0) setPeek(tail)
    }, 300)
  }
  function peekLeave(): void {
    peekSeq.current++
    setPeek(null)
  }

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
      ref={paneRef}
      className={`pane${dragOver ? ' drag-over' : ''}${resizing ? ' resizing' : ''}`}
      data-state={state}
      data-arbiter={isArbiter ? 'yes' : undefined}
      style={{
        gridColumn: size.w > 1 ? `span ${size.w}` : undefined,
        gridRow: size.h > 1 ? `span ${size.h}` : undefined
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
      <div className="pane-strip" data-state={state} data-arbiter={isArbiter ? 'yes' : undefined}>
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
        {isArbiter && (
          <span
            className="pane-arbiter-badge"
            title="An airspace arbiter — Kamino dispatched this clone to settle a collision between two others. It stages; it never commits. Don't give it work."
          >
            ⚖ ARBITER
          </span>
        )}
        <span className="pane-name">{inst?.name ?? 'growing…'}</span>
        <span className="state-word" data-state={state} data-arbiter={isArbiter ? 'yes' : undefined}>
          {inst ? stateWord(inst.state, inst.now.askKind) : 'CLONING'}
        </span>
        <span className="pane-activity" title={inst?.now.activity}>
          {(inst ? inst.now.activity : 'Growing clone… roger roger.') && (
            <>
              <span className="caret">▸</span>
              {inst?.now.activity ?? 'Growing clone… roger roger.'}
            </>
          )}
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
      {/* progress before provenance: how far through it is sits directly under
          the state word, where the eye already is */}
      {inst?.tasks && <TaskTrack tasks={inst.tasks} live={state !== 'dead'} />}
      {inst && (
        <div className="pane-title">
          {inst.now.title && <span className="pane-task">{inst.now.title}</span>}
          <span className="pane-branch">
            {inst.repo}
            {inst.gitBranch ? ` · ${inst.gitBranch}` : ''}
          </span>
          {inst.worktree && (
            <span
              className="pane-kind"
              data-kind="worktree"
              title={`Its own git worktree — separate branch and PR, cannot collide with a sibling\n${inst.cwd}`}
            >
              ⑄ {inst.worktree}
            </span>
          )}
          {inst.kind !== 'embedded' && (
            <span className="pane-kind" data-kind={inst.kind} title={inst.kind === 'external' ? 'Running in an outside terminal' : 'Headless background session'}>
              {inst.kind === 'external' ? 'field-deployed' : 'covert ops'}
            </span>
          )}
          {inst.state !== 'dead' && (
            <RotBar context={inst.context} now={now} sessionId={inst.sessionId} />
          )}
        </div>
      )}
      {/* always rendered while a session exists — constant height keeps the
          terminal below from resizing mid-typing (ConPTY redraw mangles the
          composer) */}
      {inst && (
        <div className="pane-quotes" onMouseEnter={peekEnter} onMouseLeave={peekLeave}>
          <span className="pane-quote" title="Hover to peek at the last few exchanges">
            <span className="who">❯ you</span> {inst.recent.lastPrompt || '—'}
          </span>
          <span className="pane-quote" title="Hover to peek at the last few exchanges">
            <span className="who">✦ clone</span> {inst.recent.lastAssistantText || '—'}
          </span>
          {peek && (
            <div className="pane-peek">
              {peek.map((m, i) => (
                <div key={i} className="peek-msg" data-who={m.who}>
                  <span className="who">{m.who === 'you' ? '❯ you' : '✦ clone'}</span>
                  <span className="peek-text">{m.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="pane-body">
        {/* overlay, not a row — pane height must not change or ConPTY redraws
            mangle the composer mid-typing */}
        {pendingAsk && !askDismissed && !showIntel && inst && (
          <div className="pane-ask" title={pendingAsk}>
            <div className="pane-ask-top">
              <span className="pane-ask-label">{stateWord('needs-you', inst.now.askKind)}</span>
              <span className="pane-ask-text">{pendingAsk}</span>
              <button className="pane-ask-close" title="Dismiss" onClick={() => setAskDismissed(true)}>
                ✕
              </button>
            </div>
            {/* one-click answers — keystrokes straight into the pty, no
                focusing, no typing */}
            {ptyId && (
              <div className="pane-ask-actions">
                {inst.now.askKind === 'question' &&
                  inst.now.pendingOptions?.slice(0, 9).map((label, i) => (
                    <button
                      key={i}
                      className="pane-ask-btn"
                      title={`Answer: ${label}`}
                      onClick={() => window.fleet.ptyInput(ptyId, String(i + 1))}
                    >
                      {i + 1} · {label}
                    </button>
                  ))}
                {(inst.now.askKind === 'permission' || inst.now.askKind === 'plan') && (
                  <button
                    className="pane-ask-btn"
                    title="Selects option 1 (yes) in the prompt"
                    onClick={() => window.fleet.ptyInput(ptyId, '1')}
                  >
                    ✓ Approve
                  </button>
                )}
                {inst.now.askKind === 'reply' && (
                  <button
                    className="pane-ask-btn"
                    title="Sends: Proceed with your best judgment."
                    onClick={() => window.fleet.ptyInput(ptyId, 'Proceed with your best judgment.\r')}
                  >
                    ⚡ Proceed on your judgment
                  </button>
                )}
              </div>
            )}
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
      {props.onSizeChange && (
        <>
          {resizing && (
            <div className="pane-size-hud">
              {size.w}×{size.h}
            </div>
          )}
          <div
            className="pane-handle e"
            title="Drag to set width · double-click resets to 1×1"
            onPointerDown={(e) => startResize(e, { x: true })}
            onDoubleClick={() => props.onSizeChange?.({ w: 1, h: 1 })}
          />
          <div
            className="pane-handle s"
            title="Drag to set height · double-click resets to 1×1"
            onPointerDown={(e) => startResize(e, { y: true })}
            onDoubleClick={() => props.onSizeChange?.({ w: 1, h: 1 })}
          />
          <div
            className="pane-handle se"
            title="Drag to resize · double-click resets to 1×1"
            onPointerDown={(e) => startResize(e, { x: true, y: true })}
            onDoubleClick={() => props.onSizeChange?.({ w: 1, h: 1 })}
          />
        </>
      )}
    </div>
  )
}
