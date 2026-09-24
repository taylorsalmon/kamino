/**
 * Tests for Linear tracking.
 *
 * Two halves. composeOrders is where every standing order that applies to a
 * clone becomes the ONE system-prompt string a CLI accepts — a regression here
 * silently drops the ship orders or the arbiter's rules. issueLinksIn is how
 * the board learns which issue a clone is tracking, read out of the clone's
 * own save_issue result; the shapes here are what the Linear MCP returns.
 *
 * Run with: npm test
 */
import { AUTO_SHIP_ORDERS, LINEAR_ORDERS, composeOrders, linearOrdersFor } from '../src/main/cli-registry'
import { isLinearSaveTool, issueLinksIn } from '../src/main/claude-data'

let failed = 0
let checks = 0

function check(label: string, actual: unknown, expected: unknown): void {
  checks++
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  failed++
  console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`)
}

// ── composeOrders: one flag, every order that applies ───────────────────────
check('default: ship orders only', composeOrders({}), AUTO_SHIP_ORDERS)
check('ship off, nothing else: no flag at all', composeOrders({ autoShip: false }), undefined)
check('ship + linear: both, ship first', composeOrders({ linear: true }), `${AUTO_SHIP_ORDERS} ${LINEAR_ORDERS}`)
check('linear alone', composeOrders({ autoShip: false, linear: true }), LINEAR_ORDERS)
check(
  'linear with a named issue',
  composeOrders({ autoShip: false, linear: true, linearIssue: ' LKG-42 ' }),
  `${LINEAR_ORDERS} The user has asked you to work under Linear issue LKG-42.`
)
check('named issue ignored when linear is off', composeOrders({ autoShip: false, linearIssue: 'LKG-42' }), undefined)
check(
  'arbiter: its own orders, no ship, no linear',
  composeOrders({ autoShip: false, extra: 'ARBITER' }),
  'ARBITER'
)
check('everything at once keeps the extra last', composeOrders({ linear: true, extra: 'X' }), `${AUTO_SHIP_ORDERS} ${LINEAR_ORDERS} X`)
check('blank issue is no issue', linearOrdersFor('   '), LINEAR_ORDERS)
// Windows command-line safety: the orders are quoted onto argv as one string
check('orders carry no double quotes', LINEAR_ORDERS.includes('"'), false)
check('orders carry no percent signs', LINEAR_ORDERS.includes('%'), false)

// ── isLinearSaveTool ────────────────────────────────────────────────────────
check('claude.ai connector name', isLinearSaveTool('mcp__claude_ai_Linear__save_issue'), true)
check('a self-hosted linear server', isLinearSaveTool('mcp__linear__save_issue'), true)
check('reading is not saving', isLinearSaveTool('mcp__claude_ai_Linear__get_issue'), false)
check('another server with issues', isLinearSaveTool('mcp__github__save_issue'), false)

// ── issueLinksIn: the save_issue result ─────────────────────────────────────
const created =
  '{"id":"a1b2","identifier":"LKG-42","title":"Track clones in Linear","url":"https://linear.app/lkg/issue/LKG-42/track-clones-in-linear","state":{"name":"In Progress"}}'
check('created issue', issueLinksIn(created), [
  { key: 'LKG-42', url: 'https://linear.app/lkg/issue/LKG-42/track-clones-in-linear', title: 'Track clones in Linear' }
])
check('bare url, no slug', issueLinksIn('see https://linear.app/lkg/issue/LKG-7'), [
  { key: 'LKG-7', url: 'https://linear.app/lkg/issue/LKG-7' }
])
check('trailing punctuation dropped', issueLinksIn('(https://linear.app/lkg/issue/LKG-7).'), [
  { key: 'LKG-7', url: 'https://linear.app/lkg/issue/LKG-7' }
])
check(
  'escaped quotes in the title survive',
  issueLinksIn('{"title":"Fix the \\"rot\\" bar","url":"https://linear.app/lkg/issue/LKG-9/x"}')[0].title,
  'Fix the "rot" bar'
)
check(
  'two issues: no title guessing, no duplicates',
  issueLinksIn(
    'https://linear.app/lkg/issue/LKG-1/a "title":"A" https://linear.app/lkg/issue/LKG-2/b https://linear.app/lkg/issue/LKG-1/a'
  ),
  [
    { key: 'LKG-1', url: 'https://linear.app/lkg/issue/LKG-1/a' },
    { key: 'LKG-2', url: 'https://linear.app/lkg/issue/LKG-2/b' }
  ]
)
check('a PR link is not an issue', issueLinksIn('https://github.com/x/y/pull/3'), [])

console.log(`${checks - failed}/${checks} linear checks passed`)
if (failed) process.exit(1)
