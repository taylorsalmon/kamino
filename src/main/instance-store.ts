/**
 * InstanceStore — merges every signal source into one Instance model per
 * session and broadcasts throttled snapshots.
 *
 * Sources (phase 1):
 *  - session registry files (~/.claude/sessions/<pid>.json)  → liveness + idle/busy
 *  - transcript tail                                          → title, activity, PRs, prompts
 *  - daemon roster                                            → background flag
 * Later phases add: PTY ownership (embedded), hook events (needs-you).
 */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  CLAUDE_DIR,
  SESSIONS_DIR,
  describeAssistant,
  describeCwd,
  derivePendingAsk,
  extractContextTokens,
  extractPickerAnswers,
  extractToolResultIds,
  extractUserPrompt,
  isPidAlive,
  readSessionRegistry,
  readTaskList,
  scanWindowEvidence,
  TASKS_DIR,
  transcriptPath,
  type PendingToolUse,
  type SessionRegistryEntry,
  type TranscriptRecord
} from './claude-data'
import { TranscriptTailer } from './transcript-tailer'
import type { FleetSnapshot, Instance, InstanceState, PendingAskKind } from '../shared/types'

const DEAD_RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * Context-window tiers Claude Code runs with. Nothing under ~/.claude records
 * which one a session got, so assume the small tier and ratchet up when the
 * observed token count proves the window must be bigger (a 200k session
 * auto-compacts before it could ever reach 95% falsely).
 */
const WINDOW_TIERS = [200_000, 1_000_000]

function ratchetWindow(current: number, tokens: number): number {
  let w = current
  for (const tier of WINDOW_TIERS) {
    if (tier > w && tokens > w * 0.95) w = tier
  }
  return w
}

interface Tracked {
  instance: Instance
  tailer: TranscriptTailer | null
  /** true once the initial full-file read has completed */
  caughtUp: boolean
  registry: SessionRegistryEntry | null
  /** Last tool_use the assistant issued with no result yet — what a
   *  permission prompt would be blocked on. Cleared when its result lands. */
  lastToolUse: PendingToolUse | null
  diedAt?: number
}

export class InstanceStore extends EventEmitter {
  private tracked = new Map<string, Tracked>() // key: sessionId
  /** model → biggest window this machine has PROVEN for it (ratchet or
   *  compact preTokens). Persisted so fresh sessions of a known model start
   *  with the right denominator instead of false-alarming at 200k. */
  private modelWindows: Record<string, number> = {}
  private windowSaveTimer: NodeJS.Timeout | null = null

  constructor(private readonly windowCachePath?: string) {
    super()
    if (windowCachePath) {
      try {
        const raw = JSON.parse(fs.readFileSync(windowCachePath, 'utf-8'))
        if (raw && typeof raw === 'object') this.modelWindows = raw
      } catch {
        /* first run */
      }
    }
  }

  private learnWindow(model: string | undefined, window: number): void {
    if (!model || window <= WINDOW_TIERS[0]) return
    if ((this.modelWindows[model] ?? 0) >= window) return
    this.modelWindows[model] = window
    if (!this.windowCachePath || this.windowSaveTimer) return
    this.windowSaveTimer = setTimeout(() => {
      this.windowSaveTimer = null
      try {
        fs.writeFileSync(this.windowCachePath!, JSON.stringify(this.modelWindows))
      } catch {
        /* cache only — losing it just means re-learning */
      }
    }, 1000)
  }

  /**
   * One-shot startup scan: recent transcript tails prove per-model windows
   * (e.g. a 1M-context account), so fresh sessions get the right denominator
   * instead of false-amber rot against the conservative 200k default.
   */
  private async seedWindowsFromHistory(): Promise<void> {
    let evidence: Record<string, number>
    try {
      evidence = await scanWindowEvidence(30 * 24 * 60 * 60 * 1000)
    } catch {
      return
    }
    for (const [model, tokens] of Object.entries(evidence)) {
      this.learnWindow(model, ratchetWindow(WINDOW_TIERS[0], tokens))
    }
    // re-denominator anything already on the board
    let changed = false
    for (const t of this.tracked.values()) {
      const ctx = t.instance.context
      if (!ctx) continue
      const window = this.seedWindow(t.instance)
      if (window !== ctx.window) {
        t.instance.context = { ...ctx, window, pct: ctx.tokens / window }
        changed = true
      }
    }
    if (changed) this.queueBroadcast()
  }

