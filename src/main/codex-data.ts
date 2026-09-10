/**
 * codex-data — the ONLY module that knows the shape of Codex's files under
 * ~/.codex (or $CODEX_HOME). Defensive throughout: these are undocumented
 * internals that move between releases, so unknown shapes are ignored, never
 * thrown on.
 *
 * Codex writes one rollout per session:
 *   sessions/YYYY/MM/DD/rollout-<ISO stamp>-<uuid>.jsonl
 * Each line is { timestamp, type, payload }. The types that matter here:
 *   session_meta   who/where: session id, cwd, cli version, originator
 *   event_msg      task_started / task_complete (turn edges), item_completed
 *                  (the user's message), token_count (context occupancy with
 *                  the exact window), agent_message, approval requests
 *   response_item  the model's own items: message, function_call,
 *                  custom_tool_call, their outputs, reasoning
 *   turn_context   approval policy, sandbox, model for the turn
 *
 * Unlike Claude Code there is no per-pid registry, so Kamino can only bind the
 * sessions it spawned itself (see codex-tracker.ts).
 *
 * Verified against codex-cli 0.153.4 (2026-09).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PrLink, RecentSession, TranscriptTailMsg } from '../shared/types'

export const CODEX_DIR = process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex')
export const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions')

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface RolloutRecord {
  timestamp?: string
  type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any
}

export function parseRollout(line: string): RolloutRecord | null {
  if (!line.trim()) return null
  try {
    const d = JSON.parse(line)
    if (d && typeof d.type === 'string') return d as RolloutRecord
  } catch {
    /* torn line */
  }
  return null
}

export interface CodexSessionMeta {
  sessionId: string
  cwd: string
  /** ms epoch */
  startedAt: number
  originator?: string
  cliVersion?: string
  model?: string
  gitBranch?: string
}

export function metaFromRecord(rec: RolloutRecord): CodexSessionMeta | null {
  if (rec.type !== 'session_meta') return null
  const p = rec.payload ?? {}
  const sessionId = typeof p.session_id === 'string' ? p.session_id : typeof p.id === 'string' ? p.id : ''
  if (!sessionId || typeof p.cwd !== 'string') return null
  const stamp = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN
  return {
    sessionId,
    cwd: p.cwd,
    startedAt: Number.isFinite(stamp) ? stamp : rec.timestamp ? Date.parse(rec.timestamp) : Date.now(),
    originator: typeof p.originator === 'string' ? p.originator : undefined,
    cliVersion: typeof p.cli_version === 'string' ? p.cli_version : undefined,
    model: typeof p.model === 'string' ? p.model : undefined,
    gitBranch: typeof p.git?.branch === 'string' ? p.git.branch : undefined
  }
}

/** The uuid at the end of a rollout filename, or null for anything else. */
export function rolloutSessionId(file: string): string | null {
  const m = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    path.basename(file)
  )
  return m ? m[1] : null
}

