import { useEffect, useState } from 'react'
import type { PtyInfo, RecentProject, RemoteCli } from '../../shared/types'
import { api } from './api'

/**
 * Commission from the phone: same orders the desktop launch dialog gives —
 * which CLI, which project, the first prompt, and the standing orders —
 * through the same main-process path, so the clone is indistinguishable.
 */

function remembered(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === 'on'
  } catch {
    return fallback
  }
}
function remember(key: string, v: boolean | string): void {
  try {
    localStorage.setItem(key, typeof v === 'boolean' ? (v ? 'on' : 'off') : v)
  } catch {
    /* ignore */
  }
}

export function Commission(props: { onClose: () => void; onLaunched: (ptyId: string) => void }): React.JSX.Element {
  const [clis, setClis] = useState<RemoteCli[] | null>(null)
  const [projects, setProjects] = useState<RecentProject[] | null>(null)
  const [cliId, setCliId] = useState(() => localStorage.getItem('kamino:cli') || 'claude')
  const [cwd, setCwd] = useState('')
  const [prompt, setPrompt] = useState('')
  const [permissionMode, setPermissionMode] = useState('default')
  const [model, setModel] = useState('')
  const [worktree, setWorktree] = useState(false)
  const [autoShip, setAutoShip] = useState(() => remembered('kamino:autoShip', true))
  const [linear, setLinear] = useState(() => remembered('kamino:linear', true))
  const [linearIssue, setLinearIssue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api<RemoteCli[]>('clis').then(setClis, (e) => setError(e.message))
    api<RecentProject[]>('projects').then(
      (p) => {
        setProjects(p)
        setCwd((c) => c || p[0]?.cwd || '')
      },
      (e) => setError(e.message)
    )
  }, [])

  const cli = clis?.find((c) => c.id === cliId) ?? clis?.find((c) => c.id === 'claude') ?? clis?.[0]
  const canLinear = cli?.kind === 'claude'

  useEffect(() => {
    setPermissionMode('default')
    setModel('')
  }, [cliId])

  async function launch(): Promise<void> {
    if (!cli || !cwd || busy) return
    setBusy(true)
    setError('')
    remember('kamino:cli', cli.id)
    remember('kamino:autoShip', autoShip)
    remember('kamino:linear', linear)
    try {
      const info = await api<PtyInfo>('commission', {
        cwd,
        cli: cli.id,
        initialPrompt: prompt.trim() || undefined,
        permissionMode: permissionMode === 'default' ? undefined : permissionMode,
        model: cli.supports.model && model.trim() ? model.trim() : undefined,
        autoShip: cli.supports.standingOrders ? autoShip : false,
        linear: canLinear && linear,
        linearIssue: canLinear && linear ? linearIssue.trim() || undefined : undefined,
        worktree
      })
      props.onLaunched(info.ptyId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const folder = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

  return (
    <div className="screen sheet">
      <header className="bar">
        <button className="icon-btn" onClick={props.onClose} aria-label="Cancel">
          ✕
        </button>
        <span className="bar-title">Commission a clone</span>
      </header>

      <main className="scroll form">
        {clis && clis.length > 1 && (
          <section>
            <h3>Runs on</h3>
            <div className="seg">
              {clis.map((c) => (
                <button
                  key={c.id}
                  className={c.id === cli?.id ? 'on' : ''}
                  disabled={!c.installed}
                  onClick={() => setCliId(c.id)}
                  style={c.id === cli?.id ? { borderColor: c.brand.color } : undefined}
                >
                  {c.label}
                  {!c.installed && <small> · not installed</small>}
                </button>
              ))}
            </div>
          </section>
        )}

        <section>
          <h3>Project</h3>
          {projects === null && <div className="empty small">Loading recent projects…</div>}
          {projects?.length === 0 && (
            <div className="empty small">No recent projects. Start one clone from the desktop first.</div>
          )}
          <div className="pick-list">
            {projects?.map((p) => (
              <button key={p.cwd} className={`pick${p.cwd === cwd ? ' on' : ''}`} onClick={() => setCwd(p.cwd)}>
                <span className="pick-name">{folder(p.cwd)}</span>
                <span className="pick-path">{p.cwd}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>Orders</h3>
          <textarea
            className="orders"
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should it do? Leave empty to start it idle."
          />
        </section>

        <section>
          <h3>Standing orders</h3>
          <label className="toggle">
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
            <span>
              <b>Own worktree</b>
              <small>its own branch and PR, so it can&apos;t collide with other clones in this repo</small>
            </span>
          </label>
          {cli?.supports.standingOrders && (
            <label className="toggle">
              <input type="checkbox" checked={autoShip} onChange={(e) => setAutoShip(e.target.checked)} />
              <span>
                <b>Ship when done</b>
                <small>commit, push and raise a PR without being asked</small>
              </span>
            </label>
          )}
          {canLinear && (
            <label className="toggle">
              <input type="checkbox" checked={linear} onChange={(e) => setLinear(e.target.checked)} />
              <span>
                <b>Track in Linear</b>
                <small>raises its own issue, assigned to you, and keeps it current</small>
              </span>
            </label>
          )}
          {canLinear && linear && (
            <input
              className="text"
              value={linearIssue}
              onChange={(e) => setLinearIssue(e.target.value)}
              placeholder="Existing issue (LKG-42), optional"
              autoCapitalize="characters"
            />
          )}
        </section>

        {cli && (cli.permissionModes.length > 0 || cli.supports.model) && (
          <details className="more">
            <summary>Permissions &amp; model</summary>
            {cli.permissionModes.length > 0 && (
              <label className="field">
                <span>Permission mode</span>
                <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
                  {cli.permissionModes.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {cli.supports.model && (
              <label className="field">
                <span>Model</span>
                <input
                  className="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="CLI default"
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </label>
            )}
          </details>
        )}

        {error && <div className="err static">{error}</div>}
      </main>

      <footer className="dock">
        <button className="btn primary big" disabled={!cli || !cwd || busy} onClick={() => void launch()}>
          {busy ? 'Commissioning…' : `Commission on ${cli?.label ?? '…'}`}
        </button>
      </footer>
    </div>
  )
}
