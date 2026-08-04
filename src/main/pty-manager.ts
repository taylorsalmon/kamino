/**
 * PtyManager — spawns and owns embedded Claude Code instances.
 *
 * We spawn claude.exe directly (no shell wrapper) so the PTY child pid IS the
 * pid Claude Code writes to ~/.claude/sessions/<pid>.json — that's how an
 * embedded terminal is matched to its Instance card.
 */
import { EventEmitter } from 'node:events'
import { execSync } from 'node:child_process'
import * as pty from '@lydell/node-pty'

export interface SpawnOptions {
  cwd: string
  resumeSessionId?: string
  initialPrompt?: string
  permissionMode?: string
  /** standing orders: ship finished work without being asked. Defaults on —
   *  pass false to commission a clone that leaves shipping to you. */
  autoShip?: boolean
  cols?: number
  rows?: number
}

/**
 * Standing orders, appended to the clone's system prompt (--append-system-prompt)
 * rather than typed as a first prompt: a system prompt can't rot out of the
 * context window as the session grows, and it costs no turn.
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

export interface PtyInfo {
  ptyId: string
  pid: number
  cwd: string
}

interface Held {
  proc: pty.IPty
  info: PtyInfo
  /** ring buffer of recent output so a re-mounted view can restore scrollback */
  backlog: string[]
  backlogBytes: number
}

const BACKLOG_LIMIT = 400_000

let claudeExe: string | null = null
function resolveClaudeExe(): string {
  if (claudeExe) return claudeExe
  const out = execSync('where.exe claude', { encoding: 'utf-8' })
  claudeExe = out.split(/\r?\n/).find((l) => l.trim().endsWith('.exe'))?.trim() ?? 'claude.exe'
  return claudeExe
}

export class PtyManager extends EventEmitter {
  private held = new Map<string, Held>()
  private nextId = 1

  spawn(opts: SpawnOptions): PtyInfo {
    const args: string[] = []
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
    if (opts.permissionMode && opts.permissionMode !== 'default') {
      args.push('--permission-mode', opts.permissionMode)
    }
    if (opts.autoShip !== false) args.push('--append-system-prompt', AUTO_SHIP_ORDERS)
    // the prompt goes last: everything after it would be read as more prompt
    if (opts.initialPrompt) args.push(opts.initialPrompt)

    // The clone must start from a pristine environment. Kamino itself may
    // have been launched from inside a Claude Code session or a
    // colour-suppressed agent shell, and inherited markers break the child:
    // CLAUDE_CODE_CHILD_SESSION alone disables transcript saving AND the
    // ~/.claude/sessions registry entry — which is how a terminal binds to
    // its card, so the clone stays "growing…" forever with an empty HUD.
    const env = { ...process.env } as Record<string, string>
    for (const k of Object.keys(env)) {
      if (/^CLAUDE/i.test(k)) delete env[k]
    }
    delete env.NO_COLOR
    if (!env.TERM || env.TERM === 'dumb') env.TERM = 'xterm-256color'
    if (!env.COLORTERM) env.COLORTERM = 'truecolor'

    const proc = pty.spawn(resolveClaudeExe(), args, {
      name: 'xterm-256color',
      cwd: opts.cwd,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 32,
      env
    })

    const ptyId = `pty-${this.nextId++}`
    const held: Held = {
      proc,
      info: { ptyId, pid: proc.pid, cwd: opts.cwd },
      backlog: [],
      backlogBytes: 0
    }
    this.held.set(ptyId, held)

    proc.onData((data) => {
      held.backlog.push(data)
      held.backlogBytes += data.length
      while (held.backlogBytes > BACKLOG_LIMIT && held.backlog.length > 1) {
        held.backlogBytes -= held.backlog.shift()!.length
      }
      this.emit('data', ptyId, data)
    })
    proc.onExit(({ exitCode }) => {
      this.emit('exit', ptyId, exitCode)
      this.held.delete(ptyId)
    })

    return held.info
  }

  write(ptyId: string, data: string): void {
    this.held.get(ptyId)?.proc.write(data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.held.get(ptyId)?.proc.resize(cols, rows)
  }

  kill(ptyId: string): void {
    this.held.get(ptyId)?.proc.kill()
  }

  backlog(ptyId: string): string {
    return this.held.get(ptyId)?.backlog.join('') ?? ''
  }

  list(): PtyInfo[] {
    return [...this.held.values()].map((h) => h.info)
  }

  pids(): Set<number> {
    return new Set([...this.held.values()].map((h) => h.info.pid))
  }

  ptyIdForPid(pid: number): string | null {
    for (const h of this.held.values()) if (h.info.pid === pid) return h.info.ptyId
    return null
  }

  disposeAll(): void {
    for (const h of this.held.values()) h.proc.kill()
    this.held.clear()
  }
}
