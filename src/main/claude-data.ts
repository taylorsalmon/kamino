/**
 * claude-data — the ONLY module that knows the shape of Claude Code's
 * internal files under ~/.claude. Everything here is defensive: these are
 * undocumented internals that may shift between CLI versions, so unknown
 * shapes are ignored rather than thrown on.
 *
 * Verified against CLI 2.1.220 (2026-08).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PendingAskKind } from '../shared/types'

export const CLAUDE_DIR = path.join(os.homedir(), '.claude')
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions')
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects')

// ---------------------------------------------------------------------------
// Session registry: ~/.claude/sessions/<pid>.json
// ---------------------------------------------------------------------------

export interface SessionRegistryEntry {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  version?: string
  kind?: string // 'interactive' | ...
  entrypoint?: string
  name?: string
  /** 'idle' | 'busy' | 'shell' | ... */
  status?: string
  updatedAt?: number
  statusUpdatedAt?: number
}

export function readSessionRegistry(): SessionRegistryEntry[] {
  let files: string[]
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const entries: SessionRegistryEntry[] = []
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'))
      if (raw && typeof raw.pid === 'number' && typeof raw.sessionId === 'string' && typeof raw.cwd === 'string') {
        entries.push(raw as SessionRegistryEntry)
      }
    } catch {
      /* partially-written or stale file — skip */
    }
  }
  return entries
}

/** Registry files can outlive a crashed process — always cross-check. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Project dir slug: cwd -> ~/.claude/projects/<slug>
// ---------------------------------------------------------------------------

/** e.g. C:\Users\t.s\ClaudeRestricted\LKG- -> C--Users-t-s-ClaudeRestricted-LKG- */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[\\/:.]/g, '-')
}

export function transcriptPath(cwd: string, sessionId: string): string {
  return path.join(PROJECTS_DIR, projectSlug(cwd), `${sessionId}.jsonl`)
}

// ---------------------------------------------------------------------------
// Transcript records (.jsonl lines)
// ---------------------------------------------------------------------------

export interface TranscriptRecord {
  type: string
  subtype?: string
  timestamp?: string
  uuid?: string
  sessionId?: string
  gitBranch?: string
  cwd?: string
  isSidechain?: boolean
  isMeta?: boolean
  // type-specific fields, accessed defensively:
  aiTitle?: string
  agentName?: string
  lastPrompt?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
  content?: unknown
  operation?: string
  permissionMode?: string
  durationMs?: number
  compactMetadata?: {
    trigger?: string
    preTokens?: number
    postTokens?: number
  }
  message?: {
    role?: string
    model?: string
    stop_reason?: string | null
    usage?: {
      input_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      output_tokens?: number
    }
    content?:
      | Array<{
          type?: string
          text?: string
          name?: string
          id?: string
          input?: Record<string, unknown>
          tool_use_id?: string
          content?: unknown
        }>
      | string
  }
  toolUseResult?: unknown
}

export function parseRecord(line: string): TranscriptRecord | null {
  if (!line.trim()) return null
  try {
    const d = JSON.parse(line)
    if (d && typeof d.type === 'string') return d as TranscriptRecord
  } catch {
    /* torn line */
  }
  return null
}

// ---------------------------------------------------------------------------
// Activity derivation — "what is it literally doing right now"
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

/** Human line for a tool_use block. */
export function describeToolUse(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {}
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `Editing ${lastSegment(i.file_path) || 'file'}`
    case 'Read':
      return `Reading ${lastSegment(i.file_path) || 'file'}`
    case 'Bash':
    case 'PowerShell':
      return `Running: ${shorten(String(i.description || i.command || 'command'), 60)}`
    case 'Grep':
      return `Searching for "${shorten(String(i.pattern ?? ''), 40)}"`
    case 'Glob':
      return `Finding files: ${shorten(String(i.pattern ?? ''), 40)}`
    case 'Agent':
      return `Delegating: ${shorten(String(i.description ?? 'subagent'), 50)}`
    case 'Workflow':
      return 'Orchestrating a workflow'
    case 'WebFetch':
      return `Fetching ${shorten(String(i.url ?? 'page'), 50)}`
    case 'WebSearch':
      return `Searching web: ${shorten(String(i.query ?? ''), 45)}`
    case 'AskUserQuestion':
      return 'Asking you a question'
    case 'ExitPlanMode':
      return 'Presenting a plan for approval'
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return 'Updating its task list'
    default:
      if (name.startsWith('mcp__')) {
        const tail = name.split('__').pop() ?? name
        return `Using ${tail.replace(/_/g, ' ')}`
      }
      return `Using ${name}`
  }
}

