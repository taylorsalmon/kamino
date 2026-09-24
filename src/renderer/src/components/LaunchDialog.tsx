import { useEffect, useMemo, useState } from 'react'
import type { CliDefinition, RecentProject, RecentSession } from '../../../shared/types'
import { agoShort } from '../format'
import { cliKindOf, useClis } from '../clis'
import { CliMark } from './CliMark'
import { CliManagerDialog } from './CliManagerDialog'
import { LinearMark } from './LinearMark'

type Tab = 'new' | 'resume'

export function LaunchDialog(props: {
  onClose: () => void
  onLaunched: (ptyId: string, pid: number) => void
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('new')
  const [projects, setProjects] = useState<RecentProject[]>([])
  const [sessions, setSessions] = useState<RecentSession[]>([])
  const [cwd, setCwd] = useState('')
  const [prompt, setPrompt] = useState('')
  const [permissionMode, setPermissionMode] = useState('default')
  const [model, setModel] = useState('')
  // which CLI grows this clone — remembered, since a fleet usually runs on one
  const { clis, status, loaded, reload } = useClis()
  const [cliId, setCliId] = useState(() => localStorage.getItem('fleet:cli') || 'claude')
  const [showManage, setShowManage] = useState(false)
  // standing orders live in the clone's system prompt, so the choice is made
  // once at commission time and can't be forgotten later in the session
  const [autoShip, setAutoShip] = useState(
    () => localStorage.getItem('fleet:auto-ship') !== 'off'
  )
  // Linear tracking: the clone raises (or picks up) an issue the moment it
  // first changes a file, assigned to you, and keeps it current. Needs the
  // Linear MCP connector, which Claude Code has and the others do not yet.
  const [linear, setLinear] = useState(() => localStorage.getItem('fleet:linear') !== 'off')
  const [linearIssue, setLinearIssue] = useState('')
  // its own worktree: a folder has one checked-out branch, so clones sharing
  // one land in the same branch and the same PR however well they behave
  const [worktree, setWorktree] = useState(false)
  const [worktreeName, setWorktreeName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const now = Date.now()

  const cli: CliDefinition | undefined = useMemo(
    () => clis.find((c) => c.id === cliId) ?? clis.find((c) => c.id === 'claude'),
    [clis, cliId]
  )
  const cliStatus = cli ? status[cli.id] : undefined

  useEffect(() => {
    localStorage.setItem('fleet:auto-ship', autoShip ? 'on' : 'off')
  }, [autoShip])
  useEffect(() => {
    localStorage.setItem('fleet:linear', linear ? 'on' : 'off')
  }, [linear])
  useEffect(() => {
    localStorage.setItem('fleet:cli', cliId)
    // a mode from the previous CLI's list means nothing to this one
    setPermissionMode('default')
    setModel('')
  }, [cliId])
  // a saved id whose definition was removed falls back to Claude
  useEffect(() => {
    if (loaded && !clis.some((c) => c.id === cliId)) setCliId('claude')
  }, [loaded, clis, cliId])

  useEffect(() => {
    window.fleet.recentProjects().then((p) => {
      setProjects(p)
      if (p[0]) setCwd((c) => c || p[0].cwd)
    })
    window.fleet.recentSessions().then(setSessions)
  }, [])

  async function launchNew(): Promise<void> {
    if (!cwd || busy || !cli) return
    setBusy(true)
    setError('')
    try {
      const info = await window.fleet.spawn({
        cwd,
        cli: cli.id,
        initialPrompt: prompt.trim() || undefined,
        permissionMode: permissionMode === 'default' ? undefined : permissionMode,
        model: cli.supports.model && model.trim() ? model.trim() : undefined,
        autoShip: cli.supports.standingOrders ? autoShip : false,
        linear: canLinear && linear,
        linearIssue: canLinear && linear ? linearIssue.trim() || undefined : undefined,
        worktree,
        worktreeName: worktree ? worktreeName.trim() || undefined : undefined
      })
      props.onLaunched(info.ptyId, info.pid)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function resume(s: RecentSession): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const def = clis.find((c) => c.id === s.cli)
      const info = await window.fleet.spawn({
        cwd: s.cwd,
        cli: s.cli,
        resumeSessionId: s.sessionId,
        autoShip: def ? def.supports.standingOrders && autoShip : autoShip,
        linear: def?.kind === 'claude' && linear
      })
      props.onLaunched(info.ptyId, info.pid)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // only Claude Code carries the Linear MCP connector today
  const canLinear = cli?.kind === 'claude' && !!cli.supports.standingOrders

  const worktreeNote = cli?.supports.nativeWorktree
    ? "A folder has one checked-out branch, so clones sharing one commit to the same branch and land in one PR no matter how carefully they work. Give this clone its own tree and it gets its own branch, its own PR, and can't collide with a sibling at all. Needs a git repo."
    : `${cli?.label ?? 'This CLI'} has no worktree flag of its own, so Kamino makes the tree: <repo>/.kamino/worktrees/<name> on branch worktree-<name>, and the clone starts inside it. Needs a git repo.`

  const ordersNote =
    cli?.kind === 'codex'
      ? 'Finishing includes shipping — commit, push, and open (or update) a PR without being asked, with anything unfinished logged as follow-ups. Rides in as developer instructions (-c developer_instructions), so it holds for the whole session. Skipped on main/master and in repos with no remote.'
      : 'Finishing includes shipping — commit, push, and open (or update) a PR without being asked, with anything unfinished logged as follow-ups. Skipped on main/master and in repos with no remote.'

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs">
          <button className={`modal-tab${tab === 'new' ? ' active' : ''}`} onClick={() => setTab('new')}>
            Commission clone
          </button>
          <button
            className={`modal-tab${tab === 'resume' ? ' active' : ''}`}
            onClick={() => setTab('resume')}
          >
            Reawaken session
          </button>
          <button className="modal-close" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {tab === 'new' ? (
          <div className="modal-body">
            <div className="field">
              <label className="section-label">CLI</label>
              <div className="cli-picker" role="radiogroup" aria-label="Which CLI runs this clone">
                {clis.map((c) => {
                  const st = status[c.id]
                  const missing = loaded && st && !st.installed
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="radio"
                      aria-checked={c.id === cliId}
                      className={`cli-opt${c.id === cliId ? ' active' : ''}`}
                      data-missing={missing ? 'yes' : undefined}
                      title={
                        !st
                          ? c.label
                          : st.installed
                            ? `${c.label}${st.version ? ` ${st.version}` : ''}\n${st.path ?? ''}`
                            : `${c.label} — ${st.error ?? 'not found'}`
                      }
                      onClick={() => setCliId(c.id)}
                    >
                      <CliMark kind={c.kind} cli={c.id} title={c.label} />
                      <span>{c.label}</span>
                      <span className="cli-status" aria-hidden />
                    </button>
                  )
                })}
                <button type="button" className="btn cli-manage" onClick={() => setShowManage(true)}>
                  ⚙ Manage
                </button>
              </div>
              {cliStatus && !cliStatus.installed && (
                <div className="cli-missing-note">
                  {cli?.label} isn&apos;t installed here ({cliStatus.error ?? 'not found'}). Fix the command
                  under Manage, or install it — commissioning will fail until then.
                </div>
              )}
              {cli?.kind === 'custom' && (
                <div className="cli-missing-note muted">
                  Custom CLI — Kamino hosts and commands its terminal, but can&apos;t read a transcript, so
                  the card shows no activity, title or rot.
                </div>
              )}
            </div>
            <div className="field">
              <label className="section-label">Folder</label>
              <div className="folder-row">
                <select value={cwd} onChange={(e) => setCwd(e.target.value)}>
                  {!projects.some((p) => p.cwd === cwd) && cwd && <option value={cwd}>{cwd}</option>}
                  {projects.map((p) => (
                    <option key={p.cwd} value={p.cwd}>
                      {p.cwd}
                    </option>
                  ))}
                </select>
                <button
                  className="btn"
                  onClick={async () => {
                    const picked = await window.fleet.pickFolder()
                    if (picked) setCwd(picked)
                  }}
                >
                  Browse…
                </button>
              </div>
            </div>
            <div className="field">
              <label className="section-label">First prompt (optional)</label>
              <textarea
                rows={3}
                placeholder="The clone's mission — what should it start working on?"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            {cli && cli.permissionModes.length > 0 && (
              <div className="field">
                <label className="section-label">Permissions</label>
                <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
                  {cli.permissionModes.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {cli?.supports.model && (
              <div className="field">
                <label className="section-label">Model (optional)</label>
                <input
                  type="text"
                  list="fleet-model-suggestions"
                  placeholder={`${cli.label}'s default`}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                <datalist id="fleet-model-suggestions">
                  {(cli.modelSuggestions ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
            )}
            <label className="field auto-ship" title="git worktree add — its own directory and branch off this repo">
              <span className="auto-ship-top">
                <input
                  type="checkbox"
                  checked={worktree}
                  onChange={(e) => setWorktree(e.target.checked)}
                />
                <span className="section-label">Own worktree — its own branch and PR</span>
              </span>
              <span className="auto-ship-note">{worktreeNote}</span>
              {worktree && (
                <input
                  className="worktree-name"
                  type="text"
                  placeholder="worktree name (optional) — e.g. rot-bar-fix"
                  value={worktreeName}
                  onChange={(e) => setWorktreeName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
            </label>
            {cli?.supports.standingOrders && (
              <label className="field auto-ship" title="Appended to the clone's system prompt, so it holds for the whole session">
                <span className="auto-ship-top">
                  <input
                    type="checkbox"
                    checked={autoShip}
                    onChange={(e) => setAutoShip(e.target.checked)}
                  />
                  <span className="section-label">Standing orders: ship its own work</span>
                </span>
                <span className="auto-ship-note">{ordersNote}</span>
              </label>
            )}
            {cli?.supports.standingOrders && (
              <label
                className={`field auto-ship${canLinear ? '' : ' disabled'}`}
                title={
                  canLinear
                    ? 'Appended to the clone\u2019s system prompt, so it holds for the whole session'
                    : `${cli.label} has no Linear connector yet — Claude Code only for now`
                }
              >
                <span className="auto-ship-top">
                  <input
                    type="checkbox"
                    checked={canLinear && linear}
                    disabled={!canLinear}
                    onChange={(e) => setLinear(e.target.checked)}
                  />
                  <span className="section-label linear-label">
                    <LinearMark /> Track in Linear
                  </span>
                </span>
                <span className="auto-ship-note">
                  The clone raises an LKG issue the moment it first changes a file — never for a question, a read
                  or a plan — assigned to you and set In Progress. It carries the key into the branch, commits and
                  PR, moves it to In Review when the PR opens, and comments what shipped and what is left.
                </span>
                {canLinear && linear && (
                  <input
                    className="worktree-name"
                    type="text"
                    placeholder="pick up an existing issue (optional) — LKG-42 or a linear.app URL"
                    value={linearIssue}
                    onChange={(e) => setLinearIssue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
              </label>
            )}
            <div className="modal-actions">
              {error ? (
                <span className="recap-err">{error}</span>
              ) : (
                <span className="jedi-quote">“This is where the fun begins.”</span>
              )}
              <button className="btn primary" onClick={launchNew} disabled={!cwd || busy || !cli}>
                {busy ? 'Growing…' : 'Begin cloning'}
              </button>
            </div>
          </div>
        ) : (
          <div className="modal-body sessions-list">
            {sessions.length === 0 && (
              <div className="roster-empty">
                No sessions in the archive. These aren&apos;t the droids you&apos;re looking for.
              </div>
            )}
            {error && <div className="recap-err">{error}</div>}
            {sessions.map((s) => (
              <button key={s.sessionId} className="session-row" onClick={() => resume(s)}>
                <span className="session-title">
                  <CliMark kind={cliKindOf(s.cli)} cli={s.cli} />
                  {s.title || s.lastPrompt || s.sessionId}
                </span>
                <span className="session-meta">
                  {s.cwd.split(/[\\/]/).pop()}
                  {s.gitBranch ? ` · ${s.gitBranch}` : ''}
                  {s.prs.length > 0 ? ` · PR ${s.prs.map((n) => '#' + n).join(' ')}` : ''}
                  {` · ${agoShort(s.mtime, now)} ago`}
                </span>
                {s.lastPrompt && s.title && <span className="session-prompt">“{s.lastPrompt}”</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {showManage && (
        <CliManagerDialog
          onClose={() => {
            setShowManage(false)
            void reload()
          }}
        />
      )}
    </div>
  )
}
