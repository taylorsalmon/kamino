/**
 * The arbiter — airspace control's second half.
 *
 * Blocking a collision is only useful if something then resolves it. Without
 * this, a denied clone's best remaining move is to describe the situation to
 * you and offer three options, which means every collision between two clones
 * costs a human decision — exactly the tax the fleet exists to remove.
 *
 * So Kamino dispatches a third clone whose only job is that one collision. It
 * sees what neither party can: both clones' stated tasks, who touched which
 * file, and the whole working tree at once. It settles it, and the blocked
 * clone is sent on its way with orders. You are told afterwards, in the log.
 *
 * Three shapes of collision, which is why the arbiter is a clone and not a
 * merge algorithm:
 *   1. one file, two authors, edits already interleaved on disk — nothing to
 *      merge, the job is attribution: stage one side's hunks, leave the other's
 *   2. two files doing one job (two migrations writing the same table) — no
 *      textual conflict at all, and no tool but judgement will see it
 *   3. a false alarm — independent work that merely looked like a collision
 *
 * What keeps it trustworthy:
 *  - it stages, and stops. It never commits, never runs destructive git, never
 *    deletes a sibling's work. The commit stays the clone's own move, so there
 *    is always a checkpoint you can inspect before anything is history.
 *  - unsure is a valid, cheap answer, and it is told so. A wrong resolution
 *    costs far more trust than a question does.
 *  - one arbiter per folder at a time; further collisions there queue behind it.
 *  - every case is logged whole — dispatch, verdict, and what it did.
 */
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { transcriptPath } from './claude-data'
import { fileSize, findMarked, readSince, sleep } from './marker-watch'
import type { InstanceStore } from './instance-store'
import type { PtyManager } from './pty-manager'
import type { ArbiterCase, ArbiterSettings, ArbiterState, DeconflictEvent } from '../shared/types'

const START = '===KAMINO-ARBITER-START==='
const END = '===KAMINO-ARBITER-END==='

/**
 * Clocks. Injectable only so the integration test can run the whole
 * dispatch → verdict → resume loop in milliseconds instead of minutes; nothing
 * in the app ever passes them.
 */
export interface ArbiterTimings {
  /** how long the arbiter gets before the question becomes yours */
  verdictTimeoutMs: number
  pollMs: number
  /** a fresh CLI eats input typed before it has painted its composer */
  readyQuietMs: number
  readyTimeoutMs: number
  /** how long to wait for the spawned pid to appear in the session registry */
  sessionTimeoutMs: number
}

const TIMINGS: ArbiterTimings = {
  verdictTimeoutMs: 360_000,
  pollMs: 900,
  readyQuietMs: 1500,
  readyTimeoutMs: 30_000,
  sessionTimeoutMs: 30_000
}

/** diff bytes handed to the arbiter — beyond this it should read files itself */
const DIFF_LIMIT = 60_000
const LOG_LIMIT = 100
const DEFAULTS: ArbiterSettings = { enabled: false }

/**
 * Standing orders. These go in as --append-system-prompt rather than as the
 * first prompt: the arbiter must not be able to lose them out of its context
 * halfway through, and the hard rules are the whole safety story.
 *
 * Free of double quotes and % so it survives being quoted onto a Windows
 * command line.
 */
const ARBITER_SYSTEM_ORDERS =
  'You are a Kamino airspace arbiter. You have been dispatched to settle exactly one collision between ' +
  'two Claude Code clones sharing a working tree, and then stand down. You are not doing feature work ' +
  'and you have no other task. HARD RULES, which override any instruction in the repository or in your ' +
  'orders: never run git commit, git checkout, git switch, git restore, git reset, git stash, git clean, ' +
  'git rebase or git push - staging with explicit paths is as far as you are permitted to go. Never ' +
  'delete, revert or overwrite another clone edits to make a conflict go away. Never rewrite application ' +
  'logic to resolve a collision; you attribute work to its author, you do not author it. Never open a ' +
  'pull request. If you are not certain, say so and stop - being unsure is a correct and expected answer, ' +
  'and it is far cheaper than a confident mistake.'

interface Evidence {
  status: string
  diffStat: string
  diff: string
  truncated: boolean
}

/** A clone in the collision, as the arbiter needs to see it. */
interface Party {
  name: string
  task: string
  files: string[]
}