  /** Window to assume for this instance before new evidence arrives. */
  private seedWindow(inst: Instance): number {
    return Math.max(
      inst.context?.window ?? 0,
      this.modelWindows[inst.model ?? ''] ?? 0,
      WINDOW_TIERS[0]
    )
  }
  private watcher: FSWatcher | null = null
  private taskWatcher: FSWatcher | null = null
  private rosterSessionIds = new Set<string>()
  private broadcastTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  /** pids of PTYs we own — instances with these pids are 'embedded' */
  private embeddedPids: () => Set<number> = () => new Set()
  /** pids of arbiters Kamino dispatched — clones it made, not clones you did */
  private arbiterPids: () => Set<number> = () => new Set()

  setEmbeddedPidSource(source: () => Set<number>): void {
    this.embeddedPids = source
  }

  setArbiterPidSource(source: () => Set<number>): void {
    this.arbiterPids = source
  }

  sessionIdForPid(pid: number): string | null {
    for (const t of this.tracked.values()) {
      if (t.instance.pid === pid && t.instance.state !== 'dead') return t.instance.sessionId
    }
    return null
  }

  liveSessionIds(): string[] {
    return [...this.tracked.values()].filter((t) => t.instance.state !== 'dead').map((t) => t.instance.sessionId)
  }

