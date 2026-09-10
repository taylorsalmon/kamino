/**
 * Retitler — keeps a pane's task line describing what the clone is doing NOW,
 * not what its opening prompt asked for.
 *
 * Claude Code writes one `ai-title` record, derived from the first message of
 * the session, and then repeats it verbatim for the rest of the transcript. So
 * a pane that opened with "fix the login redirect" still says that three tasks
 * later, when the session has long since moved on — the board reads as stale
 * exactly when it is busiest.
 *
 * This sweeps the live sessions, and when one has taken new user turns since
 * its title was last settled, asks Haiku (via `claude -p`, the same headless
 * route as the recap) for a fresh few-word title. The model is given the recent
 * prompts AND what the session has actually been doing — a prompt like "please
 * fix." carries no subject of its own, and a model handed only that will invent
 * one. It also gets the current title and may answer SAME, which is the common
 * case and costs nothing to apply, so a session grinding on one long task keeps
 * a steady title instead of flickering between paraphrases.
 *
 * Everything here is best-effort: a failed or unparseable call leaves the
 * existing title alone, and repeated failures (no CLI on PATH, no auth) shut
 * the sweep down rather than spawning a process every 20 seconds forever.
 */
import * as fs from 'node:fs'
import { runClaude } from './claude-cli'
import { describeAssistant, extractUserPrompt, parseRecord, transcriptPath } from './claude-data'
import { codexRecentWork } from './codex-data'
import type { InstanceStore } from './instance-store'
import type { Instance } from '../shared/types'

/** how often the fleet is checked for stale titles */
const SWEEP_MS = 20_000
/** user turns a session must take past its last title before we re-ask */
const TURNS_PER_RETITLE = 2
/** floor on how often any one session is re-titled */
const MIN_INTERVAL_MS = 90_000
/** tail of the transcript searched for recent work */
const TAIL_BYTES = 256 * 1024
/** most recent user prompts handed to the model */
const MAX_PROMPTS = 6
/** most recent things the clone did — grounding for a prompt that names nothing */
const MAX_ACTIONS = 8
const PROMPT_CHARS = 300
const ACTION_CHARS = 160
const MAX_TITLE_CHARS = 60
const CALL_TIMEOUT_MS = 45_000
/** consecutive failures before the sweep gives up for this run */
const FAILURE_LIMIT = 3
/**
 * Stands in for Claude Code's own system prompt, which would otherwise hand
 * the child the folder Kamino was launched from and the branch checked out in
 * it. Asked to name a session on that footing, it answers with Kamino's
 * current branch — the one subject in the room that has nothing to do with the
 * session being named.
 */
const TITLER_ROLE =
  'You name coding-agent sessions for a dashboard. The user message carries the rules and the evidence. Follow the rules exactly and reply with the title alone.'

/** where a session's conversation stood when its title was last settled */
interface Titled {
  atTurns: number
  at: number
}

/** the recent slice of a session, in the two forms a title is built from */
export interface WorkDigest {
  /** what the user asked for, oldest first */
  prompts: string[]
  /** what the clone did about it, oldest first */
  actions: string[]
}

/**
 * Seams for the test, which has to prove the cadence — the thing that decides
 * how many CLI calls this costs — without spawning anything or waiting out the
 * real intervals.
 */
export interface RetitleDeps {
  /** ask the model; the transcript digest is already built by then */
  ask?: (input: string) => Promise<string>
  /** read the session's recent work off disk */
  read?: (inst: Instance) => WorkDigest
  now?: () => number
}

export class Retitler {
  private state = new Map<string, Titled>()
  private timer: NodeJS.Timeout | null = null
  private sweeping = false
  private failures = 0
  private readonly ask: (input: string) => Promise<string>
  private readonly read: (inst: Instance) => WorkDigest
  private readonly now: () => number

  constructor(
    private readonly store: InstanceStore,
    deps: RetitleDeps = {}
  ) {
    this.ask =
      deps.ask ??
      ((input) => runClaude(input, { model: 'haiku', timeoutMs: CALL_TIMEOUT_MS, systemPrompt: TITLER_ROLE }))
    // each CLI writes its own transcript dialect; the question asked is the same
    this.read =
      deps.read ??
      ((inst) => {
        if (inst.cliKind === 'codex') {
          const file = this.store.transcriptFile(inst.sessionId)
          return file ? codexRecentWork(file, MAX_PROMPTS, MAX_ACTIONS) : { prompts: [], actions: [] }
        }
        return recentWork(inst.cwd, inst.sessionId)
      })
    this.now = deps.now ?? Date.now
  }

