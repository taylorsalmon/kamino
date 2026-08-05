/**
 * HookServer — receives fire-and-forget POSTs from Claude Code hooks
 * (Notification / Stop / UserPromptSubmit) installed in ~/.claude/settings.json.
 * This is the only reliable "Claude is waiting on YOU" signal for instances we
 * don't own the PTY of — and it covers embedded ones too, since hooks are global.
 */
import { EventEmitter } from 'node:events'
import * as http from 'node:http'

export const HOOK_PORT = 47831

export interface HookEvent {
  kind: 'notification' | 'stop' | 'prompt'
  sessionId: string
  cwd?: string
  /** Notification only — what Claude is asking for */
  message?: string
}

/** What a PreToolUse hook is about to do, for the decider to rule on. */
export interface PreToolRequest {
  sessionId: string
  cwd: string
  toolName: string
  input?: Record<string, unknown>
}

/** null = stay out of the way (normal permission flow continues) */
export type PreToolDecider = (req: PreToolRequest) => { deny: true; reason: string } | null

const KINDS = ['notification', 'stop', 'prompt']

export class HookServer extends EventEmitter {
  private server: http.Server | null = null
  private decider: PreToolDecider | null = null

  /**
   * Register the PreToolUse ruling. Never returns permissionDecision 'allow'
   * for the pass case — that would auto-approve commands the user's permission
   * mode would otherwise have prompted about. Silence means "carry on".
   */
  setPreToolDecider(decider: PreToolDecider | null): void {
    this.decider = decider
  }

  start(): void {
    this.server = http.createServer((req, res) => {
      const endpoint = req.url?.replace('/hook/', '')
      const isPreTool = endpoint === 'pretool'
      if (req.method !== 'POST' || !endpoint || !(isPreTool || KINDS.includes(endpoint))) {
        res.writeHead(404).end()
        return
      }
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 256_000) req.destroy() // hook payloads are small
      })
      req.on('end', () => {
        if (isPreTool) {
          this.answerPreTool(body, res)
          return
        }
        res.writeHead(200).end('ok')
        try {
          const d = JSON.parse(body || '{}')
          const sessionId = d.session_id ?? d.sessionId
          if (typeof sessionId === 'string') {
            this.emit('hook', {
              kind: endpoint as HookEvent['kind'],
              sessionId,
              cwd: typeof d.cwd === 'string' ? d.cwd : undefined,
              message: typeof d.message === 'string' ? d.message : undefined
            } satisfies HookEvent)
          }
        } catch {
          /* malformed — ignore */
        }
      })
    })
    this.server.on('error', (err) => {
      // most likely a second Fleet instance already listening — degrade quietly
      console.warn('[hook-server]', err.message)
    })
    this.server.listen(HOOK_PORT, '127.0.0.1')
  }

  /**
   * Answer a PreToolUse POST. This runs in front of every matched tool call on
   * the machine, so it must be fast and must fail open: any error, any missing
   * decider, anything unparseable → an empty decision, and the tool proceeds.
   */
  private answerPreTool(body: string, res: http.ServerResponse): void {
    let verdict: { deny: true; reason: string } | null = null
    try {
      const d = JSON.parse(body || '{}')
      const sessionId = d.session_id ?? d.sessionId
      if (this.decider && typeof sessionId === 'string' && typeof d.tool_name === 'string') {
        verdict = this.decider({
          sessionId,
          cwd: typeof d.cwd === 'string' ? d.cwd : '',
          toolName: d.tool_name,
          input: d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : undefined
        })
      }
    } catch {
      verdict = null // malformed payload is never grounds to block work
    }
    const payload = verdict
      ? {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: verdict.reason
          }
        }
      : {}
    const json = JSON.stringify(payload)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
    res.end(json)
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }
}