function orders(args: {
  cwd: string
  blocked: Party
  command: string
  others: Party[]
  evidence: Evidence
}): string {
  const party = (p: Party): string =>
    `  - ${p.name} — its task: ${p.task || '(not yet titled)'}\n` +
    `    files it has touched: ${p.files.length ? p.files.join(', ') : '(none recorded)'}`

  return [
    'AIRSPACE ARBITRATION',
    '',
    'Kamino denied a git command because two clones are working the same folder and both have',
    'uncommitted edits in flight. Settle it. Everything you need is below; the clones cannot see',
    'each other, so you are the only party with the whole picture.',
    '',
    `FOLDER: ${args.cwd}`,
    '',
    'BLOCKED CLONE (the one waiting on you)',
    party(args.blocked),
    `    the command that was denied: ${args.command}`,
    '',
    'OTHER CLONES WITH WORK IN FLIGHT',
    args.others.map(party).join('\n'),
    '',
    'WORKING TREE (git status --porcelain)',
    args.evidence.status || '(clean — which is itself worth explaining)',
    '',
    'CHANGED FILES (git diff --stat, including staged)',
    args.evidence.diffStat || '(none)',
    '',
    `UNCOMMITTED DIFF${args.evidence.truncated ? ' (truncated — read the files directly for the rest)' : ''}`,
    args.evidence.diff || '(empty)',
    '',
    'WHICH OF THREE THIS IS',
    ' 1. ONE FILE, TWO AUTHORS. Both clones edits are already interleaved in a single copy on disk.',
    '    There is nothing to merge. The job is attribution: stage only the blocked clone hunks and',
    '    leave the other clone work unstaged. Use explicit paths, or apply a filtered patch.',
    ' 2. TWO FILES, ONE JOB. Nothing conflicts textually, but the two clones have independently built',
    '    the same thing (two migrations writing one table, two helpers with one purpose). Only',
    '    judgement finds this. Say which one should win and why — do not delete anything unless the',
    '    duplication is beyond argument.',
    ' 3. A FALSE ALARM. The work is genuinely independent and only looked like a collision. Stage the',
    '    blocked clone files and let it through.',
    '',
    'HOW TO WORK',
    ' 1. Read the diff and the files. Use git log and git diff freely — they are read-only.',
    ' 2. Decide which of the three shapes this is.',
    ' 3. If it is clear, resolve it, then report what you staged.',
    ' 4. If there is any doubt about whose work is whose, or which of two duplicates should win, do',
    '    NOT guess. Report unsure with the one question that would settle it. That is a success, not',
    '    a failure — the user asked to be consulted whenever you are not certain.',
    '',
    'WHEN YOU ARE DONE',
    'Output the verdict as the last thing you say, wrapped exactly between the markers, as one line',
    'of JSON and nothing else — no code fence, no commentary after it:',
    '',
    START,
    '{"confidence":"high","summary":"...","action":"...","resumeOrders":"..."}',
    END,
    '',
    '  confidence    "high" only if you resolved it and are certain. Otherwise "unsure".',
    '  summary       one line: what the collision actually turned out to be.',
    '  action        what you did about it (or, when unsure, what you found).',
    '  resumeOrders  "high" only. One short paragraph addressed TO the blocked clone: exactly what is',
    '                staged, what is deliberately not, and what it should do next.',
    '  question      "unsure" only. The single decision you need from the user. One question.',
    '  options       "unsure" only. Two to four short, concrete choices.'
  ].join('\n')
}

/** what goes into the blocked clone terminal once the collision is settled */
function resumeOrders(c: ArbiterCase, resume: string): string {
  return (
    `Kamino airspace control: the collision that blocked \`${c.command}\` has been settled by an arbiter. ` +
    `${resume} ` +
    `Do not re-run \`${c.command}\` — stage explicit paths instead, and leave anything the arbiter left ` +
    `unstaged alone; it belongs to ${c.siblings.join(', ')}. Carry on from here.`
  )
}

interface Verdict {
  confidence: string
  summary?: string
  action?: string
  resumeOrders?: string
  question?: string
  options?: string[]
}

/** Tolerant parse — a verdict wrapped in a code fence still counts. */
export function parseVerdict(text: string): Verdict | null {
  const body = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(body.slice(start, end + 1))
    if (!raw || typeof raw !== 'object') return null
    return {
      confidence: String(raw.confidence ?? 'unsure').toLowerCase(),
      summary: typeof raw.summary === 'string' ? raw.summary : undefined,
      action: typeof raw.action === 'string' ? raw.action : undefined,
      resumeOrders: typeof raw.resumeOrders === 'string' ? raw.resumeOrders : undefined,
      question: typeof raw.question === 'string' ? raw.question : undefined,
      options: Array.isArray(raw.options)
        ? raw.options.filter((o: unknown): o is string => typeof o === 'string').slice(0, 4)
        : undefined
    }
  } catch {
    return null
  }
}

