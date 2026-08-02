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
  message?: {
    role?: string
    model?: string
    stop_reason?: string | null
    content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> | string
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
