/**
 * CodexTracker — puts Kamino's own Codex clones on the board.
 *
 * Claude Code registers every process under ~/.claude/sessions/<pid>.json, so a
 * terminal binds to its card by pid. Codex records nothing per process: a
 * session is just a rollout file that appears under ~/.codex/sessions when the
 * TUI starts. So binding works the other way round — when Kamino spawns a
 * Codex PTY it EXPECTS a rollout: the first new file whose session_meta names
 * the same working folder, written after the spawn, is that clone. A resumed
 * session is simpler still: its rollout already exists and carries the id.
 *
 * Once bound, the rollout is tailed like a Claude transcript and its records
 * are folded into the same Instance model the rest of Kamino reads (activity,
 * title, turns, PRs, context rot — Codex reports the exact window size, so rot
 * here is measured rather than proven). Liveness is the PTY: when the process
 * exits, the clone is dead.
 *
 * Approval prompts are the one thing the rollout does not reliably carry, so a
 * second signal reads the terminal output for Codex's own approval wording.
 * That is a heuristic, kept in one place (APPROVAL_RE) so a wording change in
 * the TUI is a one-line fix.
 */
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  CODEX_SESSIONS_DIR,
  codexPatchFiles,
  codexCommand,
  describeCodexTool,
  findRollout,
  listRollouts,
  parseRollout,
  prLinksIn,
  readSessionMeta,
  toEvents,
  type CodexEvent,
  type RolloutRecord
} from './codex-data'
import { describeCwd } from './claude-data'
import { TranscriptTailer } from './transcript-tailer'
import type { InstanceStore } from './instance-store'
import type { PtyManager } from './pty-manager'
import type { Instance } from '../shared/types'

/** how long a spawn waits for its rollout before giving up (the pane keeps
 *  working as a plain terminal either way) */
const EXPECT_TIMEOUT_MS = 120_000
/** a rollout this much older than the spawn cannot be its session */
const EARLY_SLACK_MS = 15_000
const POLL_MS = 1500
/** the window Codex reports when it reports none (never seen; a safe floor) */
const FALLBACK_WINDOW = 200_000

/**
 * Codex's approval modal, as it reads in the terminal. Matched against
 * de-ANSI'd output. Deliberately narrow: a clone quoting these words in prose
 * would false-alarm, but the cost of a missed approval (a clone sitting blocked
 * for an hour) is far higher than a banner that dismisses on the next event.
 */
export const APPROVAL_RE =
  /Allow Codex to (?:run|apply)|Allow this request|Allow for this session|Allow and don't ask|Approve this (?:command|request)/i

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)/g

export interface CodexExpectation {
  ptyId: string
  pid: number
  cwd: string
  startedAt: number
  resumeSessionId?: string
  /** the launch dialog's choice, shown until the rollout says otherwise */
  permissionMode?: string
  model?: string
}

interface Bound {
  ptyId: string
  sessionId: string
  file: string
  tailer: TranscriptTailer<RolloutRecord>
  /** history replayed — state changes only count after this */
  caughtUp: boolean
  /** a resumed session replays its whole past; a fresh one is live from line 1 */
  resumed: boolean
  /** last tool call with no output yet — what an approval would be about */
  pending: { name: string; input: Record<string, unknown>; callId?: string } | null
  /** de-ANSI'd terminal tail for the approval heuristic */
  screen: string
}