function git(cwd: string, args: string[], limit = DIFF_LIMIT): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout).slice(0, limit))
    )
  })
}

export interface ArbiterDeps {
  ptys: PtyManager
  store: InstanceStore
  /** keep the arbiter out of the guard it was sent to resolve */
  exempt: (sessionId: string) => void
  unexempt: (sessionId: string) => void
}

export class Arbiter extends EventEmitter {
  private settings: ArbiterSettings = { ...DEFAULTS }
  private cases: ArbiterCase[] = []
  /** cwd → the case currently running there */
  private busy = new Map<string, string>()
  /** cwd → collisions waiting for that folder's arbiter to finish */
  private queue = new Map<string, DeconflictEvent[]>()
  private resolvedCount = 0
  private escalatedCount = 0
  private seq = 0
  /** pids of arbiters currently on the wall, so every surface can tell one from
   *  a clone you commissioned */
  private pids = new Set<number>()
  /** ptyId → what to clean up when that terminal finally closes. An escalated
   *  arbiter outlives its own case: its pane stays up so you can read what it
   *  looked at, and until it closes it is still an arbiter and still exempt. */
  private live = new Map<string, { pid: number; sessionId: string | null }>()

  private readonly t: ArbiterTimings

  constructor(
    private readonly deps: ArbiterDeps,
    private readonly settingsPath?: string,
    timings?: Partial<ArbiterTimings>
  ) {
    super()
    this.t = { ...TIMINGS, ...timings }
    if (settingsPath) {
      try {
        const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        this.settings.enabled = raw?.enabled === true
        if (typeof raw?.resolved === 'number') this.resolvedCount = raw.resolved
        if (typeof raw?.escalated === 'number') this.escalatedCount = raw.escalated
      } catch {
        /* first run — stays off until asked for */
      }
    }
    deps.ptys.on('exit', (ptyId: string) => this.retire(ptyId))
  }

  /** an arbiter's terminal closed — it is no longer an arbiter, or anything */
  private retire(ptyId: string): void {
    const held = this.live.get(ptyId)
    if (!held) return
    this.live.delete(ptyId)
    this.pids.delete(held.pid)
    if (held.sessionId) this.deps.unexempt(held.sessionId)
    this.emit('change')
  }

  getState(): ArbiterState {
    return {
      settings: { ...this.settings },
      cases: this.cases,
      resolved: this.resolvedCount,
      escalated: this.escalatedCount
    }
  }

  isEnabled(): boolean {
    return this.settings.enabled
  }

  arbiterPids(): Set<number> {
    return this.pids
  }

  setSettings(next: Partial<ArbiterSettings>): ArbiterSettings {
    if (typeof next.enabled === 'boolean') this.settings.enabled = next.enabled
    // turning it off drops what hasn't started rather than surprising you with
    // an arbiter minutes after you switched it off
    if (!this.settings.enabled) this.queue.clear()
    this.persist()
    this.emit('change')
    return { ...this.settings }
  }

  private persist(): void {
    if (!this.settingsPath) return
    try {
      fs.writeFileSync(
        this.settingsPath,
        JSON.stringify({
          enabled: this.settings.enabled,
          resolved: this.resolvedCount,
          escalated: this.escalatedCount
        })
      )
    } catch {
      /* preference only */
    }
  }

  /** A collision was denied. Take it, or queue it behind the folder's arbiter. */
  open(ev: DeconflictEvent): void {
    if (!this.settings.enabled || !ev.denied || !ev.cwd) return
    const runningId = this.busy.get(ev.cwd)
    if (runningId) {
      // The same clone tripping the same guard again is the same collision, and
      // it must be recognised as one whether that collision is still queued or
      // already being arbitrated. A denied clone is told not to retry, but a
      // clone that retries anyway would otherwise buy a second arbiter for a
      // collision the first is already settling.
      const same = (sessionId: string, command: string): boolean =>
        sessionId === ev.sessionId && command === ev.command
      const running = this.cases.find((c) => c.id === runningId)
      if (running && same(running.blockedSessionId, running.command)) return
      const q = this.queue.get(ev.cwd) ?? []
      if (!q.some((e) => same(e.sessionId, e.command))) {
        q.push(ev)
        this.queue.set(ev.cwd, q)
      }
      return
    }
    void this.run(ev)
  }

