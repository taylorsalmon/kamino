/**
 * The CLI registry, renderer side — one shared copy of the definitions and
 * their installed/not-installed status, loaded once and pushed to every
 * component that asked. Brand marks and one-click keystrokes read from it, so
 * a pane never has to be told which CLI it hosts beyond the instance's own id.
 */
import { useEffect, useState } from 'react'
import type { CliDefinition, CliKind, CliStatus } from '../../shared/types'

export interface CliState {
  clis: CliDefinition[]
  status: Record<string, CliStatus>
  loaded: boolean
}

let state: CliState = { clis: [], status: {}, loaded: false }
const listeners = new Set<(s: CliState) => void>()
let inflight: Promise<CliState> | null = null

export function loadClis(force = false): Promise<CliState> {
  if (inflight) return inflight
  if (state.loaded && !force) return Promise.resolve(state)
  inflight = window.fleet
    .clisList()
    .then((r) => {
      state = { clis: r.clis, status: r.status, loaded: true }
      for (const l of listeners) l(state)
      return state
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function useClis(): CliState & { reload: () => Promise<CliState> } {
  const [s, setS] = useState(state)
  useEffect(() => {
    listeners.add(setS)
    if (state.loaded) setS(state)
    else void loadClis()
    return () => {
      listeners.delete(setS)
    }
  }, [])
  return { ...s, reload: () => loadClis(true) }
}

export function cliDef(id: string | undefined): CliDefinition | undefined {
  return id ? state.clis.find((c) => c.id === id) : undefined
}

/** the kind behind a CLI id, with the built-ins known before the registry loads */
export function cliKindOf(id: string | undefined): CliKind {
  const def = cliDef(id)
  if (def) return def.kind
  return id === 'codex' ? 'codex' : id === 'claude' || !id ? 'claude' : 'custom'
}

export function cliLabel(id: string | undefined, kind?: CliKind): string {
  const def = cliDef(id)
  if (def) return def.label
  const k = kind ?? cliKindOf(id)
  return k === 'codex' ? 'Codex' : k === 'claude' ? 'Claude Code' : (id ?? 'CLI')
}

/** keystrokes that answer an approval prompt in this clone's terminal —
 *  Claude's picker takes 1, Codex's modal takes Enter on the highlighted Allow */
export function approveKeys(inst: { cli: string; cliKind: CliKind }): string {
  return cliDef(inst.cli)?.approveKeys ?? (inst.cliKind === 'codex' ? '\r' : '1')
}

/** the clipboard form of "resume this session" */
export function resumeCommand(inst: { cli: string; cliKind: CliKind; sessionId: string }): string {
  const t =
    cliDef(inst.cli)?.resumeTemplate ??
    (inst.cliKind === 'codex' ? 'codex resume {id}' : inst.cliKind === 'claude' ? 'claude --resume {id}' : '')
  return t.replace('{id}', inst.sessionId)
}
