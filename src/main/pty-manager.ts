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
  cols?: number
  rows?: number
}

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
    if (opts.initialPrompt) args.push(opts.initialPrompt)

    // Kamino itself may have been launched from a colour-suppressed shell
    // (NO_COLOR=1, TERM=dumb — agent harnesses do this). The clone's terminal
    // is a real xterm, so never let that leak into the child.
    const env = { ...process.env } as Record<string, string>
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
