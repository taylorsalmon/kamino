import { useEffect, useState } from 'react'
import type { CliDefinition, CliStatus } from '../../../shared/types'
import { useClis } from '../clis'
import { CliMark } from './CliMark'

/**
 * Manage CLIs — what the launch dialog can commission a clone on. The two
 * built-ins (Claude Code, Codex) can have their command re-pointed when a CLI
 * lives somewhere odd; custom CLIs can be added, edited and removed. Every row
 * shows whether the command actually resolves on this machine, because the
 * usual failure is "typed the name right, it isn't on PATH".
 */

interface Draft {
  id?: string
  builtin: boolean
  label: string
  command: string
  /** space-separated; {cwd} substituted */
  extraArgs: string
  /** space-separated; {id} substituted; empty = cannot resume */
  resumeArgs: string
  promptStyle: 'positional' | 'flag' | 'none'
  promptFlag: string
  letter: string
  color: string
  approveKeys: string
  model: boolean
}

function splitArgs(s: string): string[] {
  // "quoted strings" stay one argument; everything else splits on whitespace
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

function joinArgs(a: string[] | undefined): string {
  return (a ?? []).map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')
}

function toDraft(def: CliDefinition): Draft {
  return {
    id: def.id,
    builtin: def.builtin,
    label: def.label,
    command: def.command,
    extraArgs: joinArgs(def.extraArgs),
    resumeArgs: joinArgs(def.resumeArgs),
    promptStyle: def.promptStyle ?? 'positional',
    promptFlag: def.promptFlag ?? '',
    letter: def.brand.letter ?? def.label.slice(0, 2).toUpperCase(),
    color: def.brand.color,
    approveKeys: def.approveKeys === '\r' ? 'enter' : def.approveKeys,
    model: def.supports.model
  }
}

const NEW_DRAFT: Draft = {
  builtin: false,
  label: '',
  command: '',
  extraArgs: '',
  resumeArgs: '',
  promptStyle: 'positional',
  promptFlag: '',
  letter: '',
  color: '#a78bfa',
  approveKeys: 'enter',
  model: false
}

export function CliManagerDialog(props: { onClose: () => void }): React.JSX.Element {
  const { clis, status, reload } = useClis()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState<Record<string, CliStatus | 'busy'>>({})

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (draft) setDraft(null)
        else props.onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft, props])

  async function save(): Promise<void> {
    if (!draft || busy) return
    setBusy(true)
    setError('')
    try {
      if (!draft.label.trim()) throw new Error('Give it a name.')
      if (!draft.command.trim()) throw new Error('What command starts it?')
      const def: Partial<CliDefinition> = draft.builtin
        ? { id: draft.id, label: draft.label, command: draft.command }
        : {
            id: draft.id,
            label: draft.label,
            command: draft.command,
            extraArgs: splitArgs(draft.extraArgs),
            resumeArgs: splitArgs(draft.resumeArgs),
            promptStyle: draft.promptStyle,
            promptFlag: draft.promptFlag.trim() || undefined,
            brand: { mark: 'letter', letter: draft.letter.trim().slice(0, 2).toUpperCase(), color: draft.color },
            approveKeys: draft.approveKeys.trim().toLowerCase() === 'enter' ? '\r' : draft.approveKeys || '\r',
            supports: { resume: false, nativeWorktree: false, standingOrders: false, model: draft.model },
            resumeTemplate: draft.resumeArgs.trim() ? `${draft.command} ${draft.resumeArgs.trim()}` : undefined
          }
      await window.fleet.clisSave(def)
      await reload()
      setDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(def: CliDefinition): Promise<void> {
    if (!(await window.fleet.confirm(`Remove ${def.label}?`, 'Clones already running on it are unaffected.'))) return
    await window.fleet.clisRemove(def.id)
    await reload()
  }

  async function detect(id: string): Promise<void> {
    setChecking((m) => ({ ...m, [id]: 'busy' }))
    const st = await window.fleet.clisDetect(id)
    setChecking((m) => ({ ...m, [id]: st }))
    await reload()
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void => setDraft((d) => (d ? { ...d, [k]: v } : d))

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal clis" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs">
          <span className="modal-tab active">MANAGE CLIs</span>
          <button className="modal-close" onClick={props.onClose}>
            ✕ esc
          </button>
        </div>
        <div className="modal-body">
          <div className="cli-intro">
            The CLIs a clone can be grown on. Built-ins carry full telemetry (activity, titles, rot);
            a custom CLI is hosted and commanded but not read.
          </div>
          {clis.map((c) => {
            const live = checking[c.id]
            const st = live && live !== 'busy' ? live : status[c.id]
            return (
              <div key={c.id} className="cli-row" data-kind={c.kind}>
                <CliMark kind={c.kind} cli={c.id} />
                <div className="cli-row-main">
                  <div className="cli-row-label">
                    {c.label}
                    {c.builtin && <span className="cli-row-tag">built-in</span>}
                    {st?.version && <span className="cli-row-ver">{st.version}</span>}
                  </div>
                  <div className="cli-row-cmd" title={st?.path ?? c.command}>
                    {c.command}
                    {st?.path && st.path !== c.command ? ` → ${st.path}` : ''}
                  </div>
                </div>
                <span className="cli-row-status" data-ok={live === 'busy' ? undefined : st ? (st.installed ? 'yes' : 'no') : undefined}>
                  {live === 'busy' ? 'checking…' : !st ? '' : st.installed ? '● installed' : `○ ${st.error ?? 'not found'}`}
                </span>
                <div className="cli-row-actions">
                  <button className="btn" title="Look for it again" onClick={() => detect(c.id)}>
                    ↻
                  </button>
                  <button className="btn" onClick={() => setDraft(toDraft(c))}>
                    Edit
                  </button>
                  {!c.builtin && (
                    <button className="btn danger" onClick={() => remove(c)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {!draft && (
            <div className="actions" style={{ marginTop: 10 }}>
              <button className="btn primary" onClick={() => setDraft({ ...NEW_DRAFT })}>
                + Add a CLI
              </button>
            </div>
          )}

          {draft && (
            <div className="cli-form">
              <div className="field">
                <label className="section-label">Name</label>
                <input type="text" value={draft.label} onChange={(e) => set('label', e.target.value)} placeholder="Gemini CLI" />
              </div>
              <div className="field">
                <label className="section-label">Command</label>
                <input
                  type="text"
                  value={draft.command}
                  onChange={(e) => set('command', e.target.value)}
                  placeholder="gemini — a name on PATH, or a full path to an .exe"
                />
              </div>
              {draft.builtin ? (
                <div className="field wide cli-form-note">
                  Built-in: only the name and command can change. Point the command at a full path when the
                  CLI isn&apos;t on PATH (Codex Desktop&apos;s bundled <code>codex.exe</code> is found
                  automatically).
                </div>
              ) : (
                <>
                  <div className="field">
                    <label className="section-label">Always pass</label>
                    <input
                      type="text"
                      value={draft.extraArgs}
                      onChange={(e) => set('extraArgs', e.target.value)}
                      placeholder='--yolo --cwd {cwd}   ("quote" to keep spaces)'
                    />
                  </div>
                  <div className="field">
                    <label className="section-label">Resume with</label>
                    <input
                      type="text"
                      value={draft.resumeArgs}
                      onChange={(e) => set('resumeArgs', e.target.value)}
                      placeholder="--resume {id}   (blank = no resume)"
                    />
                  </div>
                  <div className="field">
                    <label className="section-label">First prompt goes</label>
                    <select value={draft.promptStyle} onChange={(e) => set('promptStyle', e.target.value as Draft['promptStyle'])}>
                      <option value="positional">as the last argument</option>
                      <option value="flag">behind a flag</option>
                      <option value="none">nowhere — the CLI takes no prompt</option>
                    </select>
                  </div>
                  <div className="field">
                    <label className="section-label">Prompt flag</label>
                    <input
                      type="text"
                      value={draft.promptFlag}
                      disabled={draft.promptStyle !== 'flag'}
                      onChange={(e) => set('promptFlag', e.target.value)}
                      placeholder="--prompt"
                    />
                  </div>
                  <div className="field">
                    <label className="section-label">Badge</label>
                    <div className="cli-badge-row">
                      <input
                        type="text"
                        maxLength={2}
                        value={draft.letter}
                        onChange={(e) => set('letter', e.target.value)}
                        placeholder="GE"
                        className="cli-letter-input"
                      />
                      <input type="color" value={draft.color} onChange={(e) => set('color', e.target.value)} />
                      <span className="cli-mark" data-kind="custom" style={{ color: draft.color }}>
                        <span className="cli-letter">{draft.letter.slice(0, 2).toUpperCase() || 'CL'}</span>
                      </span>
                    </div>
                  </div>
                  <div className="field">
                    <label className="section-label">Approve keystroke</label>
                    <input
                      type="text"
                      value={draft.approveKeys}
                      onChange={(e) => set('approveKeys', e.target.value)}
                      placeholder="enter, y, 1 …"
                      title="What the ✓ Approve button types into its terminal"
                    />
                  </div>
                  <label className="field auto-ship wide">
                    <span className="auto-ship-top">
                      <input type="checkbox" checked={draft.model} onChange={(e) => set('model', e.target.checked)} />
                      <span className="section-label">Takes --model</span>
                    </span>
                  </label>
                </>
              )}
              <div className="modal-actions wide">
                {error && <span className="recap-err">{error}</span>}
                <button className="btn" onClick={() => setDraft(null)} disabled={busy}>
                  Cancel
                </button>
                <button className="btn primary" onClick={save} disabled={busy}>
                  {busy ? 'Saving…' : draft.id ? 'Save' : 'Add'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