/** Only the first line — the meta is always the first thing written. */
export function readSessionMeta(file: string): CodexSessionMeta | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(64 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf-8')
    const nl = text.indexOf('\n')
    const first = nl >= 0 ? text.slice(0, nl) : text
    const rec = parseRollout(first)
    return rec ? metaFromRecord(rec) : null
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

export interface RolloutFile {
  file: string
  sessionId: string
  mtimeMs: number
  birthtimeMs: number
}

/**
 * Rollouts written since `sinceMs`, newest first. The directory tree is dated
 * (YYYY/MM/DD), so only days on or after the cutoff are opened.
 */
export function listRollouts(sinceMs: number, limit = 500): RolloutFile[] {
  const out: RolloutFile[] = []
  const cutoffDay = new Date(sinceMs)
  cutoffDay.setHours(0, 0, 0, 0)
  let years: string[]
  try {
    years = fs.readdirSync(CODEX_SESSIONS_DIR)
  } catch {
    return []
  }
  outer: for (const y of years.sort().reverse()) {
    const yDir = path.join(CODEX_SESSIONS_DIR, y)
    let months: string[]
    try {
      months = fs.readdirSync(yDir)
    } catch {
      continue
    }
    for (const m of months.sort().reverse()) {
      const mDir = path.join(yDir, m)
      let days: string[]
      try {
        days = fs.readdirSync(mDir)
      } catch {
        continue
      }
      for (const d of days.sort().reverse()) {
        const dayStamp = Date.parse(`${y}-${m}-${d}T00:00:00`)
        if (Number.isFinite(dayStamp) && dayStamp < cutoffDay.getTime()) continue
        const dDir = path.join(mDir, d)
        let names: string[]
        try {
          names = fs.readdirSync(dDir)
        } catch {
          continue
        }
        for (const name of names) {
          const file = path.join(dDir, name)
          const sessionId = rolloutSessionId(file)
          if (!sessionId) continue
          try {
            const st = fs.statSync(file)
            if (st.mtimeMs < sinceMs) continue
            out.push({ file, sessionId, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs })
          } catch {
            /* vanished */
          }
        }
        if (out.length >= limit) break outer
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, limit)
}

/** The rollout for a session id, searching newest days first. */
export function findRollout(sessionId: string, maxAgeDays = 400): string | null {
  const want = sessionId.toLowerCase()
  for (const r of listRollouts(Date.now() - maxAgeDays * 86_400_000, 5000)) {
    if (r.sessionId.toLowerCase() === want) return r.file
  }
  return null
}

// ---------------------------------------------------------------------------
// Events — the record stream boiled down to what the board needs
// ---------------------------------------------------------------------------

export type CodexEvent =
  | { kind: 'meta'; meta: CodexSessionMeta; at: number }
  | { kind: 'user'; text: string; at: number }
  | { kind: 'reply'; text: string; at: number }
  | { kind: 'tool'; name: string; input: Record<string, unknown>; callId?: string; at: number }
  | { kind: 'tool-result'; callId?: string; text?: string; at: number }
  | { kind: 'turn-start'; window?: number; at: number }
  | { kind: 'turn-end'; lastMessage?: string; at: number }
  | { kind: 'tokens'; tokens: number; window?: number; at: number }
  | { kind: 'compacted'; at: number }
  | { kind: 'settings'; model?: string; approval?: string; sandbox?: string; at: number }
  | { kind: 'approval'; text: string; at: number }

function stamp(rec: RolloutRecord): number {
  const t = rec.timestamp ? Date.parse(rec.timestamp) : NaN
  return Number.isFinite(t) ? t : Date.now()
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      if (!c || typeof c !== 'object') return ''
      const t = (c as { text?: unknown }).text
      return typeof t === 'string' ? t : ''
    })
    .filter(Boolean)
    .join('\n')
}

function policyWord(p: unknown): string | undefined {
  if (typeof p === 'string') return p
  if (p && typeof p === 'object') return 'granular'
  return undefined
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const d = JSON.parse(raw)
    return d && typeof d === 'object' ? d : { raw }
  } catch {
    return { raw }
  }
}

function commandText(cmd: unknown): string {
  if (Array.isArray(cmd)) return cmd.map(String).join(' ')
  return typeof cmd === 'string' ? cmd : ''
}

