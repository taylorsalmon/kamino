/**
 * Deconfliction — airspace control for the fleet's git operations.
 *
 * The failure this exists to stop: two clones working the same folder, and one
 * runs `git add -A && git commit` (or `git checkout` / `reset --hard` /
 * `stash`) while the other has uncommitted edits in flight. The first case
 * commits a sibling's half-finished work into someone else's branch; the rest
 * simply destroy it. No amount of agent intelligence prevents this, because a
 * clone has no signal that a sibling exists — if it sees unexpected dirty files
 * it cannot tell them from the user's own changes, or from its own debris.
 *
 * Kamino is the only process on the machine that knows, so it answers the
 * PreToolUse hook and can hand the clone a reason it can act on.
 *
 * Deliberately NOT a file lock: Claude Code's Edit tool already refuses to
 * apply a change when the file moved under it (the check is content-based, so
 * a sibling's write trips it exactly like the user's would). Locking files
 * would re-implement that guard and buy false positives. This guards only the
 * operations that have no such protection and whose damage is irreversible.
 *
 * Two hard rules, because this sits in front of every Bash call on the machine:
 *  - no subprocess and no file I/O in the decision path — answer from memory
 *  - unknown means allow; a wedged or confused guard must never stop work
 */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import type { ContestedFile, DeconflictEvent, DeconflictMode, FileClaim } from '../shared/types'

/** claims go stale — a clone that last edited long ago is no longer "in flight" */
const CLAIM_TTL_MS = 15 * 60 * 1000
/** how far back the contested-files view looks. Longer than a claim, because
 *  "where do my clones keep meeting" is a question about the session, not about
 *  what is uncommitted this minute. */
const CONTESTED_WINDOW_MS = 60 * 60 * 1000
/** most files tracked for contention before the oldest are dropped */
const TOUCH_LIMIT = 600
/** most events kept for the Airspace log */
const LOG_LIMIT = 200
/** tools whose input names a file the clone is actively changing */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export type GitRisk = 'stage-all' | 'destructive'

interface Claim {
  sessionId: string
  name: string
  cwd: string
  /** file path → last touched */
  files: Map<string, number>
  lastEditAt: number
}