/** Windows paths compare case-insensitively and either slash will do. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export class CodexTracker extends EventEmitter {
  private expecting: CodexExpectation[] = []
  private bound = new Map<string, Bound>() // key: ptyId
  private bySession = new Map<string, Bound>()
  private watcher: FSWatcher | null = null
  private poll: NodeJS.Timeout | null = null
  private started = false

  constructor(
    private readonly store: InstanceStore,
    private readonly ptys: PtyManager
  ) {
    super()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.ptys.on('exit', (ptyId: string) => this.onExit(ptyId))
    this.ptys.on('data', (ptyId: string, data: string) => this.onData(ptyId, data))
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    for (const b of this.bound.values()) b.tailer.stop()
    this.bound.clear()
    this.bySession.clear()
    this.expecting = []
  }

  /** The rollout file behind a bound session, for recap/peek/handoff. */
  transcriptFile(sessionId: string): string | null {
    return this.bySession.get(sessionId)?.file ?? null
  }

  /** Called right after a Codex PTY is spawned. */
  expect(exp: CodexExpectation): void {
    if (exp.resumeSessionId) {
      const file = findRollout(exp.resumeSessionId)
      if (file) {
        this.bind(exp, file, exp.resumeSessionId, true)
        return
      }
      // no rollout on disk — the CLI will error in its own terminal; fall
      // through and see whether it starts a fresh one instead
    }
    this.expecting.push(exp)
    this.ensureWatching()
    this.scan()
  }

  private ensureWatching(): void {
    if (!this.watcher) {
      let dir = CODEX_SESSIONS_DIR
      try {
        fs.mkdirSync(dir, { recursive: true })
        // the long-form path: libuv's directory watcher aborts the whole
        // process on a Windows 8.3 short name (USER~1), and a CODEX_HOME set
        // from an old-style %TEMP% is exactly that
        dir = fs.realpathSync.native(dir)
      } catch {
        /* if it can't exist, the poll below still finds nothing, harmlessly */
      }
      this.watcher = chokidar.watch(dir, {
        ignoreInitial: true,
        depth: 4,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 60 }
      })
      this.watcher.on('add', (p) => this.consider(p))
      this.watcher.on('error', () => {
        /* a watcher error is not a reason to lose a clone — the poll covers it */
      })
    }
    // chokidar on Windows sometimes misses a create in a directory that did not
    // exist at watch time (a new day's folder) — a cheap poll backs it up
    if (!this.poll) this.poll = setInterval(() => this.scan(), POLL_MS)
  }

  private stopWatchingIfIdle(): void {
    if (this.expecting.length > 0) return
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    // the watcher stays: a tracked clone's directory may grow a new day folder
  }

  private scan(): void {
    const now = Date.now()
    this.expecting = this.expecting.filter((e) => now - e.startedAt < EXPECT_TIMEOUT_MS)
    if (this.expecting.length === 0) {
      this.stopWatchingIfIdle()
      return
    }
    const oldest = Math.min(...this.expecting.map((e) => e.startedAt))
    for (const r of listRollouts(oldest - EARLY_SLACK_MS, 50)) this.consider(r.file)
  }

  /** A rollout appeared (or was rescanned): is it one we are waiting for? */
  private consider(file: string): void {
    if (!file.endsWith('.jsonl') || this.expecting.length === 0) return
    for (const b of this.bound.values()) if (b.file === file) return
    const meta = readSessionMeta(file)
    if (!meta) return
    if (this.bySession.has(meta.sessionId) || this.store.get(meta.sessionId)) return
    let birth = meta.startedAt
    try {
      const st = fs.statSync(file)
      birth = Math.min(birth, st.birthtimeMs || birth)
    } catch {
      return
    }
    // oldest expectation first: two clones commissioned into one folder bind in
    // launch order, which is also the order their rollouts appear
    const candidates = this.expecting
      .filter((e) => samePath(e.cwd, meta.cwd) && birth >= e.startedAt - EARLY_SLACK_MS)
      .sort((a, b) => a.startedAt - b.startedAt)
    const exp = candidates[0]
    if (!exp) return
    this.expecting = this.expecting.filter((e) => e !== exp)
    this.bind(exp, file, meta.sessionId, false)
    this.stopWatchingIfIdle()
  }

  private bind(exp: CodexExpectation, file: string, sessionId: string, resumed: boolean): void {
    const { repo, worktree } = describeCwd(exp.cwd)
    const meta = readSessionMeta(file)
    const instance: Instance = {
      sessionId,
      pid: exp.pid,
      cwd: exp.cwd,
      repo,
      worktree,
      gitBranch: meta?.gitBranch ?? '',
      name: repo,
      cli: 'codex',
      cliKind: 'codex',
      kind: 'embedded',
      state: 'idle',
      now: { title: '', activity: 'Starting up…', queued: [] },
      recent: { lastPrompt: '', lastAssistantText: '', prs: [], issues: [], turns: 0 },
      startedAt: exp.startedAt,
      lastActiveAt: Date.now(),
      version: meta?.cliVersion,
      model: exp.model ?? meta?.model,
      permissionMode: exp.permissionMode && exp.permissionMode !== 'default' ? exp.permissionMode : undefined
    }
    const b: Bound = {
      ptyId: exp.ptyId,
      sessionId,
      file,
      tailer: null as unknown as TranscriptTailer<RolloutRecord>,
      caughtUp: false,
      resumed,
      pending: null,
      screen: ''
    }
    this.store.adopt(instance, file)
    b.tailer = new TranscriptTailer<RolloutRecord>(
      file,
      (rec) => {
        for (const ev of toEvents(rec)) this.apply(b, ev)
      },
      () => {
        if (!b.caughtUp) {
          b.caughtUp = true
          // a fresh session's opening turn is already live by the time the
          // file is first read — settle its state from what was replayed
          this.store.mutate(sessionId, (inst) => {
            if (inst.now.activity === 'Starting up…') inst.now.activity = ''
          })
        }
      }
    )
    this.bound.set(exp.ptyId, b)
    this.bySession.set(sessionId, b)
    b.tailer.start()
    void this.refreshBranch(sessionId, exp.cwd)
    this.ensureWatching()
  }

  /** Codex's rollout does not carry the branch per record like Claude's does. */
  private refreshBranch(sessionId: string, cwd: string): Promise<void> {
    return new Promise((resolve) => {
      execFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, timeout: 5000 }, (err, out) => {
        const branch = err ? '' : out.trim()
        if (branch && branch !== 'HEAD') {
          this.store.mutate(sessionId, (inst) => {
            inst.gitBranch = branch
          })
        }
        resolve()
      })
    })
  }

  /** state changes count when the session is live — always for a fresh
   *  session, only after the replay for a resumed one */
  private live(b: Bound): boolean {
    return !b.resumed || b.caughtUp
  }

  private apply(b: Bound, ev: CodexEvent): void {
    const live = this.live(b)
    this.store.mutate(b.sessionId, (inst) => {
      inst.lastActiveAt = Math.max(inst.lastActiveAt, ev.at)
      switch (ev.kind) {
        case 'meta':
          if (ev.meta.cliVersion) inst.version = ev.meta.cliVersion
          if (ev.meta.model && !inst.model) inst.model = ev.meta.model
          if (ev.meta.gitBranch) inst.gitBranch = ev.meta.gitBranch
          return
        case 'settings':
          if (ev.model) inst.model = ev.model
          if (ev.approval || ev.sandbox) {
            inst.permissionMode = [ev.approval, ev.sandbox].filter(Boolean).join(' · ')
          }
          return
        case 'turn-start':
          if (ev.window) this.setWindow(inst, ev.window)
          if (live) {
            inst.state = 'busy'
            this.clearAsk(inst)
            inst.now.turnStartedAt = ev.at
            inst.now.activity = 'Thinking…'
          }
          return
        case 'user':
          // the same message arrives as item_completed AND (older builds) as
          // user_message — count it once
          if (inst.recent.lastPrompt === ev.text && Math.abs(inst.lastActiveAt - ev.at) < 5000 && inst.recent.turns > 0) return
          inst.recent.lastPrompt = ev.text
          inst.recent.turns += 1
          inst.now.queued = inst.now.queued.filter((q) => q !== ev.text)
          if (!inst.now.title) inst.now.title = oneLine(ev.text, 60)
          if (live) {
            inst.state = 'busy'
            this.clearAsk(inst)
            inst.now.turnStartedAt = inst.now.turnStartedAt ?? ev.at
            inst.now.activity = 'Thinking…'
          }
          return
        case 'reply':
          inst.recent.lastAssistantText = ev.text
          inst.now.activity = `Replying: ${oneLine(ev.text, 60)}`
          this.addPrs(inst, ev.text)
          if (live && inst.state === 'idle') inst.state = 'busy'
          return
        case 'tool': {
          b.pending = { name: ev.name, input: ev.input, callId: ev.callId }
          inst.now.activity = describeCodexTool(ev.name, ev.input)
          if (live && inst.state === 'idle') inst.state = 'busy'
          // airspace control speaks Claude's tool names — translate
          const cmd = codexCommand(ev.name, ev.input)
          if (cmd) this.store.noteToolUse(inst, 'Bash', { command: cmd })
          for (const f of codexPatchFiles(ev.name, ev.input)) {
            this.store.noteToolUse(inst, 'Edit', { file_path: path.isAbsolute(f) ? f : path.join(inst.cwd, f) })
          }
          return
        }
        case 'tool-result':
          if (!b.pending || !ev.callId || !b.pending.callId || b.pending.callId === ev.callId) b.pending = null
          if (ev.text) this.addPrs(inst, ev.text)
          if (live && inst.state === 'needs-you') {
            // the approval was answered in the terminal — nothing else says so
            inst.state = 'busy'
            this.clearAsk(inst)
            inst.now.activity = 'Thinking…'
          }
          return
        case 'tokens': {
          const prev = inst.context
          const window = ev.window ?? prev?.window ?? FALLBACK_WINDOW
          inst.context = {
            tokens: ev.tokens,
            window,
            pct: ev.tokens / window,
            compactions: prev?.compactions ?? 0,
            lastCompactAt: prev?.lastCompactAt
          }
          return
        }
        case 'compacted': {
          const prev = inst.context
          inst.context = {
            tokens: prev?.tokens ?? 0,
            window: prev?.window ?? FALLBACK_WINDOW,
            pct: prev ? prev.tokens / prev.window : 0,
            compactions: (prev?.compactions ?? 0) + 1,
            lastCompactAt: ev.at
          }
          return
        }
        case 'approval':
          if (!live) return
          this.raiseAsk(inst, ev.text)
          return
        case 'turn-end': {
          b.pending = null
          const turnStartedAt = inst.now.turnStartedAt
          inst.now.turnStartedAt = undefined
          if (ev.lastMessage) {
            inst.recent.lastAssistantText = ev.lastMessage
            this.addPrs(inst, ev.lastMessage)
          }
          inst.now.activity = ''
          if (!live) return
          // a reply that ends on a question is a clone waiting on you; anything
          // else is just done
          const t = (ev.lastMessage ?? '').replace(/\s+/g, ' ').trim()
          if (/\?[\s"'’”)\]]*$/.test(t)) {
            inst.state = 'needs-you'
            inst.now.askKind = 'reply'
            inst.now.pendingAsk = t.length > 280 ? '…' + t.slice(-279) : t
            inst.now.pendingOptions = undefined
            inst.now.activity = `Waiting: ${inst.now.pendingAsk}`
            this.emit('ask', inst.sessionId, inst.now.pendingAsk)
          } else {
            inst.state = 'idle'
            this.clearAsk(inst)
          }
          this.emit('stop', inst.sessionId, turnStartedAt)
          void this.refreshBranch(inst.sessionId, inst.cwd)
          return
        }
      }
    })
  }

  private setWindow(inst: Instance, window: number): void {
    const prev = inst.context
    if (!prev) return
    if (prev.window !== window) inst.context = { ...prev, window, pct: prev.tokens / window }
  }

  private addPrs(inst: Instance, text: string): void {
    for (const pr of prLinksIn(text)) {
      if (!inst.recent.prs.some((p) => p.url === pr.url)) inst.recent.prs.push(pr)
    }
  }

  private clearAsk(inst: Instance): void {
    inst.now.pendingAsk = undefined
    inst.now.askKind = undefined
    inst.now.pendingOptions = undefined
  }

  private raiseAsk(inst: Instance, text: string): void {
    if (inst.state === 'dead') return
    inst.state = 'needs-you'
    inst.now.askKind = 'permission'
    inst.now.pendingAsk = text
    inst.now.pendingOptions = undefined
    inst.now.activity = `Waiting: ${text}`
    this.emit('ask', inst.sessionId, text)
  }

  /** The terminal-output heuristic for approvals — see APPROVAL_RE. */
  private onData(ptyId: string, data: string): void {
    const b = this.bound.get(ptyId)
    if (!b) return
    b.screen = (b.screen + data.replace(ANSI_RE, '')).slice(-4000)
    if (!APPROVAL_RE.test(b.screen)) return
    const inst = this.store.get(b.sessionId)
    if (!inst || inst.state !== 'busy') return
    b.screen = '' // one banner per prompt; the next output starts a fresh window
    const pending = b.pending
    const text = pending
      ? (() => {
          const cmd = codexCommand(pending.name, pending.input)
          if (cmd) return `Approve command: ${oneLine(cmd, 240)}`
          const files = codexPatchFiles(pending.name, pending.input)
          if (files.length) return `Approve edits to ${files.map((f) => f.split(/[\\/]/).slice(-2).join('/')).join(', ')}`
          return `Approve ${pending.name}`
        })()
      : 'Approve its request — see the terminal'
    this.store.mutate(b.sessionId, (i) => this.raiseAsk(i, text))
  }

  private onExit(ptyId: string): void {
    this.expecting = this.expecting.filter((e) => e.ptyId !== ptyId)
    const b = this.bound.get(ptyId)
    if (!b) return
    b.tailer.stop()
    this.bound.delete(ptyId)
    this.bySession.delete(b.sessionId)
    this.store.markDead(b.sessionId)
  }
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}
