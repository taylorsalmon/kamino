/**
 * CliRegistry — which coding-agent CLIs Kamino can commission clones on, how
 * each is launched, and whether it is actually installed on this machine.
 *
 * Two ship built in: Claude Code and Codex. Anything else (Gemini CLI, aider,
 * opencode, a plain shell wrapper) can be added as a custom CLI from the launch
 * dialog — Kamino hosts and commands its terminal but cannot read it, because
 * there is no transcript adapter for it. Definitions live in userData/clis.json;
 * the built-ins are code, with only their label and command overridable there.
 *
 * Everything that turns a LaunchRequest into an argv lives here (buildArgs), so
 * a CLI flag change is a one-place fix and `npm test` can pin the shapes.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CliDefinition, CliStatus } from '../shared/types'

/**
 * Standing orders, appended to the clone's system prompt rather than typed as a
 * first prompt: a system prompt can't rot out of the context window as the
 * session grows, and it costs no turn. Claude takes it via
 * --append-system-prompt, Codex via -c developer_instructions.
 *
 * Kept free of double quotes and % so it survives being quoted onto a Windows
 * command line.
 */
export const AUTO_SHIP_ORDERS =
  'Shipping is part of finishing. When you complete a piece of work, do not stop at the last edit and ' +
  'do not ask whether to ship it: commit the change with a clear message, push the branch, and open a ' +
  'pull request (or update the one already open) describing what changed and what is left. If the work ' +
  'is incomplete or known-broken, still commit and push it, and record the gaps in a Follow-ups section ' +
  'of the PR description. Never leave finished work uncommitted or unpushed. The exceptions, where you ' +
  'should not push or open a PR: you are on the repo default branch (main or master), the repo has no ' +
  'git remote, or the user has told you not to.'

/**
 * Standing orders for Linear tracking. The judgement of "does this need a
 * ticket" is left to the clone under one rule: nothing until it is about to
 * change a file. Questions, reading and planning never raise an issue.
 * Free of double quotes and % for the same reason as the orders above.
 */
export const LINEAR_ORDERS =
  'Track this work in Linear, team LKG, with the Linear MCP tools. Do not touch Linear until you are about to ' +
  'create or edit a file for the first time in this session - reading, answering questions, explaining and ' +
  'planning need no issue, and if the task turns out to need no code change, create nothing. At that moment, ' +
  'if no issue is attached yet: when the user named one (a key like LKG-42 or a linear.app URL) use it; ' +
  'otherwise search the team for an open issue that clearly describes this same work and use it if there is ' +
  'one; otherwise create one with a short imperative title and a description of the goal and approach. ' +
  'Either way, save it with assignee me and state In Progress, and tell the user in one line which issue you ' +
  'are tracking. Then keep it current: put the key in any branch you create, in commit messages, and in the ' +
  'pull request title or body as Fixes KEY so Linear links them; move it to In Review when a PR is open; ' +
  'when you finish or ship, comment on the issue with what changed, what was verified and what remains, and ' +
  'create sub-issues for follow-ups you are leaving. If the user tells you not to track this, stop and create nothing.'

/** The variant when the user named the issue on the launch dialog. */
export function linearOrdersFor(issue?: string): string {
  const key = issue?.trim()
  return key ? `${LINEAR_ORDERS} The user has asked you to work under Linear issue ${key}.` : LINEAR_ORDERS
}

/**
 * Compose the clone's standing orders. A CLI takes one system-prompt flag, so
 * every order that applies is joined into a single string here.
 */
export function composeOrders(o: {
  autoShip?: boolean
  linear?: boolean
  linearIssue?: string
  extra?: string
}): string | undefined {
  const parts: string[] = []
  if (o.autoShip !== false) parts.push(AUTO_SHIP_ORDERS)
  if (o.linear) parts.push(linearOrdersFor(o.linearIssue))
  if (o.extra) parts.push(o.extra)
  return parts.length ? parts.join(' ') : undefined
}

export const CLAUDE_CLI: CliDefinition = {
  id: 'claude',
  kind: 'claude',
  label: 'Claude Code',
  command: 'claude',
  brand: { mark: 'claude', color: '#d97757' },
  builtin: true,
  permissionModes: [
    { value: 'default', label: 'default — ask as needed', args: [] },
    { value: 'plan', label: 'plan — read-only until approved', args: ['--permission-mode', 'plan'] },
    {
      value: 'acceptEdits',
      label: 'acceptEdits — edits allowed, asks for commands',
      args: ['--permission-mode', 'acceptEdits']
    },
    {
      value: 'bypassPermissions',
      label: 'auto — never asks, full autonomy',
      args: ['--permission-mode', 'bypassPermissions']
    }
  ],
  supports: { resume: true, nativeWorktree: true, standingOrders: true, model: true },
  modelSuggestions: ['opus', 'sonnet', 'haiku'],
  // the permission prompt is a numbered picker; 1 is always "yes"
  approveKeys: '1',
  resumeTemplate: 'claude --resume {id}'
}