/** Split a shell line into the commands it actually runs. */
function segments(command: string): string[] {
  return command
    .split(/\|\||&&|;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Tokens of one command, quotes stripped, `git -C <path>` prefix skipped. */
function gitArgs(segment: string): string[] | null {
  const raw = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
  if (!raw) return null
  const toks = raw.map((t) => t.replace(/^["']|["']$/g, ''))
  let i = 0
  // env prefixes (FOO=bar git ...) and a leading path to the binary
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++
  const bin = toks[i]
  if (!bin) return null
  if (!/(^|[\\/])git(\.exe)?$/i.test(bin)) return null
  i++
  // global options that take a value we must skip past
  while (i < toks.length && (toks[i] === '-C' || toks[i] === '-c' || toks[i] === '--git-dir' || toks[i] === '--work-tree')) {
    i += 2
  }
  return toks.slice(i)
}

/**
 * Classify a Bash command for sibling risk. Conservative on purpose: a case we
 * fail to recognise passes harmlessly, whereas an over-eager rule costs the
 * clone a turn arguing with a wall.
 */
export function classifyGit(command: string): { risk: GitRisk; what: string } | null {
  for (const seg of segments(command)) {
    const args = gitArgs(seg)
    if (!args || args.length === 0) continue
    const sub = args[0]
    const rest = args.slice(1)
    const flags = rest.filter((a) => a.startsWith('-'))
    const paths = rest.filter((a) => !a.startsWith('-'))
    const hasFlag = (...names: string[]): boolean =>
      flags.some((f) =>
        names.some((n) => (n.startsWith('--') ? f === n : f.startsWith('-') && !f.startsWith('--') && f.includes(n.slice(1))))
      )

    switch (sub) {
      case 'add':
        // -A/--all/-u stage the whole tree; so does a bare `.` or `:/`
        if (hasFlag('-A', '--all', '-u', '--update') || paths.some((p) => p === '.' || p === ':/' || p === '*')) {
          return { risk: 'stage-all', what: `git add ${rest.join(' ')}`.trim() }
        }
        break
      case 'commit':
        // -a stages every tracked modification, sibling edits included
        if (hasFlag('-a', '--all')) return { risk: 'stage-all', what: `git commit ${rest.join(' ')}`.trim() }
        break
      case 'stage':
        if (paths.some((p) => p === '.' || p === ':/') || hasFlag('-A', '--all')) {
          return { risk: 'stage-all', what: `git stage ${rest.join(' ')}`.trim() }
        }
        break
      case 'checkout':
      case 'switch': {
        // `checkout -- <path>` and `checkout <path>` discard working changes;
        // a bare branch change moves the tree under a sibling mid-edit
        return { risk: 'destructive', what: `git ${sub} ${rest.join(' ')}`.trim() }
      }
      case 'restore':
        return { risk: 'destructive', what: `git restore ${rest.join(' ')}`.trim() }
      case 'reset':
        if (hasFlag('--hard', '--merge', '--keep')) {
          return { risk: 'destructive', what: `git reset ${rest.join(' ')}`.trim() }
        }
        break
      case 'stash': {
        const verb = paths[0] ?? 'push'
        // reading the stash is harmless; pushing/popping rewrites the tree
        if (!['list', 'show'].includes(verb)) {
          return { risk: 'destructive', what: `git stash ${rest.join(' ')}`.trim() }
        }
        break
      }
      case 'clean':
        if (hasFlag('-f', '--force')) return { risk: 'destructive', what: `git clean ${rest.join(' ')}`.trim() }
        break
      default:
        break
    }
  }
  return null
}

/**
 * Does this line commit? That — and only that — means a clone's own edits are
 * no longer in flight. Staging is not committing: `git add` leaves the work
 * just as vulnerable to a sibling's `git checkout`, so releasing a claim on it
 * would drop the guard while it still matters.
 */
export function isGitCommit(command: string): boolean {
  return segments(command).some((seg) => gitArgs(seg)?.[0] === 'commit')
}

const RISK_ADVICE: Record<GitRisk, string> = {
  'stage-all': 'Stage only the files you changed yourself (git add <path> …) and commit those.',
  destructive:
    'Do not run it. Leave the working tree alone and either finish on the current branch or ask the user how to proceed.'
}

/**
 * What to tell the clone instead when an arbiter is going to settle this.
 *
 * The advice above ends at the user's desk: told to work around a collision it
 * cannot see the far side of, a clone reasonably stops and asks. That question
 * is the thing the arbiter exists to absorb, so when one is coming the clone is
 * told to stand down rather than to improvise — and told explicitly not to ask,
 * because "should I hold?" is still an interruption.
 */
const ARBITER_ADVICE =
  'Kamino has dispatched an arbiter to settle this. Do NOT ask the user about it, do NOT retry this ' +
  'command, and do NOT work around it by staging or moving files yourself. Stop here and end your turn. ' +
  'Fresh orders will arrive in this terminal when the arbiter is done.'

/** one clone's edit history for one file */
interface Touch {
  sessionId: string
  name: string
  at: number
  edits: number
}

export class Deconflictor extends EventEmitter {
  private claims = new Map<string, Claim>() // key: sessionId
  /** file → sessionId → touch. Observation only; nothing is blocked over it. */
  private touches = new Map<string, Map<string, Touch>>()
  private log: DeconflictEvent[] = []
  private mode: DeconflictMode = 'warn'
  private prevented = 0
  private seq = 0
  /**
   * Sessions the guard does not apply to — in practice, the arbiters Kamino
   * dispatches. An arbiter works in a folder full of siblings by definition, so
   * without this it would be blocked by the very collision it was sent to fix,
   * and its own edits would register as yet another claim for the next clone to
   * trip over. Membership is granted by Kamino, never inferred.
   */
  private exempt = new Set<string>()
  /** an arbiter will pick this up — change the advice, not the ruling */
  private arbiterEnabled = false

  constructor(private readonly settingsPath?: string) {
    super()
    if (settingsPath) {
      try {
        const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        if (raw?.mode === 'off' || raw?.mode === 'warn' || raw?.mode === 'enforce') this.mode = raw.mode
        if (typeof raw?.prevented === 'number') this.prevented = raw.prevented
      } catch {
        /* first run */
      }
    }
  }

  getMode(): DeconflictMode {
    return this.mode
  }

  /** Exempt an arbiter for as long as it lives. */
  exemptSession(sessionId: string): void {
    this.exempt.add(sessionId)
    // an arbiter that already touched files before we learned its session id
    // would otherwise leave a claim behind after it stands down
    this.claims.delete(sessionId)
  }

  unexemptSession(sessionId: string): void {
    this.exempt.delete(sessionId)
    this.claims.delete(sessionId)
  }

  setArbiterEnabled(on: boolean): void {
    this.arbiterEnabled = on
  }

  setMode(mode: DeconflictMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.persist()
    this.emit('change')
  }

  private persist(): void {
    if (!this.settingsPath) return
    try {
      fs.writeFileSync(this.settingsPath, JSON.stringify({ mode: this.mode, prevented: this.prevented }))
    } catch {
      /* preference only */
    }
  }

  /** A clone touched a file — it now has work in flight in that folder. */
  noteToolUse(sessionId: string, name: string, cloneName: string, cwd: string, input?: Record<string, unknown>): void {
    if (!EDIT_TOOLS.has(name)) return
    if (this.exempt.has(sessionId)) return
    const file = typeof input?.file_path === 'string' ? input.file_path : null
    if (!file) return
    const now = Date.now()
    let claim = this.claims.get(sessionId)
    if (!claim) {
      claim = { sessionId, name: cloneName, cwd, files: new Map(), lastEditAt: now }
      this.claims.set(sessionId, claim)
    }
    claim.name = cloneName
    claim.cwd = cwd
    claim.files.set(file, now)
    claim.lastEditAt = now
    // keep a claim's file list from growing without bound on a long session
    if (claim.files.size > 60) {
      const oldest = [...claim.files.entries()].sort((a, b) => a[1] - b[1])[0]
      if (oldest) claim.files.delete(oldest[0])
    }
    this.recordTouch(file, sessionId, cloneName, now)
  }

  /** Contention history, kept separately from claims: a claim answers "is this
   *  uncommitted right now", a touch answers "who has been in this file". */
  private recordTouch(file: string, sessionId: string, cloneName: string, now: number): void {
    let byClone = this.touches.get(file)
    if (!byClone) {
      byClone = new Map()
      this.touches.set(file, byClone)
    }
    const existing = byClone.get(sessionId)
    if (existing) {
      existing.at = now
      existing.edits += 1
      existing.name = cloneName
    } else {
      byClone.set(sessionId, { sessionId, name: cloneName, at: now, edits: 1 })
    }
    if (this.touches.size > TOUCH_LIMIT) this.evictOldestTouch()
  }

  private evictOldestTouch(): void {
    let oldestFile: string | null = null
    let oldestAt = Infinity
    for (const [file, byClone] of this.touches) {
      let newest = 0
      for (const t of byClone.values()) newest = Math.max(newest, t.at)
      if (newest < oldestAt) {
        oldestAt = newest
        oldestFile = file
      }
    }
    if (oldestFile) this.touches.delete(oldestFile)
  }

  /**
   * Files more than one clone has edited inside the window, worst first. Runs
   * off the Airspace panel, never off the hook path, so the pruning here is
   * cheap enough to do inline.
   */
  contestedFiles(): ContestedFile[] {
    const cutoff = Date.now() - CONTESTED_WINDOW_MS
    const out: ContestedFile[] = []
    for (const [file, byClone] of this.touches) {
      for (const [sessionId, t] of byClone) {
        if (t.at < cutoff) byClone.delete(sessionId)
      }
      if (byClone.size === 0) {
        this.touches.delete(file)
        continue
      }
      if (byClone.size < 2) continue // one clone editing its own file is not contention
      const clones = [...byClone.values()].sort((a, b) => b.at - a.at)
      out.push({
        file,
        clones,
        lastAt: clones[0].at,
        edits: clones.reduce((n, c) => n + c.edits, 0)
      })
    }
    // most clones involved first, then most recent — the top row is the one
    // worth splitting up
    return out.sort((a, b) => b.clones.length - a.clones.length || b.lastAt - a.lastAt)
  }

  /** Its own commit means its work is no longer in flight. */
  noteCommit(sessionId: string): void {
    this.claims.delete(sessionId)
  }

  release(sessionId: string): void {
    this.claims.delete(sessionId)
  }

  /** Live claims held by OTHER sessions working the same folder. */
  private siblings(sessionId: string, cwd: string): Claim[] {
    const cutoff = Date.now() - CLAIM_TTL_MS
    const out: Claim[] = []
    for (const claim of this.claims.values()) {
      if (claim.sessionId === sessionId) continue
      if (claim.lastEditAt < cutoff) {
        this.claims.delete(claim.sessionId)
        continue
      }
      if (claim.cwd === cwd) out.push(claim)
    }
    return out
  }

  claimList(): FileClaim[] {
    const cutoff = Date.now() - CLAIM_TTL_MS
    return [...this.claims.values()]
      .filter((c) => c.lastEditAt >= cutoff)
      .map((c) => ({
        sessionId: c.sessionId,
        name: c.name,
        cwd: c.cwd,
        files: [...c.files.keys()].slice(-8),
        lastEditAt: c.lastEditAt
      }))
  }

  events(): DeconflictEvent[] {
    return this.log
  }

  preventedCount(): number {
    return this.prevented
  }

  /**
   * The PreToolUse answer. Returns a reason to deny with, or null to stay out
   * of the way — including in warn mode, where the event is logged and the
   * command still runs.
   */
  decide(args: {
    sessionId: string
    cwd: string
    toolName: string
    input?: Record<string, unknown>
    cloneName?: string
  }): { deny: true; reason: string } | null {
    if (this.mode === 'off') return null
    if (this.exempt.has(args.sessionId)) return null
    if (args.toolName !== 'Bash' && args.toolName !== 'PowerShell') return null
    const command = typeof args.input?.command === 'string' ? args.input.command : ''
    if (!command || !/\bgit\b/i.test(command)) return null

    // its own commit means its work has landed and no longer needs guarding —
    // tracked separately from the risk check, since an ordinary `git commit -m`
    // carries no risk at all and would otherwise never release the claim
    const committed = isGitCommit(command)
    const releaseSelf = (): void => {
      if (committed) this.noteCommit(args.sessionId)
    }

    const hit = classifyGit(command)
    if (!hit) {
      releaseSelf()
      return null
    }

    const others = this.siblings(args.sessionId, args.cwd)
    if (others.length === 0) {
      releaseSelf()
      return null
    }

    const who = others.map((o) => o.name).join(', ')
    const files = [...new Set(others.flatMap((o) => [...o.files.keys()]))].slice(0, 6)
    const denied = this.mode === 'enforce'
    // the arbiter only ever follows a real denial — in warn mode the command
    // runs, so promising the clone that orders are coming would be a lie
    const arbitrating = denied && this.arbiterEnabled
    const reason =
      `Kamino airspace control: ${who} ${others.length === 1 ? 'is' : 'are'} working in this same folder ` +
      `right now and ${others.length === 1 ? 'has' : 'have'} uncommitted edits in flight` +
      (files.length ? ` (${files.map((f) => f.split(/[\\/]/).pop()).join(', ')})` : '') +
      `. \`${hit.what}\` would ${hit.risk === 'stage-all' ? 'commit their unfinished work into your branch' : 'destroy their uncommitted changes'}. ` +
      (arbitrating ? ARBITER_ADVICE : RISK_ADVICE[hit.risk])

    if (denied) this.prevented += 1
    // it ran after all (warn mode), so a commit in it did land
    else releaseSelf()
    const event: DeconflictEvent = {
      id: `dc-${++this.seq}`,
      at: Date.now(),
      sessionId: args.sessionId,
      cloneName: args.cloneName ?? args.sessionId.slice(0, 8),
      cwd: args.cwd,
      command: hit.what,
      risk: hit.risk,
      siblings: others.map((o) => o.name),
      siblingFiles: files,
      denied
    }
    this.log.unshift(event)
    if (this.log.length > LOG_LIMIT) this.log.pop()
    if (denied) this.persist()
    this.emit('event', event)

    return denied ? { deny: true, reason } : null
  }
}