/** The last tool_use an assistant record issued — kept around so that when a
 *  Notification hook fires with a generic "waiting for your input", we can say
 *  what it is actually blocked on. */
export interface PendingToolUse {
  /** tool_use block id — matched against tool_result ids to know when the
   *  blocking tool actually resolved */
  id?: string
  name: string
  input?: Record<string, unknown>
}

export interface PendingAsk {
  kind: PendingAskKind
  text: string
  /** option labels for one-click answering — only when there is exactly one
   *  single-select question, so digit keys map 1:1 onto the picker */
  options?: string[]
}

/**
 * Classify + describe what a waiting clone is blocked on. Unlike
 * describeToolUse (a status verb), this is the content of the ask itself:
 * question + options, the exact command, the plan headline. With no blocked
 * tool it falls back to the tail of the last reply — 'reply' if that ends in
 * a question, else 'idle' (the CLI's nag; nothing actually needs the user).
 */
export function derivePendingAsk(
  tool: PendingToolUse | null,
  lastAssistantText: string,
  reason: string
): PendingAsk {
  if (tool) {
    const i = tool.input ?? {}
    switch (tool.name) {
      case 'AskUserQuestion': {
        const qs = Array.isArray(i.questions) ? (i.questions as Array<Record<string, unknown>>) : []
        const parts = qs
          .map((q) => {
            const question = typeof q?.question === 'string' ? q.question : ''
            const opts = Array.isArray(q?.options)
              ? (q.options as Array<Record<string, unknown>>)
                  .map((o) => (typeof o?.label === 'string' ? o.label : ''))
                  .filter(Boolean)
                  .join(' / ')
              : ''
            return question ? (opts ? `${question} [${opts}]` : question) : ''
          })
          .filter(Boolean)
        const first = qs[0]
        const labels =
          qs.length === 1 && first && first.multiSelect !== true && Array.isArray(first.options)
            ? (first.options as Array<Record<string, unknown>>)
                .map((o) => (typeof o?.label === 'string' ? o.label : ''))
                .filter(Boolean)
            : []
        return {
          kind: 'question',
          text: parts.length ? parts.join('  ·  ') : 'Answer its question',
          options: labels.length ? labels : undefined
        }
      }
      case 'ExitPlanMode': {
        const plan = typeof i.plan === 'string' ? i.plan : ''
        return { kind: 'plan', text: plan ? `Approve plan: ${shorten(plan, 240)}` : 'Approve its plan' }
      }
      case 'Bash':
      case 'PowerShell': {
        const cmd = String(i.command ?? i.description ?? '')
        return { kind: 'permission', text: cmd ? `Approve command: ${shorten(cmd, 240)}` : 'Approve a shell command' }
      }
      case 'Edit':
      case 'Write':
      case 'NotebookEdit':
        return { kind: 'permission', text: `Approve edit to ${lastSegment(i.file_path) || 'a file'}` }
      default:
        return { kind: 'permission', text: `Approve ${tool.name}` }
    }
  }
  // Permission notification but the tool_use hasn't hit the transcript yet —
  // trust the hook message over the text fallback.
  if (/permission/i.test(reason)) return { kind: 'permission', text: reason }
  // No blocked tool — it ended its turn talking to you. The ask is in the
  // text, and almost always at the END of the reply, so keep the tail.
  const t = lastAssistantText.replace(/\s+/g, ' ').trim()
  const text = t.length > 280 ? '…' + t.slice(-279) : t
  if (/\?[\s"'’”)\]]*$/.test(t)) return { kind: 'reply', text }
  return { kind: 'idle', text }
}

/**
 * Context-window occupancy of an assistant record: everything the model had
 * in front of it for that reply. Zero/absent usage (synthetic records) → null.
 */
export function extractContextTokens(rec: TranscriptRecord): number | null {
  const u = rec.message?.usage
  if (!u) return null
  const tokens =
    (typeof u.input_tokens === 'number' ? u.input_tokens : 0) +
    (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0) +
    (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0)
  return tokens > 0 ? tokens : null
}

/**
 * Mine recent transcript tails for context-window evidence: the biggest
 * context each model has been seen holding (usage lines + compact-boundary
 * preTokens). Context grows monotonically within a session, so a file's tail
 * carries its high-water mark. Bounded: newest `maxFiles` transcripts within
 * `maxAgeMs`, last 128 KiB of each.
 */
export async function scanWindowEvidence(
  maxAgeMs: number,
  maxFiles = 300
): Promise<Record<string, number>> {
  const cutoff = Date.now() - maxAgeMs
  const candidates: Array<{ path: string; mtimeMs: number; size: number }> = []
  let dirs: string[]
  try {
    dirs = await fs.promises.readdir(PROJECTS_DIR)
  } catch {
    return {}
  }
  for (const dir of dirs) {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(path.join(PROJECTS_DIR, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      const p = path.join(PROJECTS_DIR, dir, e.name)
      try {
        const st = await fs.promises.stat(p)
        if (st.mtimeMs >= cutoff && st.size > 0) {
          candidates.push({ path: p, mtimeMs: st.mtimeMs, size: st.size })
        }
      } catch {
        /* vanished mid-scan */
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const best: Record<string, number> = {}
  for (const c of candidates.slice(0, maxFiles)) {
    let text: string
    const len = Math.min(131_072, c.size)
    try {
      const fh = await fs.promises.open(c.path, 'r')
      try {
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, c.size - len)
        text = buf.toString('utf-8')
      } finally {
        await fh.close()
      }
    } catch {
      continue
    }
    const lines = text.split('\n')
    if (len < c.size) lines.shift() // torn first line
    let model = ''
    for (const line of lines) {
      const rec = parseRecord(line)
      if (!rec) continue
      const m = rec.message?.model
      if (m && m.startsWith('claude')) model = m // filters '<synthetic>'
      let tokens = extractContextTokens(rec) ?? 0
      const pre = rec.compactMetadata?.preTokens
      if (rec.subtype === 'compact_boundary' && typeof pre === 'number') {
        tokens = Math.max(tokens, pre)
      }
      if (tokens > 0 && model) best[model] = Math.max(best[model] ?? 0, tokens)
    }
  }
  return best
}

/** Extract text/tool info from an assistant record. */
export function describeAssistant(rec: TranscriptRecord): { activity: string; text?: string } | null {
  const content = rec.message?.content
  if (!Array.isArray(content)) return null
  let text: string | undefined
  let tool: string | undefined
  for (const blk of content) {
    if (!blk || typeof blk !== 'object') continue
    if (blk.type === 'tool_use' && blk.name) tool = describeToolUse(blk.name, blk.input)
    if (blk.type === 'text' && blk.text) text = blk.text
  }
  if (tool) return { activity: tool, text }
  if (text) return { activity: `Replying: ${shorten(text, 60)}`, text }
  return null
}

/**
 * Answering an AskUserQuestion picker doesn't write a prompt record — the
 * choice comes back as a tool_result reading
 *   Your questions have been answered: "Q"="A" ...
 * Pull out the answers so the "you" quote line tracks what was last sent.
 */
export function extractPickerAnswers(rec: TranscriptRecord): string | null {
  const content = rec.message?.content
  if (!Array.isArray(content)) return null
  for (const blk of content) {
    if (blk?.type !== 'tool_result') continue
    const c = blk.content
    const s =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text?: unknown }).text ?? '') : '')).join(' ')
          : ''
    if (!s.startsWith('Your questions have been answered:')) continue
    const answers = [...s.matchAll(/"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[2])
    if (answers.length) return answers.join(' · ')
  }
  return null
}

/** tool_result ids in a user record — which tool_use calls just resolved. */
export function extractToolResultIds(rec: TranscriptRecord): string[] {
  const content = rec.message?.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const blk of content) {
    if (blk?.type === 'tool_result' && typeof blk.tool_use_id === 'string') ids.push(blk.tool_use_id)
  }
  return ids
}

/** Extract the human prompt from a user record (ignore tool results / meta). */
export function extractUserPrompt(rec: TranscriptRecord): string | null {
  if (rec.isMeta || rec.toolUseResult) return null
  const content = rec.message?.content
  if (typeof content === 'string') {
    if (content.startsWith('<') || !content.trim()) return null // command wrappers / reminders
    return content
  }
  if (Array.isArray(content)) {
    for (const blk of content) {
      if (blk?.type === 'text' && blk.text && !blk.text.startsWith('<')) return blk.text
    }
  }
  return null
}