  /** Sweep once, now — the test's way in, and what start() puts on a timer. */
  async tick(): Promise<void> {
    await this.sweep()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Sessions whose title has fallen behind their conversation. A session seen
   * for the first time counts as titled at turn zero, so a board that was
   * already stale when Kamino started is corrected on the first sweep instead
   * of waiting for the user to type twice more.
   */
  private due(): Instance[] {
    const now = this.now()
    const live = new Set<string>()
    const out: Instance[] = []
    for (const inst of this.store.snapshot().instances) {
      if (inst.state === 'dead') continue
      live.add(inst.sessionId)
      const seen = this.state.get(inst.sessionId) ?? { atTurns: 0, at: 0 }
      this.state.set(inst.sessionId, seen)
      if (inst.recent.turns - seen.atTurns < TURNS_PER_RETITLE) continue
      if (now - seen.at < MIN_INTERVAL_MS) continue
      out.push(inst)
    }
    for (const id of [...this.state.keys()]) {
      if (!live.has(id)) this.state.delete(id)
    }
    return out
  }

  /** One call at a time — eight panes must not mean eight CLI processes. */
  private async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      for (const inst of this.due()) {
        if (this.failures >= FAILURE_LIMIT) {
          console.warn('[retitle] repeated failures — leaving titles as the sessions set them')
          this.stop()
          return
        }
        await this.retitle(inst)
      }
    } finally {
      this.sweeping = false
    }
  }

  private async retitle(inst: Instance): Promise<void> {
    // read the turn count BEFORE the call: anything typed while the model is
    // thinking belongs to the next title, not to this one
    const turns = inst.recent.turns
    const settled = (): void => {
      this.state.set(inst.sessionId, { atTurns: turns, at: this.now() })
    }

    // a custom CLI has no transcript Kamino can read — its title is its folder
    if (inst.cliKind === 'custom') {
      settled()
      return
    }
    const work = this.read(inst)
    if (!work.prompts.length) {
      settled()
      return
    }

    let reply: string
    try {
      reply = await this.ask(buildPrompt(inst.now.title, work, inst.now.activity))
      this.failures = 0
    } catch {
      this.failures++
      settled() // back off the turn counter too — a broken CLI must not be retried every sweep
      return
    }
    settled()
    const title = cleanTitle(reply)
    if (title) this.store.setLiveTitle(inst.sessionId, title)
  }
}

/** The recent prompts and actions from a session's transcript tail. */
export function recentWork(cwd: string, sessionId: string): WorkDigest {
  const file = transcriptPath(cwd, sessionId)
  let chunk: string
  let torn: boolean
  try {
    const size = fs.statSync(file).size
    const from = Math.max(0, size - TAIL_BYTES)
    torn = from > 0 // a read that starts mid-file opens on half a record
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - from)
      fs.readSync(fd, buf, 0, buf.length, from)
      chunk = buf.toString('utf-8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { prompts: [], actions: [] } // session moved or cleaned up mid-sweep
  }

  const lines = chunk.split('\n')
  if (torn) lines.shift()

  const prompts: string[] = []
  const actions: string[] = []
  for (const line of lines) {
    const rec = parseRecord(line)
    if (!rec || rec.isSidechain) continue
    if (rec.type === 'user') {
      const p = extractUserPrompt(rec)
      if (p) prompts.push(oneLine(p, PROMPT_CHARS))
    } else if (rec.type === 'assistant') {
      const d = describeAssistant(rec)
      const a = d?.text ? oneLine(d.text, ACTION_CHARS) : d?.activity
      // a streamed reply lands as several growing records, and a long edit run
      // repeats one activity — neither earns a second line
      if (a && a !== actions[actions.length - 1]) actions.push(a)
    }
  }
  return { prompts: prompts.slice(-MAX_PROMPTS), actions: actions.slice(-MAX_ACTIONS) }
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

export function buildPrompt(current: string, work: WorkDigest, activity: string): string {
  const lines = [
    'You are naming one coding-agent session for a dashboard where several sessions sit side by side.',
    '',
    'Rules:',
    '- Name what the session is working on NOW. The most recent request outranks the earlier ones.',
    '- Take the subject from the evidence below, never from guesswork. A request like "please fix"',
    '  or "keep going" names no subject of its own — read what the session has been doing instead.',
    '- 3 to 6 words, sentence case, no quotes, no full stop at the end.',
    '- Reply with the title and nothing else: no preamble, no explanation.',
    '- If the current title still describes the work, reply with exactly: SAME',
    '',
    `CURRENT TITLE: ${current || '(none yet)'}`
  ]
  if (activity) lines.push(`DOING RIGHT NOW: ${activity}`)
  lines.push('', 'RECENT REQUESTS FROM THE USER (oldest first):')
  lines.push(...work.prompts.map((p, i) => `${i + 1}. ${p}`))
  if (work.actions.length) {
    lines.push('', 'WHAT THE SESSION HAS BEEN DOING (oldest first):')
    lines.push(...work.actions.map((a) => `- ${a}`))
  }
  return lines.join('\n')
}

/**
 * Pull a usable title out of the reply, or null to keep the one we have —
 * which covers SAME, an empty answer, and a model that decided to explain
 * itself in a paragraph instead.
 */
export function cleanTitle(raw: string): string | null {
  const first = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!first) return null
  let s = first
    .replace(/^title:\s*/i, '')
    .replace(/^[\s"'`*]+/, '')
    .replace(/[\s"'`*]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
  if (!s || /^same$/i.test(s)) return null
  if (s.length > MAX_TITLE_CHARS * 2) return null // prose, not a title
  if (s.length > MAX_TITLE_CHARS) s = s.slice(0, MAX_TITLE_CHARS - 1) + '…'
  return s
}
