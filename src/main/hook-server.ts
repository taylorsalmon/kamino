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

export class HookServer extends EventEmitter {
  private server: http.Server | null = null

  start(): void {
    this.server = http.createServer((req, res) => {
      const kind = req.url?.replace('/hook/', '') as HookEvent['kind'] | undefined
      if (req.method !== 'POST' || !kind || !['notification', 'stop', 'prompt'].includes(kind)) {
        res.writeHead(404).end()
        return
      }
      let body = ''
      req.on('data', (c) => {
        body += c
        if (body.length > 256_000) req.destroy() // hook payloads are small
      })
      req.on('end', () => {
        res.writeHead(200).end('ok')
        try {
          const d = JSON.parse(body || '{}')
          const sessionId = d.session_id ?? d.sessionId
          if (typeof sessionId === 'string') {
            this.emit('hook', {
              kind,
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

  stop(): void {
    this.server?.close()
    this.server = null
  }
}
