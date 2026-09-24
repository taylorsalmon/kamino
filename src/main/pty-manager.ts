/**
 * PtyManager — spawns and owns embedded clones, whichever CLI they run.
 *
 * The executable is resolved through the CliRegistry and spawned directly (no
 * shell wrapper). For Claude Code that matters: the PTY child pid IS the pid it
 * writes to ~/.claude/sessions/<pid>.json, which is how an embedded terminal is
 * matched to its Instance card. Codex has no such registry — its terminals are
 * bound by the CodexTracker from the rollout that appears after launch.
 */
import { EventEmitter } from 'node:events'
import * as pty from '@lydell/node-pty'
import { AUTO_SHIP_ORDERS, buildArgs, CLAUDE_CLI, composeOrders, resolveCommand, type CliRegistry } from './cli-registry'
import type { CliDefinition } from '../shared/types'

export { AUTO_SHIP_ORDERS }

export interface SpawnOptions {
  cwd: string
  /** CliDefinition id; omitted = Claude Code */
  cli?: string
  resumeSessionId?: string
  initialPrompt?: string
  permissionMode?: string
  model?: string
  /** standing orders: ship finished work without being asked. Defaults on —
   *  pass false to commission a clone that leaves shipping to you. */
  autoShip?: boolean
  /** standing orders: track the work as a Linear issue, assigned to the user,
   *  created the moment the clone first changes a file. Off unless asked. */
  linear?: boolean
  /** an existing issue (LKG-42 or URL) the clone should pick up instead */
  linearIssue?: string
  /**
   * Extra standing orders for this clone, appended to its system prompt. Used
   * for roles rather than tasks (the arbiter), which must survive the whole
   * session rather than scroll out of the window like a first prompt would.
   * Joined with the other orders — the CLI takes one such flag.
   */
  appendSystemPrompt?: string
  /**
   * Give this clone its own git worktree, optionally named. One working tree
   * each is what makes several clones on one repo genuinely parallel: a folder
   * has a single checked-out branch, so clones sharing one commit onto the same
   * branch and land in the same PR no matter how well they behave. Claude makes
   * its own (--worktree); for other CLIs the caller has already made one and
   * passes it as cwd.
   */
  worktree?: boolean
  worktreeName?: string
  cols?: number
  rows?: number
}

export interface PtyInfo {
  ptyId: string
  pid: number
  cwd: string
  cli: string
}

interface Held {
  proc: pty.IPty
  info: PtyInfo
  /** ring buffer of recent output so a re-mounted view can restore scrollback */
  backlog: string[]
  backlogBytes: number
}

const BACKLOG_LIMIT = 400_000

export class PtyManager extends EventEmitter {
  private held = new Map<string, Held>()
  private nextId = 1

  constructor(private readonly clis: CliRegistry) {
    super()
  }

  /** The definition a launch will use — Claude Code unless told otherwise. */
  definition(id: string | undefined): CliDefinition {
    return this.clis.get(id ?? 'claude') ?? CLAUDE_CLI
  }

  spawn(opts: SpawnOptions): PtyInfo {
    const def = this.definition(opts.cli)
    const resolved = resolveCommand(def)
    if (!resolved) {
      throw new Error(
        `${def.label} is not installed here — "${def.command}" was not found on PATH. Fix the command under Manage CLIs, or install it.`
      )
    }
    const orders = composeOrders({
      autoShip: opts.autoShip,
      linear: opts.linear,
      linearIssue: opts.linearIssue,
      extra: opts.appendSystemPrompt
    })
    const args = [
      ...resolved.prefixArgs,
      ...buildArgs(def, {
        cwd: opts.cwd,
        resumeSessionId: opts.resumeSessionId,
        initialPrompt: opts.initialPrompt,
        permissionMode: opts.permissionMode,
        model: opts.model,
        standingOrders: def.supports.standingOrders ? orders : undefined,
        worktree: def.supports.nativeWorktree ? opts.worktree : false,
        worktreeName: opts.worktreeName
      })
    ]

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

    const proc = pty.spawn(resolved.file, args, {
      name: 'xterm-256color',
      cwd: opts.cwd,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 32,
      env
    })

    const ptyId = `pty-${this.nextId++}`
    const held: Held = {
      proc,
      info: { ptyId, pid: proc.pid, cwd: opts.cwd, cli: def.id },
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

  /** which CLI a PTY runs, for callers that only hold the id */
  cliOf(ptyId: string): string | null {
    return this.held.get(ptyId)?.info.cli ?? null
  }

  disposeAll(): void {
    for (const h of this.held.values()) h.proc.kill()
    this.held.clear()
  }
}
