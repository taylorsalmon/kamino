/**
 * Integration test for the airspace arbiter.
 *
 * This covers the loop that unit tests can't: a REAL git repository with a real
 * two-author collision in it, real evidence gathering, and the whole
 * dispatch → verdict → resume path driven end to end. The only thing faked is
 * the clone itself — a stand-in terminal that receives the orders and writes a
 * verdict back into a transcript exactly where a real arbiter would.
 *
 * That boundary is deliberate. Everything on Kamino's side of it is mechanical
 * and must be right every time; everything on the far side is a language model
 * and can only be judged by watching one. So this proves the plumbing, and the
 * live rehearsal in the README proves the judgement.
 *
 * Run with: npm test
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import { Arbiter, parseVerdict } from '../src/main/arbiter'
import { transcriptPath } from '../src/main/claude-data'
import type { InstanceStore } from '../src/main/instance-store'
import type { PtyManager } from '../src/main/pty-manager'
import type { ArbiterCase, DeconflictEvent, FleetSnapshot, Instance } from '../src/shared/types'

let failed = 0
let checks = 0

function check(label: string, actual: unknown, expected: unknown): void {
  checks++
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  failed++
  console.log(`FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const FAST = {
  verdictTimeoutMs: 3000,
  pollMs: 20,
  readyQuietMs: 20,
  readyTimeoutMs: 2000,
  sessionTimeoutMs: 2000
}

// ---------------------------------------------------------------------------
// a real repository with a real collision in it
// ---------------------------------------------------------------------------

/**
 * Two clones, one folder, in the shape that actually cost time: they have
 * interleaved edits in ONE file (sync.ts), and they have independently written
 * two migrations that create the same table. Neither is a textual conflict —
 * which is the whole reason a human had to look at it.
 */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kamino-arbiter-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true })
  }
  fs.writeFileSync(path.join(dir, 'sync.ts'), 'export function sync() {\n  return 1\n}\n')
  git('init', '-q')
  git('config', 'user.email', 'test@kamino.local')
  git('config', 'user.name', 'Kamino Test')
  git('config', 'commit.gpgsign', 'false')
  git('add', '.')
  git('commit', '-q', '-m', 'base')

  // clone A's edit and clone B's edit, both uncommitted, in the same file
  fs.writeFileSync(
    path.join(dir, 'sync.ts'),
    'export function sync() {\n  // paid-search leg (ripcurl)\n  return 1\n}\n\nexport function syncTargets() {\n  // targets leg (lkg-ee)\n  return 2\n}\n'
  )
  fs.writeFileSync(path.join(dir, '0125_polar_shop_daily.sql'), 'create table shop_daily (demand_target numeric);\n')
  fs.writeFileSync(path.join(dir, '0126_polar_targets_daily.sql'), 'create table targets_daily (budget numeric);\n')
  return dir
}

function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* windows sometimes holds the handle a moment; the temp dir is disposable */
  }
}

// ---------------------------------------------------------------------------
// the stand-in fleet
// ---------------------------------------------------------------------------

interface Written {
  ptyId: string
  data: string
}

/**
 * A terminal farm that behaves like the real one from the arbiter's point of
 * view: spawning emits output (so the readiness wait completes), and a
 * bracketed paste is treated as "the arbiter has its orders".
 */
class FakePtys extends EventEmitter {
  written: Written[] = []
  killed: string[] = []
  spawned: Array<{ ptyId: string; pid: number; opts: Record<string, unknown> }> = []
  /** called with the orders text the moment they're pasted in */
  onOrders: ((orders: string, ptyId: string) => void) | null = null
  private n = 0

  spawn(opts: Record<string, unknown>): { ptyId: string; pid: number; cwd: string } {
    const n = ++this.n
    const info = { ptyId: `pty-arb-${n}`, pid: 9000 + n, cwd: String(opts.cwd ?? '') }
    this.spawned.push({ ...info, opts })
    // a real CLI paints its composer shortly after starting; the arbiter waits
    // for that to go quiet before typing
    setTimeout(() => this.emit('data', info.ptyId, 'welcome'), 1)
    return info
  }

