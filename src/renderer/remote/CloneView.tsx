import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrCreateResult, PrStatusMap, RemoteInstance, RemotePty, TranscriptTailMsg } from '../../shared/types'
import { agoShort, elapsed, fmtTokens, prBadge, stateWord } from '../src/format'
import { api, keys, send, type Link } from './api'
import { LinkLamp } from './PhoneApp'
import { Screen } from './Screen'

/**
 * One clone, full screen. Chat is the readable view (its transcript); Screen
 * is the literal terminal, for prompts the transcript can't show; Info is the
 * HUD. The composer and the one-tap answers go straight into its terminal.
 */

type Tab = 'chat' | 'screen' | 'info'

export function CloneView(props: {
  inst?: RemoteInstance
  pty?: RemotePty
  pr: PrStatusMap
  termTheme: 'light' | 'dark'
  now: number
  link: Link
  onBack: () => void
}): React.JSX.Element {
  const { inst, now } = props
  const ptyId = inst?.ptyId ?? props.pty?.ptyId
  const readable = !!inst && inst.cliKind !== 'custom'
  const [tab, setTab] = useState<Tab>(readable ? 'chat' : 'screen')
  const [err, setErr] = useState('')

  // a growing clone has no transcript yet; once it binds, chat opens up
  useEffect(() => {
    if (!readable && tab === 'chat') setTab('screen')
  }, [readable, tab])

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setErr('')
      try {
        await fn()
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    },
    []
  )

  const state = inst?.state ?? 'busy'
  const name = inst?.name ?? 'New clone'

  return (
    <div className="screen clone" data-state={state}>
      <header className="bar">
        <button className="icon-btn" onClick={props.onBack} aria-label="Back to board">
          ‹
        </button>
        <div className="bar-mid">
          <span className="bar-title">{name}</span>
          <span className="bar-sub">
            <span className="state-word" data-state={state}>
              {inst ? stateWord(inst.state, inst.now.askKind) : 'GROWING…'}
            </span>
            {inst?.state === 'busy' && inst.now.turnStartedAt && (
              <span className="bar-elapsed">{elapsed(inst.now.turnStartedAt, now)}</span>
            )}
          </span>
        </div>
        {ptyId && inst?.state === 'busy' ? (
          <button className="btn stop" onClick={() => void act(() => keys(ptyId, ['esc']))} title="Interrupt (Esc)">
            ■ Stop
          </button>
        ) : (
          <LinkLamp link={props.link} />
        )}
      </header>

      {inst?.state === 'needs-you' && (
        <AskCard inst={inst} ptyId={ptyId} act={act} compact={tab === 'screen'} onScreen={() => setTab('screen')} />
      )}

      <nav className="tabs">
        {readable && (
          <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
            Chat
          </button>
        )}
        {ptyId && (
          <button className={tab === 'screen' ? 'on' : ''} onClick={() => setTab('screen')}>
            Screen
          </button>
        )}
        {inst && (
          <button className={tab === 'info' ? 'on' : ''} onClick={() => setTab('info')}>
            Info
          </button>
        )}
      </nav>

      {err && (
        <button className="err" onClick={() => setErr('')}>
          {err}
        </button>
      )}

      <div className="clone-body">
        {tab === 'chat' && inst && <Chat inst={inst} />}
        {tab === 'screen' && ptyId && <Screen ptyId={ptyId} theme={props.termTheme} act={act} />}
        {tab === 'info' && inst && <Info inst={inst} ptyId={ptyId} pr={props.pr} now={now} act={act} />}
      </div>

      {ptyId ? (
        <Composer ptyId={ptyId} act={act} placeholder={inst?.state === 'busy' ? 'Queue orders…' : `Orders for ${name}…`} />
      ) : (
        <div className="view-only">
          {inst?.state === 'dead'
            ? 'Decommissioned.'
            : 'View only: this clone runs in a terminal outside Kamino, so the phone can watch but not type.'}
        </div>
      )}
    </div>
  )
}