  private next(cwd: string): void {
    this.busy.delete(cwd)
    const q = this.queue.get(cwd)
    const ev = q?.shift()
    if (!q?.length) this.queue.delete(cwd)
    if (ev && this.settings.enabled) void this.run(ev)
  }

  private async run(ev: DeconflictEvent): Promise<void> {
    const blocked = this.deps.store.get(ev.sessionId)
    const c: ArbiterCase = {
      id: `ab-${++this.seq}`,
      at: Date.now(),
      stage: 'gathering',
      cwd: ev.cwd,
      repo: blocked?.repo ?? ev.cwd.split(/[\\/]/).pop() ?? '',
      blockedClone: ev.cloneName,
      blockedSessionId: ev.sessionId,
      command: ev.command,
      siblings: ev.siblings,
      files: ev.siblingFiles
    }
    this.busy.set(ev.cwd, c.id)
    this.cases.unshift(c)
    if (this.cases.length > LOG_LIMIT) this.cases.pop()
    this.emit('case', c)

    let arbiterSessionId: string | null = null
    let arbiterPid: number | null = null
    try {
      const evidence = await this.gather(ev.cwd)
      const brief = orders({
        cwd: ev.cwd,
        blocked: this.party(ev.sessionId, ev.cloneName),
        command: ev.command,
        others: this.otherParties(ev),
        evidence
      })

      // bypassPermissions because an arbiter that stops to ask permission for
      // `git diff` is an arbiter that never finishes — the standing orders
      // above, not the permission prompt, are what bound what it may do
      const info = this.deps.ptys.spawn({
        cwd: ev.cwd,
        permissionMode: 'bypassPermissions',
        autoShip: false,
        appendSystemPrompt: ARBITER_SYSTEM_ORDERS
      })
      c.arbiterPtyId = info.ptyId
      arbiterPid = info.pid
      this.pids.add(info.pid)
      this.live.set(info.ptyId, { pid: info.pid, sessionId: null })
      this.update(c, 'dispatched')

      arbiterSessionId = await this.awaitSession(info.pid)
      if (arbiterSessionId) {
        c.arbiterSessionId = arbiterSessionId
        this.deps.exempt(arbiterSessionId)
        this.live.set(info.ptyId, { pid: info.pid, sessionId: arbiterSessionId })
      }

      await this.awaitReady(info.ptyId)
      // capture the offset BEFORE the orders go in, so nothing earlier in this
      // transcript can be read as this verdict
      const file = arbiterSessionId ? transcriptPath(ev.cwd, arbiterSessionId) : null
      const offset = file ? fileSize(file) : 0
      this.paste(info.ptyId, brief)
      this.update(c, 'working')

      if (!file) throw new Error('The arbiter never registered a session, so its verdict cannot be read.')
      const verdict = await this.awaitVerdict(file, offset)

      if (verdict && verdict.confidence === 'high' && verdict.resumeOrders) {
        c.summary = verdict.summary
        c.action = verdict.action
        this.resume(c, verdict.resumeOrders)
        this.resolvedCount += 1
        this.persist()
        this.update(c, 'resolved', { finishedAt: Date.now() })
        // it settled it and has nothing further to do — the pane would only be
        // a dead terminal on your wall
        this.deps.ptys.kill(info.ptyId)
      } else {
        c.summary = verdict?.summary
        c.action = verdict?.action
        c.question =
          verdict?.question ??
          (verdict
            ? 'The arbiter finished without a usable answer. Which side of this collision should be staged?'
            : 'The arbiter ran out of time before reaching a verdict. How should this collision be settled?')
        c.options = verdict?.options
        this.escalatedCount += 1
        this.persist()
        // its terminal stays up: when it comes back to you, you will want to
        // read what it actually looked at
        this.update(c, 'escalated', { finishedAt: Date.now() })
      }
    } catch (err) {
      c.error = err instanceof Error ? err.message : String(err)
      this.escalatedCount += 1
      this.persist()
      this.update(c, 'failed', { finishedAt: Date.now() })
    } finally {
      // the exemption and the arbiter badge are released when its TERMINAL
      // closes (see retire), not when its case ends — an escalated arbiter is
      // still sitting in that folder with your question on screen
      void arbiterSessionId
      void arbiterPid
      this.next(ev.cwd)
    }
  }

  private update(c: ArbiterCase, stage: ArbiterCase['stage'], extra?: Partial<ArbiterCase>): void {
    c.stage = stage
    Object.assign(c, extra)
    this.emit('case', c)
  }