  write(ptyId: string, data: string): void {
    this.written.push({ ptyId, data })
    if (data.startsWith('\x1b[200~') && this.onOrders) {
      const orders = data.slice('\x1b[200~'.length, data.lastIndexOf('\x1b[201~'))
      // next tick: the real clone takes a while to answer, and answering inside
      // the write call would test a race that cannot happen
      setTimeout(() => this.onOrders?.(orders, ptyId), 5)
    }
  }

  kill(ptyId: string): void {
    this.killed.push(ptyId)
    this.emit('exit', ptyId, 0)
  }

  ptyIdForPid(pid: number): string | null {
    if (pid === BLOCKED_PID) return 'pty-blocked'
    const hit = this.spawned.find((s) => s.pid === pid)
    return hit ? hit.ptyId : null
  }

  /** what was typed into the blocked clone's terminal, if anything */
  ordersToBlocked(): string | null {
    const hit = this.written.find((w) => w.ptyId === 'pty-blocked')
    return hit ? hit.data : null
  }
}

const BLOCKED_PID = 4242

function instance(over: Partial<Instance>): Instance {
  return {
    sessionId: 'sess-blocked',
    pid: BLOCKED_PID,
    cwd: '',
    repo: 'thing',
    gitBranch: 'feat/paid-search',
    name: 'ripcurl-01',
    kind: 'embedded',
    state: 'idle',
    now: { title: 'Paid Search tab', activity: '', queued: [] },
    recent: { lastPrompt: '', lastAssistantText: '', prs: [], turns: 0 },
    startedAt: 0,
    lastActiveAt: 0,
    ...over
  }
}

class FakeStore {
  instances: Instance[] = []
  /** pid → sessionId, as the real registry would report once a clone binds */
  sessions = new Map<number, string>()

  get(sessionId: string): Instance | null {
    return this.instances.find((i) => i.sessionId === sessionId) ?? null
  }

  snapshot(): FleetSnapshot {
    return { instances: this.instances, updatedAt: 0 }
  }

  sessionIdForPid(pid: number): string | null {
    return this.sessions.get(pid) ?? null
  }
}

interface Harness {
  arb: Arbiter
  ptys: FakePtys
  store: FakeStore
  repo: string
  exempted: string[]
  unexempted: string[]
  cases: ArbiterCase[]
  cleanup: () => void
}

const ARB_SESSION = 'sess-arbiter-test'

function harness(opts?: { timings?: Partial<typeof FAST> }): Harness {
  const repo = makeRepo()
  const ptys = new FakePtys()
  const store = new FakeStore()
  store.instances = [
    instance({ cwd: repo }),
    instance({
      sessionId: 'sess-lkg',
      pid: 5555,
      cwd: repo,
      name: 'lkg-ee',
      now: { title: 'Polar targets migration', activity: '', queued: [] }
    })
  ]
  const exempted: string[] = []
  const unexempted: string[] = []
  const cases: ArbiterCase[] = []

  const arb = new Arbiter(
    {
      ptys: ptys as unknown as PtyManager,
      store: store as unknown as InstanceStore,
      exempt: (s) => exempted.push(s),
      unexempt: (s) => unexempted.push(s)
    },
    undefined,
    { ...FAST, ...opts?.timings }
  )
  arb.setSettings({ enabled: true })
  arb.on('case', (c: ArbiterCase) => cases.push({ ...c }))

  // the spawned clone binds to a session, as the real registry would
  const origSpawn = ptys.spawn.bind(ptys)
  ptys.spawn = (o: Record<string, unknown>) => {
    const info = origSpawn(o)
    store.sessions.set(info.pid, `${ARB_SESSION}-${info.pid}`)
    return info
  }

  return {
    arb,
    ptys,
    store,
    repo,
    exempted,
    unexempted,
    cases,
    cleanup: () => {
      // the transcript the fake arbiter wrote lives under ~/.claude/projects,
      // keyed by a slug of the temp repo — take the whole directory, or every
      // run leaves a dead project folder behind in the user's real Claude data
      rmrf(path.dirname(transcriptPath(repo, 'x')))
      rmrf(repo)
    }
  }
}

