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
if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log(`deconflict: ${CASES.length} classifier cases + 18 decision + 6 worktree checks passed`)
}