export const CODEX_CLI: CliDefinition = {
  id: 'codex',
  kind: 'codex',
  label: 'Codex',
  command: 'codex',
  brand: { mark: 'openai', color: '#e8edf2' },
  builtin: true,
  // Codex has two axes (approval policy × sandbox) — these are the useful
  // combinations, named the way its own flags name them
  permissionModes: [
    { value: 'default', label: 'default — your config.toml (asks on request)', args: [] },
    { value: 'read-only', label: 'read-only — sandboxed, cannot write files', args: ['--sandbox', 'read-only'] },
    {
      value: 'workspace-write',
      label: 'workspace-write — edits inside the folder, asks beyond it',
      args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
    },
    {
      value: 'approve-for-me',
      label: 'approve for me — automatic review, workspace sandbox',
      args: ['--approve-for-me']
    },
    {
      value: 'yolo',
      label: 'auto — no approvals, no sandbox',
      args: ['--dangerously-bypass-approvals-and-sandbox']
    }
  ],
  supports: { resume: true, nativeWorktree: false, standingOrders: true, model: true },
  // the approval modal highlights "Allow" first, so Enter takes it
  approveKeys: '\r',
  resumeTemplate: 'codex resume {id}'
}

const BUILTINS: CliDefinition[] = [CLAUDE_CLI, CODEX_CLI]

/** What buildArgs needs to know about one launch. */
export interface ArgOptions {
  cwd?: string
  resumeSessionId?: string
  initialPrompt?: string
  /** a value from the CLI's permissionModes; 'default'/undefined adds nothing */
  permissionMode?: string
  model?: string
  /** text for the system prompt — already chosen by the caller */
  standingOrders?: string
  /** Claude only: let the CLI make its own worktree */
  worktree?: boolean
  worktreeName?: string
}

/** A TOML basic string — what `-c key=value` wants for a string value. */
export function tomlString(s: string): string {
  const body = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  return `"${body}"`
}

/** Argv (after the executable) for one launch of `def`. Pure — see the test. */
export function buildArgs(def: CliDefinition, o: ArgOptions): string[] {
  const args: string[] = []
  const mode = o.permissionMode && o.permissionMode !== 'default' ? o.permissionMode : undefined
  const modeArgs = mode
    ? (def.permissionModes.find((m) => m.value === mode)?.args ??
      // a mode Kamino doesn't list — Claude's flag takes any value the CLI knows
      (def.kind === 'claude' ? ['--permission-mode', mode] : []))
    : []

  switch (def.kind) {
    case 'claude': {
      if (o.resumeSessionId) args.push('--resume', o.resumeSessionId)
      args.push(...modeArgs)
      if (o.worktree) {
        const name = o.worktreeName?.trim()
        args.push('--worktree')
        if (name) args.push(name)
      }
      if (o.model) args.push('--model', o.model)
      if (o.standingOrders) args.push('--append-system-prompt', o.standingOrders)
      // the prompt goes last: everything after it would be read as more prompt
      if (o.initialPrompt) args.push(o.initialPrompt)
      return args
    }
    case 'codex': {
      // `codex resume [OPTIONS] [SESSION_ID] [PROMPT]` — subcommand first,
      // options, then the two positionals in order
      if (o.resumeSessionId) args.push('resume')
      args.push(...modeArgs)
      if (o.model) args.push('--model', o.model)
      if (o.standingOrders) args.push('-c', `developer_instructions=${tomlString(o.standingOrders)}`)
      if (o.resumeSessionId) args.push(o.resumeSessionId)
      if (o.initialPrompt) args.push(o.initialPrompt)
      return args
    }
    default: {
      for (const a of def.extraArgs ?? []) args.push(a.replace(/\{cwd\}/g, o.cwd ?? ''))
      if (o.resumeSessionId && def.resumeArgs?.length) {
        for (const a of def.resumeArgs) args.push(a.replace(/\{id\}/g, o.resumeSessionId))
      }
      args.push(...modeArgs)
      if (o.model) args.push('--model', o.model)
      if (o.initialPrompt) {
        const style = def.promptStyle ?? 'positional'
        if (style === 'flag') args.push(def.promptFlag || '--prompt', o.initialPrompt)
        else if (style === 'positional') args.push(o.initialPrompt)
      }
      return args
    }
  }
}

/** How to actually start a resolved command: the file for CreateProcess and
 *  any arguments that must precede the CLI's own. */
