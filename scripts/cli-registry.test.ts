/**
 * Tests for the CLI registry's argv builder.
 *
 * buildArgs is the one place a LaunchRequest becomes a command line, for every
 * CLI Kamino knows. The Claude shapes here are the ones PtyManager produced
 * before the registry existed — they must not move. The Codex shapes pin the
 * flag names of codex-cli 0.153.4 and the TOML quoting of the standing orders,
 * which is the part most likely to go quietly wrong.
 *
 * Run with: npm test
 */
import { AUTO_SHIP_ORDERS, buildArgs, CLAUDE_CLI, CODEX_CLI, tomlString } from '../src/main/cli-registry'
import type { CliDefinition } from '../src/shared/types'

let failed = 0
let checks = 0

function check(label: string, actual: unknown, expected: unknown): void {
  checks++
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  failed++
  console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`)
}

// ── Claude Code: unchanged from the pre-registry PtyManager ─────────────────
check('claude: bare launch', buildArgs(CLAUDE_CLI, {}), [])
check('claude: resume', buildArgs(CLAUDE_CLI, { resumeSessionId: 'abc' }), ['--resume', 'abc'])
check('claude: default mode adds nothing', buildArgs(CLAUDE_CLI, { permissionMode: 'default' }), [])
check(
  'claude: permission mode',
  buildArgs(CLAUDE_CLI, { permissionMode: 'bypassPermissions' }),
  ['--permission-mode', 'bypassPermissions']
)
check(
  'claude: an unlisted mode still passes through',
  buildArgs(CLAUDE_CLI, { permissionMode: 'dontAsk' }),
  ['--permission-mode', 'dontAsk']
)
check('claude: worktree unnamed', buildArgs(CLAUDE_CLI, { worktree: true }), ['--worktree'])
check(
  'claude: worktree named',
  buildArgs(CLAUDE_CLI, { worktree: true, worktreeName: ' fix-x ' }),
  ['--worktree', 'fix-x']
)
check(
  'claude: standing orders ride the system prompt',
  buildArgs(CLAUDE_CLI, { standingOrders: AUTO_SHIP_ORDERS }),
  ['--append-system-prompt', AUTO_SHIP_ORDERS]
)
check(
  'claude: prompt is last, after everything',
  buildArgs(CLAUDE_CLI, {
    resumeSessionId: 's1',
    permissionMode: 'plan',
    worktree: true,
    model: 'opus',
    standingOrders: 'orders',
    initialPrompt: 'do the thing --now'
  }),
  ['--resume', 's1', '--permission-mode', 'plan', '--worktree', '--model', 'opus', '--append-system-prompt', 'orders', 'do the thing --now']
)

// ── Codex ───────────────────────────────────────────────────────────────────
check('codex: bare launch', buildArgs(CODEX_CLI, {}), [])
check('codex: prompt is positional', buildArgs(CODEX_CLI, { initialPrompt: 'hello there' }), ['hello there'])
check(
  'codex: resume is a subcommand with the id before the prompt',
  buildArgs(CODEX_CLI, { resumeSessionId: 'uuid-1', initialPrompt: 'carry on' }),
  ['resume', 'uuid-1', 'carry on']
)
check('codex: default mode adds nothing', buildArgs(CODEX_CLI, { permissionMode: 'default' }), [])
check('codex: read-only sandbox', buildArgs(CODEX_CLI, { permissionMode: 'read-only' }), ['--sandbox', 'read-only'])
check(
  'codex: workspace-write asks on request',
  buildArgs(CODEX_CLI, { permissionMode: 'workspace-write' }),
  ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
)
check('codex: approve-for-me', buildArgs(CODEX_CLI, { permissionMode: 'approve-for-me' }), ['--approve-for-me'])
check('codex: yolo', buildArgs(CODEX_CLI, { permissionMode: 'yolo' }), ['--dangerously-bypass-approvals-and-sandbox'])
check('codex: an unknown mode is dropped, not guessed', buildArgs(CODEX_CLI, { permissionMode: 'plan' }), [])
check('codex: model', buildArgs(CODEX_CLI, { model: 'gpt-6-astra' }), ['--model', 'gpt-6-astra'])
check(
  'codex: standing orders go in as developer_instructions',
  buildArgs(CODEX_CLI, { standingOrders: 'ship it' }),
  ['-c', 'developer_instructions="ship it"']
)
check(
  'codex: options precede the resume id',
  buildArgs(CODEX_CLI, { resumeSessionId: 'u', permissionMode: 'read-only', model: 'm', standingOrders: 'o' }),
  ['resume', '--sandbox', 'read-only', '--model', 'm', '-c', 'developer_instructions="o"', 'u']
)
check('codex: worktree is not a flag it has', buildArgs(CODEX_CLI, { worktree: true, worktreeName: 'x' }), [])

// ── TOML basic strings — what -c key=value parses ───────────────────────────
check('toml: plain', tomlString('abc'), '"abc"')
check('toml: quotes and backslashes', tomlString('say "hi" \\ done'), '"say \\"hi\\" \\\\ done"')
check('toml: newline and tab', tomlString('a\nb\tc'), '"a\\nb\\tc"')
check('toml: carriage return', tomlString('a\r\nb'), '"a\\r\\nb"')
check('toml: control char', tomlString('a\u0001b'), '"a\\u0001b"')
check('toml: the real orders survive', tomlString(AUTO_SHIP_ORDERS), `"${AUTO_SHIP_ORDERS}"`)

// ── custom CLIs ─────────────────────────────────────────────────────────────
const GEMINI: CliDefinition = {
  id: 'custom-gemini',
  kind: 'custom',
  label: 'Gemini CLI',
  command: 'gemini',
  brand: { mark: 'letter', letter: 'GE', color: '#4285f4' },
  builtin: false,
  permissionModes: [{ value: 'yolo', label: 'yolo', args: ['--yolo'] }],
  supports: { resume: true, nativeWorktree: false, standingOrders: false, model: true },
  approveKeys: '\r',
  extraArgs: ['--cwd', '{cwd}'],
  promptStyle: 'flag',
  promptFlag: '-p',
  resumeArgs: ['--resume', '{id}']
}
check(
  'custom: placeholders, flags, prompt behind its flag',
  buildArgs(GEMINI, { cwd: 'C:\\repo', permissionMode: 'yolo', model: 'pro', initialPrompt: 'go' }),
  ['--cwd', 'C:\\repo', '--yolo', '--model', 'pro', '-p', 'go']
)
check(
  'custom: resume substitutes the id',
  buildArgs(GEMINI, { cwd: 'C:\\repo', resumeSessionId: 'r9' }),
  ['--cwd', 'C:\\repo', '--resume', 'r9']
)
check(
  'custom: a CLI that takes no prompt gets none',
  buildArgs({ ...GEMINI, promptStyle: 'none', extraArgs: [] }, { initialPrompt: 'ignored' }),
  []
)
check(
  'custom: positional prompt by default',
  buildArgs({ ...GEMINI, promptStyle: undefined, extraArgs: [] }, { initialPrompt: 'hi' }),
  ['hi']
)
check('custom: an unknown mode is dropped', buildArgs({ ...GEMINI, extraArgs: [] }, { permissionMode: 'plan' }), [])

console.log(`${checks - failed}/${checks} checks passed`)
if (failed) process.exit(1)
