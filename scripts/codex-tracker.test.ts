/**
 * End-to-end test for the Codex tracker against a real rollout file on disk.
 *
 * The tracker's whole job is a binding nothing else can check: a PTY Kamino
 * spawned has to be matched to the rollout that appears afterwards, and the
 * rollout's records folded into an Instance. So this writes a rollout the way
 * codex-cli 0.153.4 does, into a throwaway CODEX_HOME, registers an
 * expectation for its folder, and reads the card back.
 *
 * Run with: npm test
 */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Instance } from '../src/shared/types'

let failed = 0
let checks = 0

function check(label: string, actual: unknown, expected: unknown): void {
  checks++
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  failed++
  console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// a stand-in for InstanceStore with just the adapter surface the tracker uses
class FakeStore {
  instances = new Map<string, Instance>()
  dead: string[] = []
  tools: Array<{ name: string; input?: Record<string, unknown> }> = []
  adopt(inst: Instance): void {
    this.instances.set(inst.sessionId, inst)
  }
  mutate(id: string, fn: (i: Instance) => void): void {
    const i = this.instances.get(id)
    if (i && i.state !== 'dead') fn(i)
  }
  get(id: string): Instance | null {
    return this.instances.get(id) ?? null
  }
  markDead(id: string): void {
    const i = this.instances.get(id)
    if (i) i.state = 'dead'
    this.dead.push(id)
  }
  noteToolUse(_i: Instance, name: string, input?: Record<string, unknown>): void {
    this.tools.push({ name, input })
  }
}

class FakePtys extends EventEmitter {}

async function main(): Promise<void> {
  // the long-form temp path: libuv's directory watcher aborts outright on a
  // Windows 8.3 short name (TAYLOR~1), which is what os.tmpdir() can return
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'kamino-codex-'))
  const repo = path.join(home, 'repo')
  fs.mkdirSync(repo)
  process.env['CODEX_HOME'] = home
  // the module reads CODEX_HOME when it loads, so it must load after the env is set
  const { CodexTracker } = await import('../src/main/codex-tracker')

  const store = new FakeStore()
  const ptys = new FakePtys()
  const tracker = new CodexTracker(store as never, ptys as never)
  const asks: string[] = []
  const stops: string[] = []
  tracker.on('ask', (id: string, text: string) => asks.push(text))
  tracker.on('stop', (id: string) => stops.push(id))
  tracker.start()

  const startedAt = Date.now()
  tracker.expect({ ptyId: 'pty-1', pid: 4242, cwd: repo, startedAt, permissionMode: 'read-only' })

  // the rollout appears a moment later, as it does when the TUI starts
  const sid = '01a088ea-72da-7c31-8d09-8a667a6e3619'
  const day = path.join(home, 'sessions', '2026', '09', '10')
  fs.mkdirSync(day, { recursive: true })
  const file = path.join(day, `rollout-2026-09-10T11-24-21-${sid}.jsonl`)
  const t = (ms: number): string => new Date(startedAt + ms).toISOString()
  const line = (o: unknown): string => JSON.stringify(o) + '\n'
  fs.writeFileSync(
    file,
    line({
      timestamp: t(400),
      type: 'session_meta',
      payload: { session_id: sid, id: sid, timestamp: t(300), cwd: repo.toUpperCase(), originator: 'codex-tui', cli_version: '0.154.0', source: 'cli' }
    }) +
      line({ timestamp: t(400), type: 'event_msg', payload: { type: 'task_started', turn_id: 'x', model_context_window: 258400 } }) +
      line({ timestamp: t(401), type: 'turn_context', payload: { cwd: repo, approval_policy: 'on-request', sandbox_policy: { type: 'read-only' } } }) +
      line({
        timestamp: t(402),
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'hello there!' }] } }
      })
  )

  // binding is by poll (1.5s) or watcher, whichever is first
  let inst: Instance | null = null
  for (let i = 0; i < 40 && !inst; i++) {
    await sleep(250)
    inst = store.get(sid)
  }
  check('binds to the rollout in its folder', inst?.sessionId, sid)
  check('…as an embedded Codex clone', [inst?.cli, inst?.cliKind, inst?.kind], ['codex', 'codex', 'embedded'])
  check('…carrying the pty pid', inst?.pid, 4242)
  check('…and the cli version', inst?.version, '0.154.0')
  check('the opening prompt is the title until the retitler speaks', inst?.now.title, 'hello there!')
  check('a fresh session is live from line one', inst?.state, 'busy')
  check('turn counted', inst?.recent.turns, 1)
  check('settings from turn_context', inst?.permissionMode, 'on-request · read-only')
  check('transcript file is known', tracker.transcriptFile(sid), file)

  // the clone runs a command, then Codex asks whether to allow it
  fs.appendFileSync(
    file,
    line({
      timestamp: t(900),
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['git', 'add', '-A'] }), call_id: 'c1' }
    })
  )
  await sleep(1200)
  check('activity names the command', store.get(sid)?.now.activity, 'Running: git add -A')
  check('airspace control hears it as Bash', store.tools[0], { name: 'Bash', input: { command: 'git add -A' } })

  ptys.emit('data', 'pty-1', '\x1b[1m▶ Allow Codex to run git add -A in repo?\x1b[0m\n  Allow this request and continue\n')
  await sleep(50)
  check('the approval wording flips the pane to needs-you', store.get(sid)?.state, 'needs-you')
  check('…naming the command', store.get(sid)?.now.pendingAsk, 'Approve command: git add -A')
  check('…and toasts', asks, ['Approve command: git add -A'])

  // approved: the output lands, the turn finishes on a question
  fs.appendFileSync(
    file,
    line({ timestamp: t(1500), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } }) +
      line({
        timestamp: t(1600),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 16506, output_tokens: 14, reasoning_output_tokens: 0, total_tokens: 16520 }, model_context_window: 258400 }
        }
      }) +
      line({ timestamp: t(1700), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'x', last_agent_message: 'Staged. Shall I commit — see https://github.com/o/r/pull/7 ?' } })
  )
  await sleep(1200)
  const done = store.get(sid)!
  check('the output clears the ask', done.now.pendingAsk?.startsWith('Approve'), false)
  check('rot is measured against the exact window', [done.context?.tokens, done.context?.window], [16520, 258400])
  check('a reply ending in a question awaits orders', [done.state, done.now.askKind], ['needs-you', 'reply'])
  check('PR links are picked out of the reply', done.recent.prs.map((p) => p.number), [7])
  check('turn-end is reported for the mission-complete toast', stops, [sid])

  // the terminal closes: the clone is dead, and nothing else reports that
  ptys.emit('exit', 'pty-1', 0)
  check('pty exit kills the clone', store.dead, [sid])

  tracker.stop()
  fs.rmSync(home, { recursive: true, force: true })
  console.log(`${checks - failed}/${checks} checks passed`)
  process.exit(failed ? 1 : 0)
}

void main()