function AskCard(props: {
  inst: RemoteInstance
  ptyId?: string
  act: (fn: () => Promise<unknown>) => Promise<void>
  /** the Screen tab shows the prompt itself — keep just the answers */
  compact: boolean
  onScreen: () => void
}): React.JSX.Element {
  const { inst, ptyId, act, compact } = props
  const n = inst.now
  const [open, setOpen] = useState(false)
  const text = n.pendingAsk || n.activity || 'Waiting on you.'
  return (
    <section className={`ask${compact ? ' compact' : ''}`}>
      {!compact && (
        <div className={`ask-text${open ? ' open' : ''}`} onClick={() => setOpen((v) => !v)}>
          {text}
        </div>
      )}
      {ptyId && (
        <div className="ask-actions">
          {n.askKind === 'question' &&
            n.pendingOptions?.slice(0, 9).map((label, i) => (
              <button key={i} className="btn answer" onClick={() => void act(() => keys(ptyId, [String(i + 1)]))}>
                <b>{i + 1}</b> {label}
              </button>
            ))}
          {(n.askKind === 'permission' || n.askKind === 'plan') && (
            <>
              <button className="btn primary answer" onClick={() => void act(() => keys(ptyId, ['approve']))}>
                ✓ Approve
              </button>
              <button className="btn answer" onClick={() => void act(() => keys(ptyId, ['esc']))}>
                ✕ Say no (Esc)
              </button>
            </>
          )}
          {n.askKind === 'reply' && (
            <button
              className="btn primary answer"
              onClick={() => void act(() => send(ptyId, 'Proceed with your best judgment.'))}
            >
              ⚡ Proceed on your judgment
            </button>
          )}
          {!compact && (
            <button className="btn ghost answer" onClick={props.onScreen}>
              See the prompt ›
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/** The clone's last exchanges, refreshed when a turn lands (and every few
 *  seconds while it works, so its narration shows up as it goes). */
function Chat({ inst }: { inst: RemoteInstance }): React.JSX.Element {
  const [msgs, setMsgs] = useState<TranscriptTailMsg[] | null>(null)
  const [openIdx, setOpenIdx] = useState<Set<number>>(new Set())
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const load = useCallback(() => {
    api<TranscriptTailMsg[]>(`session/${encodeURIComponent(inst.sessionId)}/tail`)
      .then(setMsgs)
      .catch(() => setMsgs((m) => m ?? []))
  }, [inst.sessionId])

  useEffect(load, [load, inst.recent.turns, inst.state, inst.recent.lastAssistantText])
  useEffect(() => {
    if (inst.state !== 'busy') return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [inst.state, load])

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [msgs])

  return (
    <div
      className="scroll chat"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}
    >
      {inst.now.title && <div className="chat-title">{inst.now.title}</div>}
      {msgs === null && <div className="empty">Reading its transcript…</div>}
      {msgs?.length === 0 && <div className="empty">Nothing said yet.</div>}
      {msgs?.map((m, i) => {
        const long = m.text.length > 700
        const open = openIdx.has(i) || i === msgs.length - 1
        return (
          <div key={i} className={`msg ${m.who}`}>
            <div className={`msg-text${long && !open ? ' clamped' : ''}`}>{m.text}</div>
            {long && !open && (
              <button className="msg-more" onClick={() => setOpenIdx((s) => new Set(s).add(i))}>
                Show all
              </button>
            )}
          </div>
        )
      })}
      {inst.state === 'busy' && inst.now.activity && (
        <div className="msg working">
          <span className="pulse" />
          {inst.now.activity}
        </div>
      )}
      {inst.now.queued.length > 0 && (
        <div className="queued">
          {inst.now.queued.length} queued: {inst.now.queued.join(' · ')}
        </div>
      )}
    </div>
  )
}

function Info(props: {
  inst: RemoteInstance
  ptyId?: string
  pr: PrStatusMap
  now: number
  act: (fn: () => Promise<unknown>) => Promise<void>
}): React.JSX.Element {
  const { inst, ptyId, now, act } = props
  const [recap, setRecap] = useState<string | null>(null)
  const [recapBusy, setRecapBusy] = useState(false)
  const [prBusy, setPrBusy] = useState(false)
  const [prNote, setPrNote] = useState('')
  const ctx = inst.context
  const pct = ctx ? Math.round(ctx.pct * 100) : null

  async function raisePr(): Promise<void> {
    setPrBusy(true)
    setPrNote('')
    await act(async () => {
      const res = await api<PrCreateResult>(`session/${encodeURIComponent(inst.sessionId)}/pr`, {})
      setPrNote(res.ok ? (res.existed ? `PR #${res.number} already open` : `Raised PR #${res.number}`) : res.error || 'Could not raise a PR')
    })
    setPrBusy(false)
  }

  async function getRecap(): Promise<void> {
    setRecapBusy(true)
    await act(async () => {
      const r = await api<{ text: string }>(`session/${encodeURIComponent(inst.sessionId)}/recap`, {})
      setRecap(r.text)
    })
    setRecapBusy(false)
  }

  return (
    <div className="scroll info">
      {inst.now.title && <div className="info-title">{inst.now.title}</div>}

      <dl className="facts">
        <dt>Repo</dt>
        <dd>
          {inst.repo}
          {inst.gitBranch && <span className="mono"> · {inst.gitBranch}</span>}
        </dd>
        {inst.worktree && (
          <>
            <dt>Worktree</dt>
            <dd className="mono">{inst.worktree}</dd>
          </>
        )}
        <dt>Folder</dt>
        <dd className="mono wrap">{inst.cwd}</dd>
        <dt>Runs on</dt>
        <dd>
          {inst.cli}
          {inst.model && <span className="mono"> · {inst.model}</span>}
          {inst.permissionMode && inst.permissionMode !== 'default' && <span className="mono"> · {inst.permissionMode}</span>}
        </dd>
        <dt>Up</dt>
        <dd>
          {agoShort(inst.startedAt, now)} · {inst.recent.turns} turns
        </dd>
        {ctx && (
          <>
            <dt>Context</dt>
            <dd>
              <span className="ctx-bar">
                <span className={`ctx-fill${(pct ?? 0) >= 80 ? ' hot' : ''}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
              </span>
              <span className="mono">
                {pct}% · {fmtTokens(ctx.tokens)}/{fmtTokens(ctx.window)}
                {ctx.compactions > 0 && ` · ${ctx.compactions} compacted`}
              </span>
            </dd>
          </>
        )}
      </dl>

      {inst.tasks && inst.tasks.total > 0 && (
        <section className="info-sec">
          <h3>
            Tasks · {inst.tasks.completed}/{inst.tasks.total}
          </h3>
          <ul className="tasks">
            {inst.tasks.items.map((t) => (
              <li key={t.id} data-status={t.status}>
                <span className="task-box">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : ''}</span>
                {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(inst.recent.prs.length > 0 || inst.recent.issues.length > 0) && (
        <section className="info-sec">
          <h3>Shipped</h3>
          {inst.recent.prs.map((p) => {
            const b = prBadge(props.pr[p.url])
            return (
              <a key={p.url} className="link-row" href={p.url} target="_blank" rel="noreferrer">
                <span className="pr-chip" data-tone={b?.tone ?? 'open'}>
                  {b?.glyph ?? '○'} #{p.number}
                </span>
                <span>{b?.words ?? 'pull request'}</span>
              </a>
            )
          })}
          {inst.recent.issues.map((i) => (
            <a key={i.key} className="link-row" href={i.url} target="_blank" rel="noreferrer">
              <span className="issue-chip">{i.key}</span>
              <span>{i.title ?? 'Linear issue'}</span>
            </a>
          ))}
        </section>
      )}

      <section className="info-sec">
        <h3>Orders</h3>
        <div className="info-actions">
          {inst.cliKind !== 'custom' && (
            <button className="btn" disabled={recapBusy} onClick={() => void getRecap()}>
              {recapBusy ? 'Writing recap…' : '📋 Recap'}
            </button>
          )}
          {inst.state !== 'dead' && (
            <button className="btn" disabled={prBusy} onClick={() => void raisePr()}>
              {prBusy ? 'Raising…' : '⬆ Raise PR'}
            </button>
          )}
          {ptyId && inst.state !== 'dead' && (
            <button
              className="btn danger"
              onClick={() => {
                if (confirm(`Decommission ${inst.name}? Its session ends; unsaved work in a running turn is lost.`)) {
                  void act(() => api(`pty/${encodeURIComponent(ptyId)}/kill`, {}))
                }
              }}
            >
              ✕ Decommission
            </button>
          )}
        </div>
        {prNote && <div className="note">{prNote}</div>}
        {recap && <div className="recap">{recap}</div>}
      </section>
    </div>
  )
}

function Composer(props: {
  ptyId: string
  placeholder: string
  act: (fn: () => Promise<unknown>) => Promise<void>
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  // grow with the text, up to about six lines
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`
    el.classList.toggle('full', el.scrollHeight > 150)
  }, [text])

  async function submit(): Promise<void> {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    await props.act(async () => {
      await send(props.ptyId, t)
      setText('')
    })
    setBusy(false)
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder={props.placeholder}
        onChange={(e) => setText(e.target.value)}
        enterKeyHint="send"
      />
      <button className="send" type="submit" disabled={!text.trim() || busy} aria-label="Send">
        ↑
      </button>
    </form>
  )
}