export interface Resolved {
  file: string
  prefixArgs: string[]
  /** what to show the user as "where it is" */
  shown: string
}

/** Trim what cmd.exe/where.exe would take as syntax rather than text. */
function safeName(s: string): string {
  return s.replace(/["%&^|<>()]/g, '').trim()
}

function whereExe(name: string): string[] {
  try {
    const out = execFileSync('where.exe', [safeName(name)], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * An npm `.cmd` shim can't be CreateProcess'd directly. Read it for the script
 * it launches and run that under node ourselves — cleaner than a cmd.exe hop,
 * whose quoting rules would eat a prompt with a `"` in it.
 */
function shimEntry(cmdPath: string): string | null {
  try {
    const text = fs.readFileSync(cmdPath, 'utf-8')
    const m = /"%dp0%\\([^"]+\.(?:c|m)?js)"/i.exec(text) ?? /%dp0%\\(\S+\.(?:c|m)?js)/i.exec(text)
    if (!m) return null
    const p = path.join(path.dirname(cmdPath), m[1])
    return fs.existsSync(p) ? p : null
  } catch {
    return null
  }
}

function nodeExe(): string {
  return whereExe('node').find((h) => /\.exe$/i.test(h)) ?? 'node.exe'
}

function launchFor(file: string): Resolved {
  if (/\.(cmd|bat)$/i.test(file)) {
    const js = shimEntry(file)
    if (js) return { file: nodeExe(), prefixArgs: [js], shown: js }
    return { file: 'cmd.exe', prefixArgs: ['/d', '/c', file], shown: file }
  }
  if (/\.ps1$/i.test(file)) {
    return {
      file: 'powershell.exe',
      prefixArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      shown: file
    }
  }
  return { file, prefixArgs: [], shown: file }
}

/**
 * Codex Desktop bundles the CLI but never puts it on PATH. The folder under
 * bin/ is a build hash that changes with every update, so take the newest.
 */
function codexDesktopBinary(): string | null {
  const local = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local')
  const root = path.join(local, 'OpenAI', 'Codex', 'bin')
  let best: { p: string; m: number } | null = null
  try {
    for (const dir of fs.readdirSync(root)) {
      const p = path.join(root, dir, 'codex.exe')
      try {
        const m = fs.statSync(p).mtimeMs
        if (!best || m > best.m) best = { p, m }
      } catch {
        /* not this one */
      }
    }
  } catch {
    return null
  }
  return best?.p ?? null
}

const resolveCache = new Map<string, { at: number; res: Resolved | null }>()
const RESOLVE_TTL_MS = 30_000

/** Where `def.command` actually is, or null when it isn't on this machine.
 *  Synchronous so PtyManager.spawn can stay synchronous; cached briefly. A
 *  miss is not cached, so installing the CLI is picked up on the next try. */
export function resolveCommand(def: CliDefinition): Resolved | null {
  const key = `${def.kind}:${def.command}`
  const hit = resolveCache.get(key)
  if (hit && hit.res && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.res
  const res = resolveUncached(def)
  resolveCache.set(key, { at: Date.now(), res })
  return res
}

function resolveUncached(def: CliDefinition): Resolved | null {
  const cmd = def.command.trim()
  if (!cmd) return null
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? launchFor(cmd) : null
  const hits = whereExe(cmd)
  const pick = hits.find((h) => /\.exe$/i.test(h)) ?? hits.find((h) => /\.(cmd|bat)$/i.test(h)) ?? hits[0]
  if (pick) return launchFor(pick)
  if (def.kind === 'codex') {
    const bundled = codexDesktopBinary()
    if (bundled) return launchFor(bundled)
  }
  return null
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cli'
}

/** Fill in what a custom definition may leave out, so the rest of the app can
 *  read every field without null checks. */
function normalize(raw: Partial<CliDefinition>, existingIds: Set<string>): CliDefinition {
  const label = (raw.label ?? '').trim() || 'Custom CLI'
  let id = (raw.id ?? '').trim()
  if (!id) {
    const base = `custom-${slug(label)}`
    id = base
    for (let n = 2; existingIds.has(id); n++) id = `${base}-${n}`
  }
  const letter = (raw.brand?.letter ?? label.slice(0, 2)).trim().slice(0, 2).toUpperCase() || 'CL'
  const color = raw.brand?.color ?? ''
  const resumeArgs = Array.isArray(raw.resumeArgs) ? raw.resumeArgs.filter((a) => typeof a === 'string' && a) : []
  return {
    id,
    kind: 'custom',
    label,
    command: (raw.command ?? '').trim(),
    brand: { mark: 'letter', letter, color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#a78bfa' },
    builtin: false,
    permissionModes: Array.isArray(raw.permissionModes) ? raw.permissionModes : [],
    supports: {
      resume: resumeArgs.length > 0,
      nativeWorktree: false,
      standingOrders: false,
      model: raw.supports?.model === true
    },
    modelSuggestions: raw.modelSuggestions,
    approveKeys: typeof raw.approveKeys === 'string' && raw.approveKeys ? raw.approveKeys : '\r',
    resumeTemplate: raw.resumeTemplate,
    extraArgs: Array.isArray(raw.extraArgs) ? raw.extraArgs.filter((a) => typeof a === 'string' && a) : [],
    promptStyle: raw.promptStyle ?? 'positional',
    promptFlag: raw.promptFlag,
    resumeArgs
  }
}

interface Saved {
  /** built-in fields the user may change */
  overrides: Record<string, { label?: string; command?: string; modelSuggestions?: string[] }>
  custom: CliDefinition[]
}

export class CliRegistry {
  private saved: Saved = { overrides: {}, custom: [] }

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (raw && typeof raw === 'object') {
        this.saved = {
          overrides: raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {},
          custom: Array.isArray(raw.custom) ? raw.custom : []
        }
      }
    } catch {
      /* first run */
    }
  }

  private persist(): void {
    try {
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.saved, null, 2) + '\n', 'utf-8')
      fs.renameSync(tmp, this.file)
    } catch {
      /* settings only — the in-memory registry still works this session */
    }
  }

  list(): CliDefinition[] {
    const builtins = BUILTINS.map((b) => {
      const o = this.saved.overrides[b.id]
      return o
        ? {
            ...b,
            label: o.label || b.label,
            command: o.command || b.command,
            modelSuggestions: o.modelSuggestions ?? b.modelSuggestions
          }
        : b
    })
    const ids = new Set(builtins.map((b) => b.id))
    const custom = this.saved.custom.map((c) => normalize(c, ids))
    return [...builtins, ...custom]
  }

  get(id: string | undefined): CliDefinition | null {
    if (!id) return null
    return this.list().find((c) => c.id === id) ?? null
  }

  /** Upsert. Built-ins accept label/command/model edits only; custom ones are
   *  replaced whole (normalised). Returns what was stored. */
  save(def: Partial<CliDefinition>): CliDefinition {
    const builtin = BUILTINS.find((b) => b.id === def.id)
    if (builtin) {
      const o = { ...(this.saved.overrides[builtin.id] ?? {}) }
      if (typeof def.label === 'string') {
        o.label = def.label.trim() === builtin.label ? undefined : def.label.trim()
      }
      if (typeof def.command === 'string') {
        o.command = def.command.trim() === builtin.command ? undefined : def.command.trim()
      }
      if (Array.isArray(def.modelSuggestions)) o.modelSuggestions = def.modelSuggestions
      this.saved.overrides[builtin.id] = o
      resolveCache.clear()
      this.persist()
      return this.get(builtin.id)!
    }
    const ids = new Set(this.list().map((c) => c.id).filter((id) => id !== def.id))
    const next = normalize(def, ids)
    const at = this.saved.custom.findIndex((c) => c.id === next.id)
    if (at >= 0) this.saved.custom[at] = next
    else this.saved.custom.push(next)
    resolveCache.clear()
    this.persist()
    return next
  }

  /** Custom definitions only — a built-in cannot be removed, just left unused. */
  remove(id: string): boolean {
    const before = this.saved.custom.length
    this.saved.custom = this.saved.custom.filter((c) => c.id !== id)
    if (this.saved.custom.length === before) return false
    this.persist()
    return true
  }

  /** Is it here, where, and which version. `--version` is best-effort: a CLI
   *  that doesn't know the flag is still installed. */
  async status(id: string): Promise<CliStatus> {
    const def = this.get(id)
    if (!def) return { id, installed: false, error: 'unknown cli' }
    const res = resolveCommand(def)
    if (!res) return { id, installed: false, error: `"${def.command}" not found on PATH` }
    let version: string | undefined
    try {
      const env = { ...process.env } as Record<string, string>
      for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k]
      const out = execFileSync(res.file, [...res.prefixArgs, '--version'], {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 8000,
        env,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      version = /\d+\.\d+\.\d+/.exec(out)?.[0]
    } catch {
      /* not every CLI has --version */
    }
    return { id, installed: true, path: res.shown, version }
  }

  async statuses(): Promise<Record<string, CliStatus>> {
    const out: Record<string, CliStatus> = {}
    await Promise.all(
      this.list().map(async (c) => {
        out[c.id] = await this.status(c.id)
      })
    )
    return out
  }
}
