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
  extractUserPrompt,
  isPidAlive,
  readSessionRegistry,
  transcriptPath,
  type SessionRegistryEntry,
  type TranscriptRecord
} from './claude-data'
import { TranscriptTailer } from './transcript-tailer'
import type { FleetSnapshot, Instance, InstanceState } from '../shared/types'

const DEAD_RETENTION_MS = 24 * 60 * 60 * 1000

interface Tracked {
  instance: Instance
  tailer: TranscriptTailer | null
  /** true once the initial full-file read has completed */
  caughtUp: boolean
  registry: SessionRegistryEntry | null
  diedAt?: number
}

export class InstanceStore extends EventEmitter {
  private tracked = new Map<string, Tracked>() // key: sessionId
  private watcher: FSWatcher | null = null
  private rosterSessionIds = new Set<string>()
  private broadcastTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null

  start(): void {
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
  }

  stop(): void {
    this.watcher?.close()
    if (this.pollTimer) clearInterval(this.pollTimer)
    for (const t of this.tracked.values()) t.tailer?.stop()
    this.tracked.clear()
  }

  snapshot(): FleetSnapshot {
    const instances = [...this.tracked.values()].map((t) => t.instance)
    const rank: Record<InstanceState, number> = { 'needs-you': 0, busy: 1, idle: 2, dead: 3 }
    instances.sort((a, b) => rank[a.state] - rank[b.state] || b.lastActiveAt - a.lastActiveAt)
    return { instances, updatedAt: Date.now() }
  }

  /** Mark a session as waiting on the user (hook / PTY detection — later phases). */
  setNeedsYou(sessionId: string, reason: string): void {
    const t = this.tracked.get(sessionId)
    if (!t || t.instance.state === 'dead') return
    t.instance.state = 'needs-you'
    t.instance.now.activity = `Waiting: ${reason}`
    this.queueBroadcast()
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
      } else if (t.diedAt && now - t.diedAt > DEAD_RETENTION_MS) {
        this.tracked.delete(sessionId)
      }
    }
    this.queueBroadcast()
  }

  private createTracked(entry: SessionRegistryEntry): Tracked {
    const repo = entry.cwd.split(/[\\/]/).filter(Boolean).pop() ?? entry.cwd
    const instance: Instance = {
      sessionId: entry.sessionId,
      pid: entry.pid,
      cwd: entry.cwd,
      repo,
      gitBranch: '',
      name: entry.name ?? repo,
      kind: this.rosterSessionIds.has(entry.sessionId) ? 'background' : 'external',
      state: 'idle',
      now: { title: '', activity: 'Starting up…', queued: [] },
      recent: { lastPrompt: '', lastAssistantText: '', prs: [], turns: 0 },
      startedAt: entry.startedAt,
      lastActiveAt: entry.updatedAt ?? entry.startedAt,
      version: entry.version
    }
    const t: Tracked = { instance, tailer: null, caughtUp: false, registry: entry }
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
    if (!this.rosterSessionIds.has(inst.sessionId) && inst.kind === 'background') inst.kind = 'external'
    if (this.rosterSessionIds.has(inst.sessionId)) inst.kind = 'background'

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
        } else if (rec.subtype === 'turn_duration') {
          // turn ended
          inst.now.turnStartedAt = undefined
          if (inst.state === 'busy' && t.caughtUp) inst.state = 'idle'
          if (inst.now.title) inst.now.activity = `Done: ${inst.now.title}`
        }
        return
      case 'user': {
        if (rec.isSidechain) return
        const prompt = extractUserPrompt(rec)
        if (prompt) {
          inst.recent.lastPrompt = prompt
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