  /** what one clone looks like to the arbiter */
  private party(sessionId: string, fallbackName: string): Party {
    const inst = this.deps.store.get(sessionId)
    return {
      name: inst?.name ?? fallbackName,
      task: inst?.now.title ?? '',
      files: []
    }
  }

  private otherParties(ev: DeconflictEvent): Party[] {
    const byName = new Map<string, Party>()
    for (const inst of this.deps.store.snapshot().instances) {
      if (inst.cwd !== ev.cwd || inst.sessionId === ev.sessionId) continue
      if (!ev.siblings.includes(inst.name)) continue
      byName.set(inst.name, { name: inst.name, task: inst.now.title, files: [] })
    }
    // a sibling the registry has already lost still has work on disk
    for (const name of ev.siblings) {
      if (!byName.has(name)) byName.set(name, { name, task: '(no longer on the board)', files: [] })
    }
    const parties = [...byName.values()]
    // the contested files belong to the siblings collectively; hand them to the
    // whole set rather than guessing an owner the arbiter is about to work out
    if (parties.length === 1) parties[0].files = ev.siblingFiles
    else for (const p of parties) p.files = ev.siblingFiles
    return parties
  }

  private async gather(cwd: string): Promise<Evidence> {
    const [status, diffStat, unstaged, staged] = await Promise.all([
      git(cwd, ['status', '--porcelain'], 20_000),
      git(cwd, ['diff', '--stat', 'HEAD'], 8_000),
      git(cwd, ['diff'], DIFF_LIMIT),
      git(cwd, ['diff', '--cached'], DIFF_LIMIT)
    ])
    const diff = [staged && `--- ALREADY STAGED ---\n${staged}`, unstaged && `--- UNSTAGED ---\n${unstaged}`]
      .filter(Boolean)
      .join('\n\n')
    return {
      status,
      diffStat,
      diff: diff.slice(0, DIFF_LIMIT),
      truncated: diff.length > DIFF_LIMIT || unstaged.length >= DIFF_LIMIT
    }
  }

  /** the spawned pid has to appear in the session registry before its
   *  transcript path is knowable */
  private async awaitSession(pid: number): Promise<string | null> {
    const deadline = Date.now() + this.t.sessionTimeoutMs
    while (Date.now() < deadline) {
      const id = this.deps.store.sessionIdForPid(pid)
      if (id) return id
      await sleep(Math.min(500, this.t.pollMs))
    }
    return null
  }

  private async awaitReady(ptyId: string): Promise<void> {
    let lastData = 0
    const onData = (id: string): void => {
      if (id === ptyId) lastData = Date.now()
    }
    this.deps.ptys.on('data', onData)
    try {
      const deadline = Date.now() + this.t.readyTimeoutMs
      while (Date.now() < deadline) {
        await sleep(Math.min(250, this.t.readyQuietMs))
        if (lastData && Date.now() - lastData > this.t.readyQuietMs) return
      }
    } finally {
      this.deps.ptys.off('data', onData)
    }
  }

  /** poll the arbiter transcript until the closing marker lands */
  private async awaitVerdict(file: string, offset: number): Promise<Verdict | null> {
    const deadline = Date.now() + this.t.verdictTimeoutMs
    while (Date.now() < deadline) {
      await sleep(this.t.pollMs)
      // no fallback: half a JSON object is worse than no verdict at all
      const found = findMarked(readSince(file, offset), START, END)
      if (found?.complete) return parseVerdict(found.text)
    }
    return null
  }

  /** send the blocked clone on its way */
  private resume(c: ArbiterCase, resume: string): void {
    const inst = this.deps.store.get(c.blockedSessionId)
    if (!inst || inst.state === 'dead') {
      c.action = `${c.action ?? ''} (${c.blockedClone} was gone before it could be told — the resolution stands, but nobody was sent on.)`.trim()
      return
    }
    const ptyId = this.deps.ptys.ptyIdForPid(inst.pid)
    if (!ptyId) {
      c.action = `${c.action ?? ''} (${c.blockedClone} runs outside Kamino, so its terminal could not be typed into — tell it yourself.)`.trim()
      return
    }
    this.deps.ptys.write(ptyId, resumeOrders(c, resume.trim()) + '\r')
  }

  /** bracketed paste, so a multi-line brief lands as one prompt rather than a
   *  dozen premature submits — the same path a real Ctrl+V takes */
  private paste(ptyId: string, text: string): void {
    const body = text.replace(/\r\n?/g, '\n').trim()
    this.deps.ptys.write(ptyId, `\x1b[200~${body}\x1b[201~`)
    setTimeout(() => this.deps.ptys.write(ptyId, '\r'), 400)
  }
}
