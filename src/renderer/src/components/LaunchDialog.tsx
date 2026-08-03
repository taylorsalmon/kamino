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
  const [busy, setBusy] = useState(false)
  const now = Date.now()

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
    try {
      const info = await window.fleet.spawn({
        cwd,
        initialPrompt: prompt.trim() || undefined,
        permissionMode: permissionMode === 'default' ? undefined : permissionMode
      })
      props.onLaunched(info.ptyId, info.pid)
    } finally {
      setBusy(false)
    }
  }

  async function resume(s: RecentSession): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const info = await window.fleet.spawn({ cwd: s.cwd, resumeSessionId: s.sessionId })
      props.onLaunched(info.ptyId, info.pid)
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
              </select>
            </div>
            <div className="modal-actions">
              <span className="jedi-quote">“This is where the fun begins.”</span>
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