/** One rollout record → zero or more board events. */
export function toEvents(rec: RolloutRecord): CodexEvent[] {
  const at = stamp(rec)
  const p = rec.payload ?? {}
  switch (rec.type) {
    case 'session_meta': {
      const meta = metaFromRecord(rec)
      return meta ? [{ kind: 'meta', meta, at }] : []
    }
    case 'compacted':
      return [{ kind: 'compacted', at }]
    case 'turn_context':
      return [
        {
          kind: 'settings',
          model: typeof p.model === 'string' ? p.model : undefined,
          approval: policyWord(p.approval_policy),
          sandbox: typeof p.sandbox_policy?.type === 'string' ? p.sandbox_policy.type : undefined,
          at
        }
      ]
    case 'event_msg': {
      switch (p.type) {
        case 'task_started':
          return [
            {
              kind: 'turn-start',
              window: typeof p.model_context_window === 'number' ? p.model_context_window : undefined,
              at
            }
          ]
        case 'task_complete':
          return [
            {
              kind: 'turn-end',
              lastMessage: typeof p.last_agent_message === 'string' ? p.last_agent_message : undefined,
              at
            }
          ]
        case 'turn_aborted':
          return [{ kind: 'turn-end', at }]
        case 'item_completed': {
          const item = p.item ?? {}
          if (item.type === 'UserMessage') {
            const text = textOf(item.content)
            return text ? [{ kind: 'user', text, at }] : []
          }
          if (item.type === 'AgentMessage') {
            const text = textOf(item.content) || (typeof item.text === 'string' ? item.text : '')
            return text ? [{ kind: 'reply', text, at }] : []
          }
          return []
        }
        case 'user_message':
          return typeof p.message === 'string' && p.message ? [{ kind: 'user', text: p.message, at }] : []
        case 'agent_message':
          return typeof p.message === 'string' && p.message ? [{ kind: 'reply', text: p.message, at }] : []
        case 'token_count': {
          const info = p.info ?? {}
          const last = info.last_token_usage ?? info.total_token_usage
          if (!last || typeof last !== 'object') return []
          const total = typeof last.total_tokens === 'number' ? last.total_tokens : undefined
          const input = typeof last.input_tokens === 'number' ? last.input_tokens : 0
          const output = typeof last.output_tokens === 'number' ? last.output_tokens : 0
          const reasoning = typeof last.reasoning_output_tokens === 'number' ? last.reasoning_output_tokens : 0
          // what the model has in front of it: the whole exchange minus the
          // reasoning it does not carry forward (the CLI's own definition)
          const tokens = Math.max(0, (total ?? input + output) - reasoning)
          if (tokens <= 0) return []
          return [
            {
              kind: 'tokens',
              tokens,
              window: typeof info.model_context_window === 'number' ? info.model_context_window : undefined,
              at
            }
          ]
        }
        case 'context_compacted':
        case 'compacted':
          return [{ kind: 'compacted', at }]
        case 'exec_approval_request': {
          const cmd = commandText(p.command)
          return [{ kind: 'approval', text: cmd ? `Approve command: ${shorten(cmd, 240)}` : 'Approve a shell command', at }]
        }
        case 'apply_patch_approval_request': {
          const files = Object.keys(p.changes ?? {})
          return [
            {
              kind: 'approval',
              text: files.length
                ? `Approve edits to ${files.map(lastSegment).join(', ')}`
                : 'Approve proposed code changes',
              at
            }
          ]
        }
        case 'request_permissions':
        case 'elicitation_request':
          return [{ kind: 'approval', text: 'Approve its request — see the terminal', at }]
        case 'request_user_input':
          return [{ kind: 'approval', text: typeof p.question === 'string' ? p.question : 'Answer its question', at }]
        case 'thread_settings_applied': {
          const s = p.thread_settings ?? {}
          return [
            {
              kind: 'settings',
              model: typeof s.model === 'string' ? s.model : undefined,
              approval: policyWord(s.approval_policy),
              at
            }
          ]
        }
        default:
          return []
      }
    }
    case 'response_item': {
      const callId = typeof p.call_id === 'string' ? p.call_id : undefined
      switch (p.type) {
        case 'message': {
          if (p.role !== 'assistant') return []
          const text = textOf(p.content)
          return text ? [{ kind: 'reply', text, at }] : []
        }
        case 'function_call':
          return [{ kind: 'tool', name: String(p.name ?? 'tool'), input: parseArgs(p.arguments), callId, at }]
        case 'custom_tool_call':
          return [
            {
              kind: 'tool',
              name: String(p.name ?? 'tool'),
              input: { input: typeof p.input === 'string' ? p.input : '' },
              callId,
              at
            }
          ]
        case 'local_shell_call':
          return [{ kind: 'tool', name: 'shell', input: { command: p.action?.command }, callId, at }]
        case 'function_call_output':
        case 'custom_tool_call_output':
          return [{ kind: 'tool-result', callId, text: typeof p.output === 'string' ? p.output : undefined, at }]
        default:
          return []
      }
    }
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Describing what it is doing
// ---------------------------------------------------------------------------

function shorten(s: string, max = 80): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

function lastSegment(p: unknown): string {
  if (typeof p !== 'string') return ''
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
}

/** The shell command a tool call runs, if it is that kind of call. */
export function codexCommand(name: string, input: Record<string, unknown>): string | null {
  switch (name) {
    case 'shell':
    case 'shell_command':
    case 'local_shell':
    case 'container.exec': {
      const c = commandText(input.command) || commandText(input.cmd)
      return c || null
    }
    case 'exec_command':
      return commandText(input.cmd) || commandText(input.command) || null
    case 'exec': {
      // a JS cell — surface the exec_command it wraps, if there is one
      const src = typeof input.input === 'string' ? input.input : ''
      const m = /exec_command\(\s*\{\s*cmd\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(src)
      return m ? m[2] : null
    }
    default:
      return null
  }
}

/** Files an apply_patch call touches. */
export function codexPatchFiles(name: string, input: Record<string, unknown>): string[] {
  if (name !== 'apply_patch') return []
  const patch = typeof input.input === 'string' ? input.input : typeof input.patch === 'string' ? input.patch : ''
  const files: string[] = []
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) files.push(m[1].trim())
  return files
}

/** Human line for a tool call — same register as describeToolUse for Claude. */
export function describeCodexTool(name: string, input: Record<string, unknown>): string {
  const cmd = codexCommand(name, input)
  if (cmd) return `Running: ${shorten(cmd, 60)}`
  switch (name) {
    case 'exec':
      return 'Running a script'
    case 'apply_patch': {
      const files = codexPatchFiles(name, input)
      if (!files.length) return 'Editing files'
      const shown = files.slice(0, 2).map(lastSegment).join(', ')
      return `Editing ${shown}${files.length > 2 ? ` +${files.length - 2}` : ''}`
    }
    case 'write_stdin':
      return 'Typing into a running command'
    case 'wait':
      return 'Waiting on a command'
    case 'view_image':
      return 'Viewing an image'
    case 'web_search':
      return `Searching web: ${shorten(String(input.query ?? ''), 45)}`
    case 'update_plan':
      return 'Updating its plan'
    case 'request_user_input':
      return 'Asking you a question'
    default: {
      const tail = name.includes('__') ? (name.split('__').pop() ?? name) : name
      return `Using ${tail.replace(/_/g, ' ')}`
    }
  }
}

const PR_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g

/** PR links mentioned in a piece of text (a reply or a gh output). */
export function prLinksIn(text: string): PrLink[] {
  const out: PrLink[] = []
  for (const m of text.matchAll(PR_RE)) {
    const url = m[0]
    if (!out.some((p) => p.url === url)) out.push({ number: Number(m[2]), url, repository: m[1] })
  }
  return out
}

// ---------------------------------------------------------------------------
// Tail readers — recap / retitle / peek / marker-watch
// ---------------------------------------------------------------------------

function readTailLines(file: string, bytes: number): string[] {
  let chunk: string
  let torn = false
  try {
    const size = fs.statSync(file).size
    const from = Math.max(0, size - bytes)
    torn = from > 0
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - from)
      fs.readSync(fd, buf, 0, buf.length, from)
      chunk = buf.toString('utf-8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
  const lines = chunk.split('\n')
  if (torn) lines.shift()
  return lines
}

/** Events from the tail of a rollout, oldest first. */
export function codexTailEvents(file: string, bytes = 256 * 1024): CodexEvent[] {
  const out: CodexEvent[] = []
  for (const line of readTailLines(file, bytes)) {
    const rec = parseRollout(line)
    if (rec) out.push(...toEvents(rec))
  }
  return out
}

/** The model's own messages in a chunk of rollout, oldest first — for the
 *  marker watch. Only 'reply' events count: a user message quoting the model
 *  is still the user's. */
export function codexAssistantTexts(chunk: string): string[] {
  const out: string[] = []
  for (const line of chunk.split('\n')) {
    const rec = parseRollout(line)
    if (!rec) continue
    for (const ev of toEvents(rec)) if (ev.kind === 'reply' && ev.text) out.push(ev.text)
  }
  return out
}

/** What the retitler feeds the model: recent asks and recent doings. */
export function codexRecentWork(
  file: string,
  maxPrompts = 6,
  maxActions = 8
): { prompts: string[]; actions: string[] } {
  const prompts: string[] = []
  const actions: string[] = []
  for (const ev of codexTailEvents(file)) {
    if (ev.kind === 'user') prompts.push(shorten(ev.text, 300))
    else if (ev.kind === 'reply') {
      const a = shorten(ev.text, 160)
      if (a !== actions[actions.length - 1]) actions.push(a)
    } else if (ev.kind === 'tool') {
      const a = describeCodexTool(ev.name, ev.input)
      if (a !== actions[actions.length - 1]) actions.push(a)
    }
  }
  return { prompts: prompts.slice(-maxPrompts), actions: actions.slice(-maxActions) }
}

/** The recap digest: one line per thing that happened, oldest first. */
export function codexDigestLines(file: string, maxLines = 80): string[] {
  const out: string[] = []
  for (const ev of codexTailEvents(file, 200_000)) {
    const ts = new Date(ev.at).toISOString().slice(11, 16)
    switch (ev.kind) {
      case 'user':
        out.push(`${ts} USER: ${ev.text.slice(0, 300)}`)
        break
      case 'reply':
        out.push(`${ts} CODEX: ${ev.text.slice(0, 300)}`)
        for (const pr of prLinksIn(ev.text)) out.push(`PR: #${pr.number} ${pr.url}`)
        break
      case 'tool':
        out.push(`${ts} ACTION: ${describeCodexTool(ev.name, ev.input)}`)
        break
      case 'compacted':
        out.push(`${ts} COMPACTED`)
        break
      default:
        break
    }
  }
  return out.slice(-maxLines)
}

/** The hover peek: last few exchanges. */
export function codexPeek(file: string, limit = 6): TranscriptTailMsg[] {
  const msgs: TranscriptTailMsg[] = []
  for (const ev of codexTailEvents(file)) {
    if (ev.kind === 'user') msgs.push({ who: 'you', text: ev.text, at: ev.at })
    else if (ev.kind === 'reply') msgs.push({ who: 'clone', text: ev.text, at: ev.at })
  }
  return msgs.slice(-limit)
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/** Folders recent Codex sessions ran in, newest first — merged into the
 *  launch dialog's project list alongside Claude's history. */
export function recentCodexProjects(limit = 12): Array<{ cwd: string; lastUsed: number }> {
  const byPath = new Map<string, number>()
  for (const r of listRollouts(Date.now() - 60 * 86_400_000, 200)) {
    const meta = readSessionMeta(r.file)
    if (!meta?.cwd) continue
    if ((byPath.get(meta.cwd) ?? 0) < r.mtimeMs) byPath.set(meta.cwd, r.mtimeMs)
  }
  return [...byPath.entries()]
    .filter(([p]) => {
      try {
        return fs.statSync(p).isDirectory()
      } catch {
        return false
      }
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cwd, lastUsed]) => ({ cwd, lastUsed }))
}

/** Resumable Codex sessions for the reawaken picker. A session with no user
 *  message yet is an aborted launch, not something to resume into. */
export function recentCodexSessions(opts: { excludeSessionIds: string[]; limit?: number }): RecentSession[] {
  const exclude = new Set(opts.excludeSessionIds)
  const limit = opts.limit ?? 25
  const out: RecentSession[] = []
  for (const r of listRollouts(Date.now() - 90 * 86_400_000, 300)) {
    if (out.length >= limit) break
    if (exclude.has(r.sessionId)) continue
    const meta = readSessionMeta(r.file)
    if (!meta?.cwd) continue
    let title = ''
    let lastPrompt = ''
    const prs: number[] = []
    for (const ev of codexTailEvents(r.file, 96 * 1024)) {
      if (ev.kind === 'user') {
        if (!title) title = shorten(ev.text, 90)
        lastPrompt = shorten(ev.text, 160)
      } else if (ev.kind === 'reply') {
        for (const pr of prLinksIn(ev.text)) if (!prs.includes(pr.number)) prs.push(pr.number)
      }
    }
    if (!lastPrompt) continue
    out.push({
      sessionId: r.sessionId,
      cli: 'codex',
      cwd: meta.cwd,
      gitBranch: meta.gitBranch ?? '',
      title,
      lastPrompt: lastPrompt === title ? '' : lastPrompt,
      prs,
      mtime: r.mtimeMs
    })
  }
  return out
}
