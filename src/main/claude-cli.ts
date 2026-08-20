/**
 * One-shot `claude -p` calls — the headless route Kamino uses for its own small
 * language jobs (the recap brief, the live pane titles). It runs on the user's
 * existing CLI auth, so there is nothing to configure and no key to hold.
 *
 * A default `claude -p` is a whole coding agent: it saves a resumable
 * transcript, loads every MCP server, every skill, the user's CLAUDE.md, and a
 * system prompt naming the cwd and its git branch. For a job that is one
 * question and one short answer, all of that is cost — and worse, it is bias:
 * asked to name a session, a child launched from Kamino's own folder will
 * happily answer with Kamino's current git branch. So these calls are stripped
 * back to the model and the question. Measured on the title job: ~$0.003 and
 * ~6s per call, against ~$0.02 and 15-30s for the default.
 *
 * The flags below are recent-ish; a CLI too old for one of them fails on the
 * spot rather than ignoring it, so a failed lean call is retried once with
 * nothing but -p and --model.
 */
import { spawn } from 'node:child_process'

export interface RunClaudeOptions {
  /** model alias passed to --model; small and fast by default */
  model?: string
  timeoutMs?: number
  /**
   * Replaces Claude Code's agent system prompt, which otherwise arrives with
   * the cwd, the git branch and the loaded memory files in it. Worth setting
   * for anything where that context could be mistaken for the subject.
   */
  systemPrompt?: string
}

/**
 * Trim what cmd.exe would take as syntax rather than text. The prompts here are
 * written in this repo, not by a user, so this is a guard rail against a future
 * edit rather than a sanitizer for hostile input.
 */
function shellSafe(s: string): string {
  return s.replace(/["%&^|<>()]/g, '').replace(/\s+/g, ' ').trim()
}

export function runClaude(input: string, opts: RunClaudeOptions = {}): Promise<string> {
  const model = opts.model ?? 'haiku'
  const timeoutMs = opts.timeoutMs ?? 90_000
  const lean = [
    '--no-session-persistence', // no resumable transcript left behind per call
    '--strict-mcp-config', // no MCP servers, so no MCP tool definitions
    '--disable-slash-commands', // no skills
    '--setting-sources ""' // no settings, no CLAUDE.md, no auto-memory
  ]
  if (opts.systemPrompt) lean.push(`--system-prompt "${shellSafe(opts.systemPrompt)}"`)

  const attempt = (args: string): Promise<string> =>
    new Promise((resolve, reject) => {
      // same pristine-env rule as PtyManager: inherited CLAUDE* markers (Kamino
      // itself may have been launched from inside a Claude session) can break
      // the child CLI outright
      const env = { ...process.env } as Record<string, string>
      for (const k of Object.keys(env)) {
        if (/^CLAUDE/i.test(k)) delete env[k]
      }
      // these jobs are one line of judgement, not research — thinking here buys
      // nothing and costs most of the call
      env.MAX_THINKING_TOKENS = '0'

      const child = spawn(`claude -p --model ${model} ${args}`, {
        shell: true, // resolves the claude shim on PATH
        windowsHide: true,
        env
      })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && out.trim()) resolve(out.trim())
        else reject(new Error(err.trim() || `claude -p exited ${code}`))
      })
      // EPIPE if the child dies before reading stdin — must not crash main
      child.stdin.on('error', () => {})
      child.stdin.write(input)
      child.stdin.end()
    })

  return attempt(lean.join(' ')).catch((e: Error) => {
    // only a CLI that does not know a flag earns a second call — retrying a
    // rate limit or a timeout would just spend it twice
    if (!/unknown (option|argument|command)|unrecognized/i.test(e.message)) throw e
    return attempt('')
  })
}
