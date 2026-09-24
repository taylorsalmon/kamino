/**
 * Tests for the live pane title.
 *
 * The model's reply is the untrusted half of this feature: it lands straight in
 * the pane, so anything that is not a short title has to be rejected rather
 * than displayed. The table below is the specification for what counts.
 *
 * Run with: npm test
 */
import { buildPrompt, cleanTitle, Retitler } from '../src/main/retitle'
import type { InstanceStore } from '../src/main/instance-store'
import type { Instance } from '../src/shared/types'

let failed = 0
let checks = 0

function check(label: string, actual: unknown, expected: unknown): void {
  checks++
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  failed++
  console.log(`FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// null means "keep the title we already have"
const CASES: Array<[string, string, string | null]> = [
  ['a plain title passes through', 'Refactor the seat allocator', 'Refactor the seat allocator'],
  ['SAME keeps the current title', 'SAME', null],
  ['same in any case keeps it', 'same', null],
  ['an empty reply keeps it', '   \n  ', null],
  ['quotes are stripped', '"Fix the login redirect"', 'Fix the login redirect'],
  ['backticks and asterisks are stripped', '**Wire up the PR button**', 'Wire up the PR button'],
  ['a Title: prefix is stripped', 'Title: Add auto-update flag', 'Add auto-update flag'],
  ['a trailing full stop goes', 'Chasing a flaky test.', 'Chasing a flaky test'],
  ['leading blank lines are skipped', '\n\nTune the arbiter prompt', 'Tune the arbiter prompt'],
  ['only the first line is used', 'Ship the titler\nThen tidy up', 'Ship the titler'],
  ['inner whitespace collapses', 'Debug   the   hook  server', 'Debug the hook server'],
  ['prose is rejected outright', 'x'.repeat(121), null],
  ['an over-long title is trimmed, not dropped', 'y'.repeat(70), 'y'.repeat(59) + '…']
]

for (const [label, reply, expected] of CASES) check(label, cleanTitle(reply), expected)

// ---------------------------------------------------------------------------
// the prompt has to carry the current title (so SAME is answerable), the
// actions (so "please fix." has a subject), and put the newest request last
{
  const work = { prompts: ['first ask', 'please fix.'], actions: ['Editing src/main/retitle.ts'] }
  const p = buildPrompt('Old stale title', work, 'Running: npm test')
  check('prompt carries the current title', p.includes('CURRENT TITLE: Old stale title'), true)
  check('prompt carries the activity', p.includes('DOING RIGHT NOW: Running: npm test'), true)
  check('prompt carries what it has been doing', p.includes('- Editing src/main/retitle.ts'), true)
  check('newest request is above the actions', p.indexOf('2. please fix.') < p.indexOf('- Editing'), true)

  const bare = buildPrompt('', { prompts: ['only ask'], actions: [] }, '')
  check('an untitled session says so', bare.includes('CURRENT TITLE: (none yet)'), true)
  check('no activity line when idle', bare.includes('DOING RIGHT NOW'), false)
  check('no actions section when there are none', bare.includes('HAS BEEN DOING'), false)
  check('newest request is last', bare.trimEnd().endsWith('1. only ask'), true)
}

// ---------------------------------------------------------------------------
// Cadence. Every sweep that decides to ask costs a CLI call and real money, so
// what gets asked and what does not is the part worth pinning down.
// ---------------------------------------------------------------------------

function instance(over: Partial<Instance>): Instance {
  return {
    sessionId: 'sess-1',
    pid: 100,
    cwd: 'C:\\repo',
    repo: 'repo',
    gitBranch: 'main',
    name: 'clone-01',
    kind: 'embedded',
    state: 'idle',
    now: { title: 'Opening prompt title', activity: '', queued: [] },
    recent: { lastPrompt: '', lastAssistantText: '', prs: [], issues: [], turns: 0 },
    startedAt: 0,
    lastActiveAt: 0,
    ...over
  }
}

/** a store that records the titles set on it, and a clock the test drives */
function harness(replies: string[]) {
  const instances: Instance[] = []
  const asked: string[] = []
  const set: Array<[string, string]> = []
  let clock = 1_000_000
  const store = {
    snapshot: () => ({ instances, updatedAt: 0 }),
    setLiveTitle: (sessionId: string, title: string) => {
      set.push([sessionId, title])
      const i = instances.find((x) => x.sessionId === sessionId)
      if (i) i.now.title = title
    }
  } as unknown as InstanceStore
  const r = new Retitler(store, {
    ask: async (input) => {
      asked.push(input)
      const reply = replies.shift()
      if (reply === undefined || reply === 'THROW') throw new Error('claude -p exited 1')
      return reply
    },
    read: () => ({ prompts: ['do the thing'], actions: ['Editing a.ts'] }),
    now: () => clock
  })
  return { r, instances, asked, set, advance: (ms: number) => (clock += ms) }
}

{
  // a session one turn past its ai-title is still described by it
  const h = harness(['New title'])
  h.instances.push(instance({ recent: { lastPrompt: '', lastAssistantText: '', prs: [], turns: 1 } }))
  await h.r.tick()
  check('one turn in, nothing is asked', h.asked.length, 0)
}

{
  // two turns in, the opening prompt has been overtaken — and a board that was
  // already past that when Kamino started is fixed on the first sweep
  const h = harness(['Chasing the flaky test'])
  h.instances.push(instance({ recent: { lastPrompt: '', lastAssistantText: '', prs: [], turns: 9 } }))
  await h.r.tick()
  check('a session past its title is retitled', h.set, [['sess-1', 'Chasing the flaky test']])

  // nothing new said since — no second call, however often the sweep runs
  h.advance(10 * 60 * 1000)
  await h.r.tick()
  check('a quiet session is not asked again', h.asked.length, 1)

  // two more turns and it is worth another look
  h.instances[0].recent.turns = 11
  await h.r.tick()
  check('two more turns earns another ask', h.asked.length, 2)
}

{
  // the rate floor holds even when the user is typing fast
  const h = harness(['One', 'Two'])
  h.instances.push(instance({ recent: { lastPrompt: '', lastAssistantText: '', prs: [], turns: 4 } }))
  await h.r.tick()
  h.instances[0].recent.turns = 20
  await h.r.tick()
  check('a burst of turns cannot outrun the interval', h.asked.length, 1)
  h.advance(91_000)
  await h.r.tick()
  check('past the interval it asks again', h.asked.length, 2)
}

{
  // SAME is the common answer and must cost the pane nothing
  const h = harness(['SAME'])
  h.instances.push(instance({ recent: { lastPrompt: '', lastAssistantText: '', prs: [], turns: 4 } }))
  await h.r.tick()
  check('SAME leaves the title alone', h.set.length, 0)
  check('SAME still counts as settled', h.asked.length, 1)
}

{
  // a CLI that is missing or unauthed must not be retried forever
  const h = harness(['THROW', 'THROW', 'THROW', 'THROW', 'THROW'])
  for (let i = 0; i < 5; i++) {
    h.instances.push(
      instance({ sessionId: `sess-${i}`, recent: { lastPrompt: '', lastAssistantText: '', prs: [], turns: 4 } })
    )
  }
  await h.r.tick()
  check('a broken CLI stops the sweep at the failure limit', h.asked.length, 3)
}

{
  // dead panes are nobody's business
  const h = harness(['Should not be asked'])
  h.instances.push(
    instance({ state: 'dead', recent: { lastPrompt: '', lastAssistantText: '', prs: [], turns: 9 } })
  )
  await h.r.tick()
  check('a dead session is skipped', h.asked.length, 0)
}

// ---------------------------------------------------------------------------
if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exitCode = 1
} else {
  console.log(`all green: ${checks} retitle checks`)
}
