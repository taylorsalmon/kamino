import { useEffect, useState } from 'react'
import type { RecentProject, RecentSession } from '../../../shared/types'
import { agoShort } from '../format'

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
  // standing orders live in the clone's system prompt, so the choice is made
  // once at commission time and can't be forgotten later in the session
  const [autoShip, setAutoShip] = useState(
    () => localStorage.getItem('fleet:auto-ship') !== 'off'
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const now = Date.now()

  useEffect(() => {
    localStorage.setItem('fleet:auto-ship', autoShip ? 'on' : 'off')
  }, [autoShip])

  useEffect(() => {
    window.fleet.recentProjects().then((p) => {
      setProjects(p)
      if (p[0]) setCwd((c) => c || p[0].cwd)
    })
    window.fleet.recentSessions().then(setSessions)
  }, [])

  async function launchNew(): Promise<void> {
    if (!cwd || busy) return
    setBusy(true)
    setError('')
    try {
      const info = await window.fleet.spawn({
        cwd,
        initialPrompt: prompt.trim() || undefined,
        permissionMode: permissionMode === 'default' ? undefined : permissionMode,
        autoShip
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
      const info = await window.fleet.spawn({
        cwd: s.cwd,
        resumeSessionId: s.sessionId,
        autoShip
      })
      props.onLaunched(info.ptyId, info.pid)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

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
            <div className="field">
              <label className="section-label">Permissions</label>
              <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
                <option value="default">default — ask as needed</option>
                <option value="plan">plan — read-only until approved</option>
                <option value="acceptEdits">acceptEdits — edits allowed, asks for commands</option>
                <option value="bypassPermissions">auto — never asks, full autonomy</option>
              </select>
            </div>
            <label className="field auto-ship" title="Appended to the clone's system prompt, so it holds for the whole session">
              <span className="auto-ship-top">
                <input
                  type="checkbox"
                  checked={autoShip}
                  onChange={(e) => setAutoShip(e.target.checked)}
                />
                <span className="section-label">Standing orders: ship its own work</span>
              </span>
              <span className="auto-ship-note">
                Finishing includes shipping — commit, push, and open (or update) a PR without being
                asked, with anything unfinished logged as follow-ups. Skipped on main/master and in
                repos with no remote.
              </span>
            </label>
            <div className="modal-actions">
              {error ? (
                <span className="recap-err">{error}</span>
              ) : (
                <span className="jedi-quote">“This is where the fun begins.”</span>
              )}
              <button className="btn primary" onClick={launchNew} disabled={!cwd || busy}>
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
            {sessions.map((s) => (
              <button key={s.sessionId} className="session-row" onClick={() => resume(s)}>
                <span className="session-title">{s.title || s.lastPrompt || s.sessionId}</span>
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
    </div>
  )
}
