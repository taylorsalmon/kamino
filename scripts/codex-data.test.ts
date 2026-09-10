/**
 * Tests for the Codex rollout parser.
 *
 * Every fixture line here is the shape codex-cli 0.153.4 actually wrote on
 * 2026-09-10 (payload text trimmed). The parser is the only thing that knows
 * these shapes, so when a Codex update moves one, this is where it shows.
 *
 * Run with: npm test
 */
import {
  codexAssistantTexts,
  codexCommand,
  codexPatchFiles,
  describeCodexTool,
  metaFromRecord,
  parseRollout,
  prLinksIn,
  rolloutSessionId,
  toEvents,
  type CodexEvent
} from '../src/main/codex-data'
import { APPROVAL_RE, samePath } from '../src/main/codex-tracker'

let failed = 0
let checks = 0

function check(label: string, actual: unknown, expected: unknown): void {
  checks++
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  failed++
  console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`)
}

function events(line: string): CodexEvent[] {
  const rec = parseRollout(line)
  return rec ? toEvents(rec) : []
}

function kinds(line: string): string[] {
  return events(line).map((e) => e.kind)
}

const T = '2026-09-10T01:24:25.742Z'
const AT = Date.parse(T)

// ── filenames ───────────────────────────────────────────────────────────────
check(
  'session id comes off the filename',
  rolloutSessionId('C:\\Users\\x\\.codex\\sessions\\2026\\09\\10\\rollout-2026-09-10T11-24-21-01a088ea-72da-7c31-8d09-8a667a6e3619.jsonl'),
  '01a088ea-72da-7c31-8d09-8a667a6e3619'
)
check('other files are not rollouts', rolloutSessionId('C:\\x\\notes.jsonl'), null)

// ── session_meta ────────────────────────────────────────────────────────────
const META = JSON.stringify({
  timestamp: T,
  ordinal: 0,
  type: 'session_meta',
  payload: {
    session_id: '01a088ea-72da-7c31-8d09-8a667a6e3619',
    id: '01a088ea-72da-7c31-8d09-8a667a6e3619',
    timestamp: '2026-09-10T01:24:21.339Z',
    cwd: 'C:\\WINDOWS\\system32',
    originator: 'codex-tui',
    cli_version: '0.154.0',
    source: 'cli',
    model_provider: 'openai',
    base_instructions: { text: 'You are Codex…' }
  }
})
{
  const meta = metaFromRecord(parseRollout(META)!)
  check('meta: session id', meta?.sessionId, '01a088ea-72da-7c31-8d09-8a667a6e3619')
  check('meta: cwd', meta?.cwd, 'C:\\WINDOWS\\system32')
  check('meta: version', meta?.cliVersion, '0.154.0')
  check('meta: originator', meta?.originator, 'codex-tui')
  check('meta: started at the payload stamp', meta?.startedAt, Date.parse('2026-09-10T01:24:21.339Z'))
  check('meta: as an event', kinds(META), ['meta'])
}

// ── turn edges ──────────────────────────────────────────────────────────────
check(
  'task_started → turn-start with the window',
  events(
    JSON.stringify({
      timestamp: T,
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'x', started_at: 1789003465, model_context_window: 258400, collaboration_mode_kind: 'default' }
    })
  ),
  [{ kind: 'turn-start', window: 258400, at: AT }]
)
check(
  'task_complete → turn-end with the last message',
  events(
    JSON.stringify({
      timestamp: T,
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'x', last_agent_message: 'Hello! What can I help you with today?', started_at: 1, completed_at: 2, duration_ms: 2241 }
    })
  ),
  [{ kind: 'turn-end', lastMessage: 'Hello! What can I help you with today?', at: AT }]
)
check('turn_aborted → turn-end', kinds(JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } })), ['turn-end'])

// ── the user's message ──────────────────────────────────────────────────────
check(
  'item_completed UserMessage → user',
  events(
    JSON.stringify({
      timestamp: T,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 't',
        turn_id: 'x',
        item: { type: 'UserMessage', id: 'u', client_id: 'c', content: [{ type: 'text', text: 'hello there!', text_elements: [] }] },
        started_at_ms: 1,
        completed_at_ms: 2
      }
    })
  ),
  [{ kind: 'user', text: 'hello there!', at: AT }]
)
check(
  'legacy user_message → user',
  events(JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'user_message', message: 'hi' } })),
  [{ kind: 'user', text: 'hi', at: AT }]
)
check(
  'a developer message is not the assistant',
  kinds(JSON.stringify({ timestamp: T, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<app-context>…' }] } })),
  []
)
check(
  'an assistant message → reply',
  events(JSON.stringify({ timestamp: T, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done — see PR.' }] } })),
  [{ kind: 'reply', text: 'Done — see PR.', at: AT }]
)

// ── tools ───────────────────────────────────────────────────────────────────
const FN_CALL = JSON.stringify({
  timestamp: T,
  type: 'response_item',
  payload: { type: 'function_call', id: 'fc_1', name: 'wait', arguments: '{"cell_id":"1","max_tokens":4000,"yield_time_ms":1000}', call_id: 'call_m7' }
})
check('function_call → tool with parsed arguments', events(FN_CALL), [
  { kind: 'tool', name: 'wait', input: { cell_id: '1', max_tokens: 4000, yield_time_ms: 1000 }, callId: 'call_m7', at: AT }
])
const CUSTOM_CALL = JSON.stringify({
  timestamp: T,
  type: 'response_item',
  payload: {
    type: 'custom_tool_call',
    id: 'ctc_1',
    status: 'completed',
    call_id: 'call_Uk',
    name: 'exec',
    input: 'text(await tools.exec_command({cmd:"Get-Content -LiteralPath \'C:/x/SKILL.md\'","max_output_tokens":4000}));\n'
  }
})
{
  const [ev] = events(CUSTOM_CALL)
  check('custom_tool_call → tool', ev?.kind, 'tool')
  if (ev?.kind === 'tool') {
    check('exec cell surfaces the wrapped command', codexCommand(ev.name, ev.input), "Get-Content -LiteralPath 'C:/x/SKILL.md'")
    check('…and describes it as running', describeCodexTool(ev.name, ev.input), "Running: Get-Content -LiteralPath 'C:/x/SKILL.md'")
  }
}
check(
  'function_call_output → tool-result',
  events(JSON.stringify({ timestamp: T, type: 'response_item', payload: { type: 'function_call_output', id: 'fco', call_id: 'call_m7', output: 'Wall time 1.0 seconds' } })),
  [{ kind: 'tool-result', callId: 'call_m7', text: 'Wall time 1.0 seconds', at: AT }]
)
check('reasoning is silent', kinds(JSON.stringify({ timestamp: T, type: 'response_item', payload: { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'x' } })), [])
check('shell with an argv', describeCodexTool('shell', { command: ['git', 'status', '--short'] }), 'Running: git status --short')
check('exec_command with cmd', describeCodexTool('exec_command', { cmd: 'npm test' }), 'Running: npm test')
{
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: docs/b.md\n+hi\n*** End Patch'
  check('apply_patch files', codexPatchFiles('apply_patch', { input: patch }), ['src/a.ts', 'docs/b.md'])
  check('apply_patch describes the files', describeCodexTool('apply_patch', { input: patch }), 'Editing src/a.ts, docs/b.md')
}
check('an mcp tool reads as using it', describeCodexTool('mcp__github__create_pr', {}), 'Using create pr')

// ── tokens ──────────────────────────────────────────────────────────────────
check(
  'token_count → tokens minus reasoning, with the exact window',
  events(
    JSON.stringify({
      timestamp: T,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 99, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 100 },
          last_token_usage: { input_tokens: 25163, cached_input_tokens: 14208, cache_write_input_tokens: 0, output_tokens: 439, reasoning_output_tokens: 300, total_tokens: 25602 },
          model_context_window: 258400
        },
        rate_limits: {}
      }
    })
  ),
  [{ kind: 'tokens', tokens: 25302, window: 258400, at: AT }]
)
check('token_usage_record is not double-counted', kinds(JSON.stringify({ timestamp: T, type: 'token_usage_record', payload: { usage: { total_tokens: 5 } } })), [])

// ── settings, compaction, approvals ─────────────────────────────────────────
check(
  'turn_context → settings',
  events(
    JSON.stringify({
      timestamp: T,
      type: 'turn_context',
      payload: { turn_id: 'x', cwd: 'C:\\x', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write', network_access: false } }
    })
  ),
  [{ kind: 'settings', model: undefined, approval: 'on-request', sandbox: 'workspace-write', at: AT }]
)
check(
  'a granular approval policy is named as such',
  events(JSON.stringify({ timestamp: T, type: 'turn_context', payload: { approval_policy: { granular: { rules: false } }, sandbox_policy: { type: 'read-only' } } })),
  [{ kind: 'settings', model: undefined, approval: 'granular', sandbox: 'read-only', at: AT }]
)
check(
  'thread_settings_applied carries the model',
  events(JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra', approval_policy: 'never' } } })),
  [{ kind: 'settings', model: 'gpt-6-astra', approval: 'never', at: AT }]
)
check('compacted → compacted', kinds(JSON.stringify({ timestamp: T, type: 'compacted', payload: { message: 'summary' } })), ['compacted'])
check(
  'exec_approval_request → approval with the command',
  events(JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'exec_approval_request', call_id: 'c', command: ['rm', '-rf', 'dist'], cwd: 'C:\\x' } })),
  [{ kind: 'approval', text: 'Approve command: rm -rf dist', at: AT }]
)
check(
  'apply_patch_approval_request → approval with the files',
  events(JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'apply_patch_approval_request', call_id: 'c', changes: { 'C:\\repo\\src\\a.ts': {}, 'C:\\repo\\b.md': {} } } })),
  [{ kind: 'approval', text: 'Approve edits to src/a.ts, repo/b.md', at: AT }]
)
check('unknown record types are ignored', kinds(JSON.stringify({ timestamp: T, type: 'world_state', payload: { full: true } })), [])
check('torn lines are ignored', parseRollout('{"timestamp":"2026-09-10T01:24:25.742Z","type":"event_msg","pay'), null)

// ── PR links + marker extraction ────────────────────────────────────────────
check(
  'PR links are pulled from prose',
  prLinksIn('Opened https://github.com/taylorsalmon/kamino/pull/21 and https://github.com/taylorsalmon/kamino/pull/21 again'),
  [{ number: 21, url: 'https://github.com/taylorsalmon/kamino/pull/21', repository: 'taylorsalmon/kamino' }]
)
{
  const chunk = [
    JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'please write ===KAMINO-HANDOFF-START=== for me' }] } } }),
    JSON.stringify({ timestamp: T, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '===KAMINO-HANDOFF-START===\nGOAL: x\n===KAMINO-HANDOFF-END===' }] } })
  ].join('\n')
  check('only the assistant speaks in the marker watch', codexAssistantTexts(chunk), ['===KAMINO-HANDOFF-START===\nGOAL: x\n===KAMINO-HANDOFF-END==='])
}

// ── the tracker's binding + approval heuristic ──────────────────────────────
check('paths match across slashes and case', samePath('C:/Users/T/repo/', 'c:\\users\\t\\REPO'), true)
check('different folders do not', samePath('C:\\repo', 'C:\\repo2'), false)
for (const line of [
  'Allow Codex to run `npm test` in C:\\repo?',
  'Allow Codex to apply proposed code changes?',
  '  ▶ Allow this request and continue',
  'Allow for this session'
]) {
  check(`approval wording: ${line.trim().slice(0, 30)}`, APPROVAL_RE.test(line), true)
}
check('ordinary output is not an approval', APPROVAL_RE.test('Running tests… allow me to explain'), false)

console.log(`${checks - failed}/${checks} checks passed`)
if (failed) process.exit(1)
