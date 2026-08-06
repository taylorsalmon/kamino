/**
 * Tests for airspace control's git classifier and decision logic.
 *
 * This is the one piece of Kamino where being wrong is expensive in both
 * directions: a missed case lets a clone bury a sibling's work, and an
 * over-eager rule denies a legitimate command and costs a clone a turn arguing
 * with a wall. So the table below is the specification — add a row before
 * touching classifyGit.
 *
 * Run with: npm test
 */
import { classifyGit, Deconflictor } from '../src/main/deconflict'
import { describeCwd } from '../src/main/claude-data'
import { Hyperdrive, type PrOwner } from '../src/main/hyperdrive'
import type { PrStatus, PrStatusMap } from '../src/shared/types'

let failed = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failed++
    console.log(`FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// ---------------------------------------------------------------------------
// classifier
// ---------------------------------------------------------------------------
const CASES: Array<[string, string | null]> = [
  // stages the whole tree — would carry a sibling's edits into this commit
  ['git add -A', 'stage-all'],
  ['git add --all', 'stage-all'],
  ['git add .', 'stage-all'],
  ['git add -u', 'stage-all'],
  ['git commit -am "wip"', 'stage-all'],
  ['git commit -a -m "wip"', 'stage-all'],
  ['git add -A && git commit -m "done"', 'stage-all'],
  ['npm test && git add . && git commit -m x', 'stage-all'],
  ['git -C C:\\repo add -A', 'stage-all'],
  ['git stage .', 'stage-all'],

  // rewrites the working tree — would destroy a sibling's uncommitted changes
  ['git checkout main', 'destructive'],
  ['git checkout -- src/foo.ts', 'destructive'],
  ['git switch other', 'destructive'],
  ['git reset --hard HEAD', 'destructive'],
  ['git reset --hard origin/main', 'destructive'],
  ['git stash', 'destructive'],
  ['git stash push -m wip', 'destructive'],
  ['git stash pop', 'destructive'],
  ['git clean -fd', 'destructive'],
  ['git restore src/foo.ts', 'destructive'],

  // touches only its own paths, or reads — must never be intercepted
  ['git add src/foo.ts', null],
  ['git add src/foo.ts src/bar.ts', null],
  ['git commit -m "only staged"', null],
  ['git commit', null],
  ['git status', null],
  ['git status --porcelain', null],
  ['git diff', null],
  ['git log --oneline -5', null],
  ['git push', null],
  ['git push -u origin feat/x', null],
  ['git branch -a', null],
  ['git stash list', null],
  ['git stash show', null],
  ['git reset HEAD~1', null], // soft by default: index only, tree untouched
  ['git reset --soft HEAD~1', null],
  ['git clean -n', null], // dry run
  ['git fetch origin', null],
  ['git rev-parse HEAD', null],
  ['gh pr create --fill', null],
  ['npm test', null],
  ['echo "git add -A is dangerous"', null] // quoted text is not a git call
]

for (const [cmd, expected] of CASES) {
  check(`classify ${JSON.stringify(cmd)}`, classifyGit(cmd)?.risk ?? null, expected)
}

// ---------------------------------------------------------------------------
// decisions: ledger + mode behaviour
// ---------------------------------------------------------------------------
const REPO = 'C:\\repos\\thing'
const bash = (command: string) => ({ toolName: 'Bash', input: { command } })

const d = new Deconflictor()
d.setMode('enforce')
d.noteToolUse('sess-A', 'Edit', 'Kenobi', REPO, { file_path: `${REPO}\\src\\foo.ts` })

const denial = d.decide({ sessionId: 'sess-B', cwd: REPO, cloneName: 'Rex', ...bash('git add -A && git commit -m x') })
check('staging over a sibling is denied', denial?.deny, true)
check('the reason names the sibling', /Kenobi/.test(denial?.reason ?? ''), true)
check('the reason names the file at risk', /foo\.ts/.test(denial?.reason ?? ''), true)

check('a clone is not blocked by its own edits', d.decide({ sessionId: 'sess-A', cwd: REPO, ...bash('git add -A') }), null)
check('another folder is unaffected', d.decide({ sessionId: 'sess-C', cwd: 'C:\\other', ...bash('git add -A') }), null)
check('staging its own paths passes', d.decide({ sessionId: 'sess-B', cwd: REPO, ...bash('git add src/bar.ts') }), null)

const wipe = d.decide({ sessionId: 'sess-B', cwd: REPO, cloneName: 'Rex', ...bash('git reset --hard') })
check('reset --hard over a sibling is denied', wipe?.deny, true)
check('its reason says the work would be destroyed', /destroy/.test(wipe?.reason ?? ''), true)

// staging is NOT committing: the claim must survive it, or the guard drops
// while the work is still uncommitted and still vulnerable
d.noteToolUse('sess-A', 'Edit', 'Kenobi', REPO, { file_path: `${REPO}\\src\\foo.ts` })
d.decide({ sessionId: 'sess-A', cwd: REPO, ...bash('git add -A') })
check('git add does not release the claim', d.decide({ sessionId: 'sess-B', cwd: REPO, ...bash('git reset --hard') })?.deny, true)

// its own commit does release it
d.decide({ sessionId: 'sess-A', cwd: REPO, ...bash('git commit -m "landed"') })
check('git commit releases the claim', d.decide({ sessionId: 'sess-B', cwd: REPO, ...bash('git add -A') }), null)

const warn = new Deconflictor()
warn.setMode('warn')
warn.noteToolUse('sess-A', 'Write', 'Kenobi', REPO, { file_path: `${REPO}\\a.ts` })
check('warn mode allows the command', warn.decide({ sessionId: 'sess-B', cwd: REPO, ...bash('git add -A') }), null)
check('warn mode logs it anyway', warn.events().length, 1)
check('warn mode counts nothing as prevented', warn.preventedCount(), 0)

const off = new Deconflictor()
off.setMode('off')
off.noteToolUse('sess-A', 'Edit', 'Kenobi', REPO, { file_path: `${REPO}\\a.ts` })
check('off mode allows', off.decide({ sessionId: 'sess-B', cwd: REPO, ...bash('git reset --hard') }), null)
check('off mode logs nothing', off.events().length, 0)

check('non-shell tools are ignored', d.decide({ sessionId: 'sess-B', cwd: REPO, toolName: 'Edit', input: { file_path: 'x' } }), null)
check('a shell command with no git is ignored', d.decide({ sessionId: 'sess-B', cwd: REPO, ...bash('npm run build') }), null)

// ---------------------------------------------------------------------------
// arbiter interplay. Two things must hold or the arbiter deadlocks or lies:
// an exempt session is neither blocked nor counted, and the advice only
// promises orders when a denial actually happened.
// ---------------------------------------------------------------------------
{
  const a = new Deconflictor()
  a.setMode('enforce')
  a.setArbiterEnabled(true)
  a.noteToolUse('sess-A', 'Edit', 'Kenobi', REPO, { file_path: `${REPO}\\sync.ts` })

  const held = a.decide({ sessionId: 'sess-B', cwd: REPO, cloneName: 'Rex', ...bash('git add -A') })
  check('the collision is still denied with an arbiter coming', held?.deny, true)
  check('the clone is told to stand down', /arbiter/i.test(held?.reason ?? ''), true)
  check('and told explicitly not to ask you', /Do NOT ask the user/.test(held?.reason ?? ''), true)
  check('the old improvise-it-yourself advice is gone', /Stage only the files you changed/.test(held?.reason ?? ''), false)

  // the arbiter itself works in a folder full of siblings by definition
  a.exemptSession('sess-ARB')
  check('an arbiter is not blocked by the collision it was sent to fix', a.decide({ sessionId: 'sess-ARB', cwd: REPO, ...bash('git add src/sync.ts') }), null)
  check('nor by a destructive command it is forbidden anyway', a.decide({ sessionId: 'sess-ARB', cwd: REPO, ...bash('git reset --hard') }), null)

  // and its own edits must not become the next clone's obstacle
  a.noteToolUse('sess-ARB', 'Edit', 'arbiter', REPO, { file_path: `${REPO}\\sync.ts` })
  check('an arbiter stakes no claim of its own', a.claimList().some((c) => c.sessionId === 'sess-ARB'), false)

  a.unexemptSession('sess-ARB')
  check('the exemption ends when it stands down', a.decide({ sessionId: 'sess-ARB', cwd: REPO, ...bash('git reset --hard') })?.deny, true)
}

{
  // warn mode lets the command run, so promising orders that will never come
  // would strand the clone waiting
  const w = new Deconflictor()
  w.setMode('warn')
  w.setArbiterEnabled(true)
  w.noteToolUse('sess-A', 'Edit', 'Kenobi', REPO, { file_path: `${REPO}\\a.ts` })
  check('warn mode still allows', w.decide({ sessionId: 'sess-B', cwd: REPO, ...bash('git add -A') }), null)
  check('warn mode promises no arbiter', /arbiter/i.test(w.events()[0]?.command ?? ''), false)
}

// ---------------------------------------------------------------------------
// contested files — observation only, and it must not cry wolf: one clone
// editing its own file repeatedly is not contention
// ---------------------------------------------------------------------------
const c = new Deconflictor()
c.setMode('off') // tracking is independent of mode
const FILE = `${REPO}\\src\\auth.ts`

c.noteToolUse('sess-A', 'Edit', 'Kenobi', REPO, { file_path: FILE })
c.noteToolUse('sess-A', 'Edit', 'Kenobi', REPO, { file_path: FILE })
check('one clone editing twice is not contested', c.contestedFiles().length, 0)

c.noteToolUse('sess-B', 'Write', 'Rex', REPO, { file_path: FILE })
const contested = c.contestedFiles()
check('two clones in one file is contested', contested.length, 1)
check('it names the file', contested[0]?.file, FILE)
check('it counts both clones', contested[0]?.clones.length, 2)
check('it totals the edits', contested[0]?.edits, 3)
check('per-clone edit counts are kept', contested[0]?.clones.find((x) => x.name === 'Kenobi')?.edits, 2)

// a file only one clone has touched stays out of the list
c.noteToolUse('sess-A', 'Edit', 'Kenobi', REPO, { file_path: `${REPO}\\solo.ts` })
check('an uncontested file is excluded', c.contestedFiles().length, 1)

// three clones deep sorts above a two-clone file
c.noteToolUse('sess-C', 'Edit', 'Cody', REPO, { file_path: FILE })
c.noteToolUse('sess-A', 'Edit', 'Kenobi', REPO, { file_path: `${REPO}\\two.ts` })
c.noteToolUse('sess-B', 'Edit', 'Rex', REPO, { file_path: `${REPO}\\two.ts` })
check('worst contention sorts first', c.contestedFiles()[0]?.clones.length, 3)

// reads and non-edit tools never register
c.noteToolUse('sess-D', 'Read', 'Fives', REPO, { file_path: FILE })
check('reads are not contention', c.contestedFiles()[0]?.clones.length, 3)

// ---------------------------------------------------------------------------
// worktree display identity — a clone in <repo>/.claude/worktrees/<name> must
// still report the REPO it belongs to, or three clones on one project become
// three unrelated names on the board
// ---------------------------------------------------------------------------
check('plain folder', describeCwd('C:\\repos\\claude-fleet'), { repo: 'claude-fleet' })
check('plain folder, forward slashes', describeCwd('/home/t/claude-fleet'), { repo: 'claude-fleet' })
check('worktree keeps the repo name', describeCwd('C:\\repos\\claude-fleet\\.claude\\worktrees\\rot-fix'), {
  repo: 'claude-fleet',
  worktree: 'rot-fix'
})
check('worktree with forward slashes', describeCwd('/home/t/proj/.claude/worktrees/api'), {
  repo: 'proj',
  worktree: 'api'
})
check('trailing separator is harmless', describeCwd('C:\\repos\\claude-fleet\\'), { repo: 'claude-fleet' })
// a folder literally called "worktrees" that is NOT under .claude must not be
// mistaken for one
check('unrelated worktrees folder', describeCwd('C:\\repos\\proj\\worktrees\\thing'), { repo: 'thing' })

// ---------------------------------------------------------------------------
// Hyperdrive — it types into real terminals, so the rules that keep it
// trustworthy are the ones worth pinning down: transitions only, caps, and
// never dropping an intent it could not deliver
// ---------------------------------------------------------------------------
const PR = 'https://github.com/o/r/pull/7'

function pr(over: Partial<PrStatus> = {}): PrStatus {
  return {
    url: PR,
    number: 7,
    state: 'open',
    isDraft: false,
    reviewDecision: '',
    checks: 'pass',
    checksTotal: 3,
    checksFailed: 0,
    checksPending: 0,
    mergeable: 'mergeable',
    baseRef: 'main',
    fetchedAt: 1,
    ...over
  }
}
const map = (p: PrStatus): PrStatusMap => ({ [p.url]: p })

const reachable: PrOwner = { sessionId: 's1', name: 'Rex', ptyId: 'pty-1', awaitingUser: false, alive: true }

function harness(owner: PrOwner | null = reachable) {
  const sent: string[] = []
  let current = owner
  const hd = new Hyperdrive({ ownerOf: () => current, send: (_id, text) => sent.push(text) })
  hd.setSettings({ ci: true, conflict: true, maxAttempts: 2 })
  return { hd, sent, setOwner: (o: PrOwner | null) => (current = o) }
}

{
  // the real sequence: a clone opens a PR, the first poll sees CI still running,
  // the next sees it fail. That is the transition worth acting on.
  const { hd, sent } = harness()
  hd.onPrStatus(map(pr({ checks: 'pending', checksPending: 3 })))
  check('CI merely running does not dispatch', sent.length, 0)
  hd.onPrStatus(map(pr({ checks: 'fail', checksFailed: 1, fetchedAt: 2 })))
  check('going red while watching dispatches', sent.length, 1)
  check('CI orders forbid disabling tests', /do not disable/i.test(sent[0] ?? ''), true)
  check('CI orders forbid force-push', /force-push/i.test(sent[0] ?? ''), true)
}

{
  // a PR that was ALREADY red before Kamino started must never fire, however
  // many sweeps go by: on restart the owning clones have usually moved on to
  // other work, and a burst of orders would land mid-task
  const { hd, sent } = harness()
  hd.onPrStatus(map(pr({ checks: 'fail', checksFailed: 1 })))
  hd.onPrStatus(map(pr({ checks: 'fail', checksFailed: 1, fetchedAt: 2 })))
  hd.onPrStatus(map(pr({ checks: 'fail', checksFailed: 1, fetchedAt: 3 })))
  check('a failure that predates Kamino is left alone', sent.length, 0)
}

{
  const { hd, sent } = harness()
  hd.onPrStatus(map(pr()))
  hd.onPrStatus(map(pr({ mergeable: 'conflicting', fetchedAt: 2 })))
  check('conflict dispatches once', sent.length, 1)
  check('conflict orders say merge not rebase', /merge, do not rebase/i.test(sent[0] ?? ''), true)
  check('conflict orders name the base branch', /origin\/main/.test(sent[0] ?? ''), true)
  check('conflict orders protect the other side', /keeping BOTH intents/.test(sent[0] ?? ''), true)

  // still conflicting on later sweeps — must not spam, the transition is spent
  hd.onPrStatus(map(pr({ mergeable: 'conflicting', fetchedAt: 3 })))
  check('a persisting conflict does not re-dispatch', sent.length, 1)
}

{
  // caps: two attempts then it becomes yours
  const { hd, sent } = harness()
  hd.onPrStatus(map(pr()))
  hd.onPrStatus(map(pr({ checks: 'fail', fetchedAt: 2 })))
  hd.onPrStatus(map(pr({ checks: 'pending', fetchedAt: 3 })))
  hd.onPrStatus(map(pr({ checks: 'fail', fetchedAt: 4 })))
  check('two failures, two dispatches', sent.length, 2)
  hd.onPrStatus(map(pr({ checks: 'pending', fetchedAt: 5 })))
  hd.onPrStatus(map(pr({ checks: 'fail', fetchedAt: 6 })))
  check('third failure is not dispatched', sent.length, 2)
  check('it logs that it gave up', hd.getState().events.some((e) => e.outcome === 'exhausted'), true)
}

{
  // recovering restores the budget, so a later regression is still handled
  const { hd, sent } = harness()
  hd.onPrStatus(map(pr()))
  hd.onPrStatus(map(pr({ checks: 'fail', fetchedAt: 2 })))
  hd.onPrStatus(map(pr({ checks: 'fail', fetchedAt: 3 })))
  hd.onPrStatus(map(pr({ checks: 'pass', fetchedAt: 4 }))) // went green
  hd.onPrStatus(map(pr({ checks: 'fail', fetchedAt: 5 })))
  check('budget resets after recovery', sent.length, 2)
}

{
  // an unreachable clone must hold the intent, not lose it
  const h = harness({ ...reachable, ptyId: null })
  h.hd.onPrStatus(map(pr()))
  h.hd.onPrStatus(map(pr({ checks: 'fail', fetchedAt: 2 })))
  check('an unreachable clone gets nothing sent', h.sent.length, 0)
  check('the intent is kept, not dropped', h.hd.getState().pending.length, 1)
  check('the hold is logged once', h.hd.getState().events.filter((e) => e.outcome === 'blocked').length, 1)
  h.hd.onPrStatus(map(pr({ checks: 'fail', fetchedAt: 3 })))
  check('holding does not spam the log', h.hd.getState().events.filter((e) => e.outcome === 'blocked').length, 1)
  // once it becomes reachable the held intent goes out
  h.setOwner(reachable)
  h.hd.onPrStatus(map(pr({ checks: 'fail', fetchedAt: 4 })))
  check('a held intent is delivered when the clone is reachable', h.sent.length, 1)
}

{
  // a clone waiting on the user is left alone until it is free
  const h = harness({ ...reachable, awaitingUser: true })
  h.hd.onPrStatus(map(pr()))
  h.hd.onPrStatus(map(pr({ checks: 'fail', fetchedAt: 2 })))
  check('a clone awaiting your decision is not interrupted', h.sent.length, 0)
  h.setOwner(reachable)
  h.hd.onPrStatus(map(pr({ checks: 'fail', fetchedAt: 3 })))
  check('it is dispatched once the clone is free', h.sent.length, 1)
}

{
  // switches off means nothing happens at all
  const sent: string[] = []
  const hd = new Hyperdrive({ ownerOf: () => reachable, send: (_i, t) => sent.push(t) })
  hd.onPrStatus(map(pr()))
  hd.onPrStatus(map(pr({ checks: 'fail', mergeable: 'conflicting', fetchedAt: 2 })))
  check('both switches default to off', sent.length, 0)
  check('nothing is even queued while off', hd.getState().pending.length, 0)
}

{
  // turning a switch off drops what it had queued, rather than firing later
  const h = harness({ ...reachable, ptyId: null })
  h.hd.onPrStatus(map(pr()))
  h.hd.onPrStatus(map(pr({ checks: 'fail', fetchedAt: 2 })))
  check('intent is queued while held', h.hd.getState().pending.length, 1)
  h.hd.setSettings({ ci: false })
  check('switching off clears the queue', h.hd.getState().pending.length, 0)
}

{
  // a stale carry-forward reading is not evidence of anything
  const { hd, sent } = harness()
  hd.onPrStatus(map(pr()))
  hd.onPrStatus(map(pr({ checks: 'fail', stale: true, fetchedAt: 2 })))
  check('stale readings are ignored', sent.length, 0)
}

{
  // merged and closed PRs are forgotten, not fixed
  const { hd, sent } = harness()
  hd.onPrStatus(map(pr()))
  hd.onPrStatus(map(pr({ state: 'merged', checks: 'fail', fetchedAt: 2 })))
  check('a merged PR is left alone', sent.length, 0)
}

// ---------------------------------------------------------------------------
if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log(
    `all green: ${CASES.length} git-classifier cases + 18 airspace decision + 10 arbiter + 9 contention + 6 worktree + 27 hyperdrive checks`
  )
}