/** write a verdict where the arbiter reads for one — its own transcript */
function answer(repo: string, ptys: FakePtys, ptyId: string, verdict: unknown): void {
  const spawned = ptys.spawned.find((s) => s.ptyId === ptyId)
  if (!spawned) throw new Error(`no such arbiter terminal: ${ptyId}`)
  const file = transcriptPath(repo, `${ARB_SESSION}-${spawned.pid}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text =
    '===KAMINO-ARBITER-START===\n' + JSON.stringify(verdict) + '\n===KAMINO-ARBITER-END==='
  const rec = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp: new Date(0).toISOString()
  }
  fs.appendFileSync(file, JSON.stringify(rec) + '\n')
}

function collision(repo: string, over?: Partial<DeconflictEvent>): DeconflictEvent {
  return {
    id: 'dc-1',
    at: 0,
    sessionId: 'sess-blocked',
    cloneName: 'ripcurl-01',
    cwd: repo,
    command: 'git add -A',
    risk: 'stage-all',
    siblings: ['lkg-ee'],
    siblingFiles: [path.join(repo, 'sync.ts')],
    denied: true,
    ...over
  }
}

/** resolve once the case reaches a stage it will not leave */
function settled(arb: Arbiter, timeoutMs = 8000): Promise<ArbiterCase> {
  return new Promise((resolve, reject) => {
    const done = ['resolved', 'escalated', 'failed']
    const timer = setTimeout(() => reject(new Error('the case never settled')), timeoutMs)
    const on = (c: ArbiterCase): void => {
      if (!done.includes(c.stage)) return
      clearTimeout(timer)
      arb.off('case', on)
      resolve(c)
    }
    arb.on('case', on)
  })
}

// ---------------------------------------------------------------------------
// 1. the happy path: a clear collision is settled and the clone is sent on
// ---------------------------------------------------------------------------
{
  const h = harness()
  let sawOrders = ''
  h.ptys.onOrders = (orders, ptyId) => {
    sawOrders = orders
    answer(h.repo, h.ptys, ptyId, {
      confidence: 'high',
      summary: 'One file, two authors — sync.ts holds both legs.',
      action: 'Staged sync.ts hunks belonging to ripcurl-01; left syncTargets unstaged.',
      resumeOrders: 'Your Paid Search edits to sync.ts are staged. lkg-ee syncTargets leg is not.'
    })
  }

  const done = settled(h.arb)
  h.arb.open(collision(h.repo))
  const c = await done

  check('a clear collision is settled', c.stage, 'resolved')
  check('the verdict summary is kept', /two authors/.test(c.summary ?? ''), true)
  check('so is what it actually did', /Staged sync\.ts/.test(c.action ?? ''), true)
  check('it counts as settled without you', h.arb.getState().resolved, 1)
  check('and nothing was escalated', h.arb.getState().escalated, 0)

  // the evidence really came from git, not from a template
  check('the orders carry the real working tree', /0126_polar_targets_daily\.sql/.test(sawOrders), true)
  check('the orders carry the real diff', /syncTargets/.test(sawOrders), true)
  check('the orders name the blocked clone task', /Paid Search tab/.test(sawOrders), true)
  check('the orders name the sibling task', /Polar targets migration/.test(sawOrders), true)
  check('the orders name the denied command', /git add -A/.test(sawOrders), true)

  // and the blocked clone was actually sent on its way
  const orders = h.ptys.ordersToBlocked() ?? ''
  check('the blocked clone is told to carry on', /Carry on from here/.test(orders), true)
  check('it is told what is staged', /Your Paid Search edits to sync\.ts are staged/.test(orders), true)
  check('it is told not to re-run the denied command', /Do not re-run/.test(orders), true)
  check('it is told whose work to leave alone', /lkg-ee/.test(orders), true)
  check('the order is submitted, not left in the composer', orders.endsWith('\r'), true)

  // a settled arbiter has nothing further to say
  check('the arbiter terminal is closed', h.ptys.killed.length, 1)
  check('the arbiter was exempted from the guard', h.exempted.length, 1)
  check('and released when its terminal closed', h.unexempted, h.exempted)

  h.cleanup()
}

// ---------------------------------------------------------------------------
// 2. unsure comes back to you — and nothing is done in the meantime
// ---------------------------------------------------------------------------
{
  const h = harness()
  h.ptys.onOrders = (_o, ptyId) =>
    answer(h.repo, h.ptys, ptyId, {
      confidence: 'unsure',
      summary: 'Two migrations, one table.',
      action: '0125 and 0126 both write the demand target.',
      question: 'Which migration should own the demand target — 0125 or 0126?',
      options: ['Keep 0125 (already applied)', 'Keep 0126 (lkg-ee, in flight)']
    })

  const done = settled(h.arb)
  h.arb.open(collision(h.repo))
  const c = await done

  check('an unsure verdict comes back to you', c.stage, 'escalated')
  check('the question is carried whole', c.question, 'Which migration should own the demand target — 0125 or 0126?')
  check('so are the options', c.options?.length, 2)
  check('it is counted as escalated', h.arb.getState().escalated, 1)
  check('and not as settled', h.arb.getState().resolved, 0)
  check('the blocked clone is NOT sent on', h.ptys.ordersToBlocked(), null)
  // you will want to read what it looked at
  check('the arbiter terminal stays open', h.ptys.killed.length, 0)
  check('so its exemption stands', h.unexempted.length, 0)

  h.cleanup()
}

// ---------------------------------------------------------------------------
// 3. a clone that says "high" but gives no orders is not to be believed
// ---------------------------------------------------------------------------
{
  const h = harness()
  h.ptys.onOrders = (_o, ptyId) =>
    answer(h.repo, h.ptys, ptyId, { confidence: 'high', summary: 'Sorted it.', action: 'Staged things.' })

  const done = settled(h.arb)
  h.arb.open(collision(h.repo))
  const c = await done

  check('confidence without orders is not a resolution', c.stage, 'escalated')
  check('and it asks you rather than inventing orders', /which side/i.test(c.question ?? ''), true)
  check('the blocked clone is left alone', h.ptys.ordersToBlocked(), null)

  h.cleanup()
}

// ---------------------------------------------------------------------------
// 4. an arbiter that never answers must not strand the blocked clone silently
// ---------------------------------------------------------------------------
{
  const h = harness({ timings: { verdictTimeoutMs: 150 } })
  h.ptys.onOrders = null // it takes the orders and says nothing, ever

  const done = settled(h.arb)
  h.arb.open(collision(h.repo))
  const c = await done

  check('a silent arbiter escalates', c.stage, 'escalated')
  check('and says so plainly', /ran out of time/.test(c.question ?? ''), true)
  check('it counts against the arbiter, not for it', h.arb.getState().resolved, 0)

  h.cleanup()
}

// ---------------------------------------------------------------------------
// 5. one arbiter per folder — the second collision waits its turn
// ---------------------------------------------------------------------------
{
  const h = harness()
  let answered = 0
  h.ptys.onOrders = (_o, ptyId) => {
    answered++
    answer(h.repo, h.ptys, ptyId, {
      confidence: 'high',
      summary: `case ${answered}`,
      action: 'staged',
      resumeOrders: 'go on'
    })
  }

  const first = settled(h.arb)
  h.arb.open(collision(h.repo))
  // a second collision in the same folder, while the first is still running
  h.arb.open(collision(h.repo, { id: 'dc-2', sessionId: 'sess-lkg', cloneName: 'lkg-ee', command: 'git stash' }))
  check('only one arbiter is dispatched at a time', h.ptys.spawned.length <= 1, true)

  await first
  const second = await settled(h.arb)
  check('the queued collision runs afterwards', second.command, 'git stash')
  check('each collision got its own arbiter', h.ptys.spawned.length, 2)

  h.cleanup()
}

// ---------------------------------------------------------------------------
// 6. the same clone tripping the same guard twice is one collision
// ---------------------------------------------------------------------------
{
  const h = harness()
  h.ptys.onOrders = (_o, ptyId) =>
    answer(h.repo, h.ptys, ptyId, { confidence: 'unsure', question: 'q' })

  const first = settled(h.arb)
  h.arb.open(collision(h.repo))
  h.arb.open(collision(h.repo, { id: 'dc-2' })) // same session, same command
  await first
  await new Promise((r) => setTimeout(r, 200))
  check('a repeat of the same collision is not queued twice', h.ptys.spawned.length, 1)

  h.cleanup()
}

// ---------------------------------------------------------------------------
// 7. switches that must actually switch
// ---------------------------------------------------------------------------
{
  const h = harness()
  h.arb.setSettings({ enabled: false })
  h.arb.open(collision(h.repo))
  await new Promise((r) => setTimeout(r, 150))
  check('nothing is dispatched while switched off', h.ptys.spawned.length, 0)
  check('and no case is opened', h.arb.getState().cases.length, 0)

  // a collision that airspace only WARNED about has not been stopped; acting on
  // it would be acting on a command that already ran
  h.arb.setSettings({ enabled: true })
  h.arb.open(collision(h.repo, { denied: false }))
  await new Promise((r) => setTimeout(r, 150))
  check('an allowed collision is not arbitrated', h.ptys.spawned.length, 0)

  h.cleanup()
}

// ---------------------------------------------------------------------------
// 8. the arbiter is spawned as an arbiter, not as an ordinary clone
// ---------------------------------------------------------------------------
{
  const h = harness()
  h.ptys.onOrders = (_o, ptyId) =>
    answer(h.repo, h.ptys, ptyId, { confidence: 'high', resumeOrders: 'go on', summary: 's', action: 'a' })
  const done = settled(h.arb)
  h.arb.open(collision(h.repo))
  await done

  const opts = h.ptys.spawned[0].opts
  check('it runs in the folder that collided', opts.cwd, h.repo)
  check('it is never told to ship', opts.autoShip, false)
  check('it cannot stall on a permission prompt', opts.permissionMode, 'bypassPermissions')
  const sys = String(opts.appendSystemPrompt ?? '')
  check('its standing orders forbid committing', /never run git commit/i.test(sys), true)
  check('its standing orders forbid destructive git', /git reset/i.test(sys), true)
  check('its standing orders forbid pushing', /git push/i.test(sys), true)
  check('its standing orders bless being unsure', /unsure is a correct and expected answer/i.test(sys), true)

  h.cleanup()
}

// ---------------------------------------------------------------------------
// 9. verdict parsing — a model will not always hand back clean JSON
// ---------------------------------------------------------------------------
check('plain json parses', parseVerdict('{"confidence":"high"}')?.confidence, 'high')
check(
  'a fenced verdict still parses',
  parseVerdict('```json\n{"confidence":"high","summary":"x"}\n```')?.summary,
  'x'
)
check(
  'stray prose around the object is tolerated',
  parseVerdict('Here you go:\n{"confidence":"unsure"}\nthanks')?.confidence,
  'unsure'
)
check('a missing confidence is treated as unsure', parseVerdict('{"summary":"x"}')?.confidence, 'unsure')
check('confidence is case-insensitive', parseVerdict('{"confidence":"HIGH"}')?.confidence, 'high')
check('torn json is no verdict at all', parseVerdict('{"confidence":"hi'), null)
check('empty is no verdict at all', parseVerdict(''), null)
check(
  'options are capped and de-typed',
  parseVerdict('{"confidence":"unsure","options":["a","b","c","d","e",7]}')?.options,
  ['a', 'b', 'c', 'd']
)

// ---------------------------------------------------------------------------
if (failed > 0) {
  console.log(`\n${failed} arbiter check(s) failed`)
  process.exitCode = 1
} else {
  console.log(`arbiter: all green — ${checks} checks across 9 scenarios`)
}
