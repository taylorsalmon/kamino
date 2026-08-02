/**
 * Installs the Claude Code hooks that report to Fleet's HookServer.
 * Idempotent: recognizes its own entries by the port URL and leaves any other
 * hooks the user has configured untouched.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CLAUDE_DIR } from './claude-data'
import { HOOK_PORT } from './hook-server'

const MARKER = `127.0.0.1:${HOOK_PORT}/hook/`

function command(endpoint: string): string {
  // curl.exe ships with Windows 10+. -m 2 caps a hang if Fleet is closed;
  // a closed port fails instantly (connection refused) so hooks stay cheap.
  return `curl.exe -m 2 -s -o NUL -X POST -H "Content-Type: application/json" --data-binary @- http://${MARKER}${endpoint}`
}

const EVENTS: Record<string, string> = {
  Notification: 'notification',
  Stop: 'stop',
  UserPromptSubmit: 'prompt'
}

export function installHooks(): { installed: string[]; settingsPath: string } {
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json')
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
  } catch {
    /* missing/corrupt — start fresh but do not clobber a corrupt file */
    if (fs.existsSync(settingsPath)) throw new Error(`Could not parse ${settingsPath}; not touching it.`)
  }

  const hooks = (settings.hooks ?? {}) as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  const installed: string[] = []

  for (const [event, endpoint] of Object.entries(EVENTS)) {
    const entries = hooks[event] ?? []
    const already = entries.some((e) => e.hooks?.some((h) => h.command?.includes(MARKER)))
    if (!already) {
      entries.push({ hooks: [{ type: 'command', command: command(endpoint), timeout: 5 } as never] })
      hooks[event] = entries
      installed.push(event)
    }
  }

  if (installed.length > 0) {
    settings.hooks = hooks
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
  }
  return { installed, settingsPath }
}

export function hooksInstalled(): boolean {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf-8'))
    return JSON.stringify(settings.hooks ?? {}).includes(MARKER)
  } catch {
    return false
  }
}