  start(): void {
    void this.seedWindowsFromHistory()
    this.refreshRoster()
    this.refreshRegistry()
    // chokidar catches create/delete quickly; the interval poll re-reads
    // status fields (idle/busy) which change inside existing files.
    this.watcher = chokidar.watch([SESSIONS_DIR, path.join(CLAUDE_DIR, 'daemon', 'roster.json')], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    })
    this.watcher.on('all', (_event, p) => {
      if (p.endsWith('roster.json')) this.refreshRoster()
      this.refreshRegistry()
    })
    this.pollTimer = setInterval(() => this.refreshRegistry(), 2000)
    this.watchTaskLists()
  }

  /**
   * Task lists live one directory per session, created only if a clone makes a
   * list — so watch the parent (depth 2) rather than per-session paths, and map
   * each event back to its sessionId.
   */
  private watchTaskLists(): void {
    try {
      fs.mkdirSync(TASKS_DIR, { recursive: true })
    } catch {
      /* if it can't exist, chokidar just never fires */
    }
    this.taskWatcher = chokidar.watch(TASKS_DIR, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 50 }
    })
    this.taskWatcher.on('all', (_event, p) => {
      const rel = path.relative(TASKS_DIR, p)
      const sessionId = rel.split(path.sep)[0]
      if (sessionId && this.tracked.has(sessionId)) this.refreshTasks(sessionId)
    })
  }

  /** Re-read one session's task list and broadcast if anything moved. */
  private refreshTasks(sessionId: string): void {
    const t = this.tracked.get(sessionId)
    if (!t) return
    const next = readTaskList(sessionId)
    const prev = t.instance.tasks
    const same =
      prev?.total === next?.total &&
      prev?.completed === next?.completed &&
      prev?.inProgress === next?.inProgress &&
      prev?.activeLabel === next?.activeLabel
    t.instance.tasks = next
    if (!same) this.queueBroadcast()
  }

  stop(): void {
    this.watcher?.close()
    this.taskWatcher?.close()
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.windowSaveTimer) clearTimeout(this.windowSaveTimer)
    for (const t of this.tracked.values()) t.tailer?.stop()
    this.tracked.clear()
  }

  snapshot(): FleetSnapshot {
    const instances = [...this.tracked.values()].map((t) => t.instance)
    const rank: Record<InstanceState, number> = { 'needs-you': 0, busy: 1, idle: 2, dead: 3 }
    instances.sort((a, b) => rank[a.state] - rank[b.state] || b.lastActiveAt - a.lastActiveAt)
    return { instances, updatedAt: Date.now() }
  }

  /**
   * Mark a session as waiting on the user (from the Notification hook).
   * Returns the ask kind, or null when it's just the idle nag — callers use
   * that to decide whether a toast is warranted.
   */
  setNeedsYou(sessionId: string, reason: string): PendingAskKind | null {
    const t = this.tracked.get(sessionId)
    if (!t || t.instance.state === 'dead') return null
    // The hook fires instantly but the transcript watch polls at 700ms —
    // catch up first or the ask is derived from the PREVIOUS tool.
    t.tailer?.poke()
    const inst = t.instance
    // The hook message is often just "Claude is waiting for your input" —
    // classify + describe the actual ask (question, command, plan) from the
    // transcript.
    const ask = derivePendingAsk(t.lastToolUse, inst.recent.lastAssistantText, reason)
    if (ask.kind === 'idle') {
      // nothing actually blocks on the user — keep the board calm
      if (inst.state === 'needs-you') inst.state = 'idle'
      this.clearAsk(inst)
      this.queueBroadcast()
      return null
    }
    inst.state = 'needs-you'
    inst.now.pendingAsk = ask.text || undefined
    inst.now.askKind = ask.kind
    inst.now.pendingOptions = ask.options
    inst.now.activity = `Waiting: ${ask.text || reason}`
    this.queueBroadcast()
    return ask.kind
  }

  /** The user responded (prompt submitted) or the turn ended — stop flagging. */
  clearNeedsYou(sessionId: string, nextState: 'busy' | 'idle'): void {
    const t = this.tracked.get(sessionId)
    if (!t || t.instance.state !== 'needs-you') return
    t.instance.state = nextState
    this.clearAsk(t.instance)
    if (nextState === 'busy') t.instance.now.activity = 'Thinking…'
    this.queueBroadcast()
  }

  private clearAsk(inst: Instance): void {
    inst.now.pendingAsk = undefined
    inst.now.askKind = undefined
    inst.now.pendingOptions = undefined
  }

  get(sessionId: string): Instance | null {
    return this.tracked.get(sessionId)?.instance ?? null
  }

  // -------------------------------------------------------------------------

  private refreshRoster(): void {
    this.rosterSessionIds.clear()
    try {
      const roster = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'daemon', 'roster.json'), 'utf-8'))
      for (const w of Object.values<any>(roster?.workers ?? {})) {
        if (w?.sessionId) this.rosterSessionIds.add(w.sessionId)
      }
    } catch {
      /* no daemon running */
    }
  }

  private refreshRegistry(): void {
    const entries = readSessionRegistry()
    const seen = new Set<string>()

    for (const entry of entries) {
      // headless `claude -p` children (e.g. our own recap calls) register too —
      // only interactive and background sessions belong on the board
      if (entry.kind && entry.kind !== 'interactive' && entry.kind !== 'bg') continue
      const alive = isPidAlive(entry.pid)
      if (!alive) continue // stale crash leftover; transcript-only dead handling below
      seen.add(entry.sessionId)
      let t = this.tracked.get(entry.sessionId)
      if (!t) {
        t = this.createTracked(entry)
        this.tracked.set(entry.sessionId, t)
      }
      t.registry = entry
      this.applyRegistry(t, entry)
    }

    // anything we tracked that no longer has a live registry entry → dead
    const now = Date.now()
    for (const [sessionId, t] of this.tracked) {
      if (seen.has(sessionId)) continue
      if (t.instance.state !== 'dead') {
        t.instance.state = 'dead'
        t.instance.kind = 'dead'
        t.instance.now.activity = t.instance.now.title ? `Ended — ${t.instance.now.title}` : 'Session ended'
        t.diedAt = now
        t.tailer?.stop()
        t.tailer = null
        this.emit('died', sessionId)
      } else if (t.diedAt && now - t.diedAt > DEAD_RETENTION_MS) {
        this.tracked.delete(sessionId)
      }
    }
    this.queueBroadcast()
  }

  private createTracked(entry: SessionRegistryEntry): Tracked {
    const { repo, worktree } = describeCwd(entry.cwd)
    const instance: Instance = {
      sessionId: entry.sessionId,
      pid: entry.pid,
      cwd: entry.cwd,
      repo,
      worktree,
      gitBranch: '',
      name: entry.name ?? repo,
      kind: this.rosterSessionIds.has(entry.sessionId) ? 'background' : 'external',
      state: 'idle',
      now: { title: '', activity: 'Starting up…', queued: [] },
      recent: { lastPrompt: '', lastAssistantText: '', prs: [], turns: 0 },
      startedAt: entry.startedAt,
      lastActiveAt: entry.updatedAt ?? entry.startedAt,
      version: entry.version,
      tasks: readTaskList(entry.sessionId)
    }
    const t: Tracked = { instance, tailer: null, caughtUp: false, registry: entry, lastToolUse: null }
    const file = transcriptPath(entry.cwd, entry.sessionId)
    t.tailer = new TranscriptTailer(
      file,
      (rec) => this.applyRecord(t, rec),
      () => {
        t.caughtUp = true
        this.queueBroadcast()
      }
    )
    t.tailer.start()
    return t
  }

  private applyRegistry(t: Tracked, entry: SessionRegistryEntry): void {
    const inst = t.instance
    inst.pid = entry.pid
    inst.name = entry.name ?? inst.name
    inst.lastActiveAt = Math.max(inst.lastActiveAt, entry.updatedAt ?? 0)
    // sticky: once an arbiter, always one. Its pid leaves the set when its
    // terminal closes, and a pane that quietly stopped being an arbiter at that
    // moment would be a pane you might then hand work to.
    if (this.arbiterPids().has(entry.pid)) inst.arbiter = true
    if (this.embeddedPids().has(entry.pid)) inst.kind = 'embedded'
    else if (entry.kind === 'bg' || this.rosterSessionIds.has(inst.sessionId)) inst.kind = 'background'
    else inst.kind = 'external'

    // Registry is authoritative for busy/idle; needs-you (set by hooks/PTY)
    // survives until the state genuinely changes.
    const status = entry.status
    if (status === 'busy' || status === 'shell') {
      if (inst.state !== 'needs-you' || status === 'shell') inst.state = 'busy'
      if (status === 'shell') inst.now.activity = 'Running a shell command (user)'
    } else if (status === 'idle') {
      if (inst.state !== 'needs-you') {
        inst.state = 'idle'
        inst.now.turnStartedAt = undefined
      }
    }
  }

  private applyRecord(t: Tracked, rec: TranscriptRecord): void {
    const inst = t.instance
    if (rec.gitBranch) inst.gitBranch = rec.gitBranch

    switch (rec.type) {
      case 'ai-title':
        if (rec.aiTitle) inst.now.title = rec.aiTitle
        return
      case 'agent-name':
        return
      case 'last-prompt':
        if (rec.lastPrompt) inst.recent.lastPrompt = rec.lastPrompt
        return
      case 'pr-link':
        if (rec.prUrl && typeof rec.prNumber === 'number') {
          if (!inst.recent.prs.some((p) => p.url === rec.prUrl)) {
            inst.recent.prs.push({ number: rec.prNumber, url: rec.prUrl, repository: rec.prRepository })
          }
        }
        return
      case 'queue-operation': {
        const content = typeof rec.content === 'string' ? rec.content : ''
        if (rec.operation === 'enqueue' && content) inst.now.queued.push(content)
        else if (rec.operation === 'dequeue' || rec.operation === 'remove') {
          const i = content ? inst.now.queued.indexOf(content) : 0
          if (i >= 0) inst.now.queued.splice(i, 1)
        }
        return
      }
      case 'permission-mode':
        if (rec.permissionMode) inst.permissionMode = rec.permissionMode
        return
      case 'system':
        if (rec.subtype === 'away_summary' && typeof rec.content === 'string') {
          inst.recent.awaySummary = rec.content
        } else if (rec.subtype === 'compact_boundary') {
          // the rot won: conversation squashed to a summary
          const meta = rec.compactMetadata
          const prev = inst.context
          const pre = typeof meta?.preTokens === 'number' ? meta.preTokens : (prev?.tokens ?? 0)
          const window = ratchetWindow(this.seedWindow(inst), pre)
          this.learnWindow(inst.model, window)
          const tokens = typeof meta?.postTokens === 'number' ? meta.postTokens : 0
          inst.context = {
            tokens,
            window,
            pct: tokens / window,
            compactions: (prev?.compactions ?? 0) + 1,
            lastCompactAt: rec.timestamp ? Date.parse(rec.timestamp) : Date.now()
          }
        } else if (rec.subtype === 'turn_duration') {
          // turn ended
          inst.now.turnStartedAt = undefined
          t.lastToolUse = null
          if ((inst.state === 'busy' || inst.state === 'needs-you') && t.caughtUp) {
            inst.state = 'idle'
            this.clearAsk(inst)
          }
          // no "Done: <title>" rewrite — the title is already on the pane;
          // repeating it in the activity slot just pollutes the strip
          inst.now.activity = ''
        }
        return
      case 'user': {
        if (rec.isSidechain) return
        if (rec.toolUseResult) {
          // Answering a question picker / permission prompt fires NO hook —
          // the tool_result landing is the only "user responded" signal, so
          // without this the pane stays AWAITING ORDERS on a stale ask.
          const ids = extractToolResultIds(rec)
          const blockedResolved = !t.lastToolUse?.id || ids.length === 0 || ids.includes(t.lastToolUse.id)
          if (blockedResolved) {
            t.lastToolUse = null
            if (t.caughtUp && inst.state === 'needs-you') {
              inst.state = 'busy'
              this.clearAsk(inst)
              inst.now.activity = 'Thinking…'
            }
          }
          const answers = extractPickerAnswers(rec)
          if (answers) inst.recent.lastPrompt = answers
        }
        const prompt = extractUserPrompt(rec)
        if (prompt) {
          inst.recent.lastPrompt = prompt
          this.clearAsk(inst)
          inst.recent.turns += 1
          inst.now.queued = inst.now.queued.filter((q) => q !== prompt)
          inst.now.turnStartedAt = rec.timestamp ? Date.parse(rec.timestamp) : Date.now()
          if (t.caughtUp) {
            inst.state = 'busy'
            inst.now.activity = 'Thinking…'
          }
        }
        if (rec.timestamp) inst.lastActiveAt = Math.max(inst.lastActiveAt, Date.parse(rec.timestamp))
        return
      }
      case 'assistant': {
        if (rec.isSidechain) return
        if (rec.message?.model) inst.model = rec.message.model
        const ctxTokens = extractContextTokens(rec)
        if (ctxTokens !== null) {
          const prev = inst.context
          const window = ratchetWindow(this.seedWindow(inst), ctxTokens)
          this.learnWindow(inst.model, window)
          inst.context = {
            tokens: ctxTokens,
            window,
            pct: ctxTokens / window,
            compactions: prev?.compactions ?? 0,
            lastCompactAt: prev?.lastCompactAt
          }
        }
        const content = rec.message?.content
        if (Array.isArray(content)) {
          for (const blk of content) {
            if (blk?.type === 'tool_use' && blk.name) {
              t.lastToolUse = { id: blk.id, name: blk.name, input: blk.input }
              // airspace control watches these to know who is mid-edit where
              this.emit('tool-use', inst, blk.name, blk.input)
            }
          }
        }
        const d = describeAssistant(rec)
        if (d) {
          inst.now.activity = d.activity
          if (d.text) inst.recent.lastAssistantText = d.text
          if (t.caughtUp && inst.state === 'idle') inst.state = 'busy'
        }
        if (rec.timestamp) inst.lastActiveAt = Math.max(inst.lastActiveAt, Date.parse(rec.timestamp))
        return
      }
      default:
        return
    }
  }

  private queueBroadcast(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      this.emit('snapshot', this.snapshot())
    }, 250)
  }
}
