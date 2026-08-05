/** Shared between main and renderer. Keep pure types here — no imports. */

export type InstanceKind = 'embedded' | 'external' | 'background' | 'dead'

export type InstanceState = 'busy' | 'needs-you' | 'idle' | 'dead'

/**
 * Why a clone is waiting. 'question'/'plan'/'permission' block on a real
 * choice; 'reply' means its last message ended in a question; 'idle' is just
 * the CLI's idle nag — nothing actually needs the user.
 */
export type PendingAskKind = 'question' | 'plan' | 'permission' | 'reply' | 'idle'

export interface PrLink {
  number: number
  url: string
  repository?: string
}

export type PrChecks = 'pass' | 'fail' | 'pending' | 'none'

/** Live GitHub state for a PR, fetched via the gh CLI. */
export interface PrStatus {
  url: string
  number: number
  state: 'open' | 'merged' | 'closed' | 'unknown'
  isDraft: boolean
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | '' */
  reviewDecision: string
  checks: PrChecks
  checksTotal: number
  checksFailed: number
  checksPending: number
  fetchedAt: number
  error?: string
  /** True when this is a carried-forward last-known status because the latest gh poll failed. */
  stale?: boolean
}

/** Keyed by PR url. */
export type PrStatusMap = Record<string, PrStatus>

export interface InstanceNow {
  /** Latest ai-title — the evolving one-line task description */
  title: string
  /** What it is literally doing right now: "Editing src/lib/seat.ts", "Running: npm test", "Waiting: approve Bash(...)" */
  activity: string
  /**
   * Only while state is 'needs-you': the full text of what it's blocked on —
   * the AskUserQuestion question + options, the command awaiting approval,
   * the plan headline, or its last reply's closing question.
   */
  pendingAsk?: string
  /** what kind of ask — drives the state word and one-click actions */
  askKind?: PendingAskKind
  /** option labels for one-click answering (single, single-select question) */
  pendingOptions?: string[]
  /** ms since the current turn started (only while busy) */
  turnStartedAt?: number
  /** Prompts queued behind the current turn */
  queued: string[]
}

/**
 * Context rot — how full the clone's context window is. Tokens come from the
 * latest assistant usage record; the window size is an estimate ratcheted up
 * (200k → 1M) when observed tokens prove the window must be the bigger tier.
 */
export interface ContextHealth {
  /** tokens in the window right now (input + cache read + cache creation) */
  tokens: number
  /** assumed window size in tokens */
  window: number
  /** tokens/window — may briefly exceed 1 right before an auto-compact */
  pct: number
  /** compactions so far this session */
  compactions: number
  /** ms epoch of the most recent compaction */
  lastCompactAt?: number
}

export interface InstanceRecent {
  lastPrompt: string
  lastAssistantText: string
  awaySummary?: string
  prs: PrLink[]
  turns: number
}

export interface Instance {
  sessionId: string
  pid: number
  cwd: string
  /** The repo's own folder name — for a worktree clone, the PARENT repo's, not
   *  the worktree directory's, so several clones on one project stay legible */
  repo: string
  /** set when this clone runs in its own git worktree (.claude/worktrees/<name>) */
  worktree?: string
  gitBranch: string
  name: string
  kind: InstanceKind
  state: InstanceState
  now: InstanceNow
  recent: InstanceRecent
  context?: ContextHealth
  startedAt: number
  lastActiveAt: number
  /** cli version, e.g. 2.1.220 */
  version?: string
  model?: string
  permissionMode?: string
}

/**
 * Reincarnation progress. Stages run in order: briefing (the old clone is
 * writing its handoff brief) → brief (it's written) → commissioning (successor
 * spawning) → seeding (brief going into the successor's composer) → done.
 */
export type HandoffStage = 'briefing' | 'brief' | 'commissioning' | 'seeding' | 'done' | 'error'

export interface HandoffProgress {
  /** the OLD clone's session — the one being handed off */
  sessionId: string
  stage: HandoffStage
  /** the brief, streaming while it's being written */
  brief?: string
  /** brief was cut short (timeout) and is going over incomplete */
  partial?: boolean
  successor?: { ptyId: string; pid: number }
  killedOld?: boolean
  error?: string
}

/**
 * Airspace control. 'off' stands down entirely; 'warn' logs what it would have
 * stopped but lets everything run; 'enforce' denies the tool call and hands the
 * clone a reason it can act on.
 */
export type DeconflictMode = 'off' | 'warn' | 'enforce'

/** A clone's in-flight edits in one folder. */
export interface FileClaim {
  sessionId: string
  name: string
  cwd: string
  /** most recently touched files (capped for display) */
  files: string[]
  lastEditAt: number
}

/** One git operation that collided with a sibling's in-flight work. */
export interface DeconflictEvent {
  id: string
  at: number
  sessionId: string
  cloneName: string
  cwd: string
  /** the git command as classified, e.g. "git add -A" */
  command: string
  risk: 'stage-all' | 'destructive'
  /** names of the clones whose work was at risk */
  siblings: string[]
  siblingFiles: string[]
  /** false in warn mode — logged, but the command still ran */
  denied: boolean
}

export interface AirspaceState {
  mode: DeconflictMode
  claims: FileClaim[]
  events: DeconflictEvent[]
  /** running total of collisions actually denied (survives restarts) */
  prevented: number
}

/** One message in the hover-peek transcript tail. */
export interface TranscriptTailMsg {
  who: 'you' | 'clone'
  text: string
  at?: number
}

export interface FleetSnapshot {
  instances: Instance[]
  updatedAt: number
}

export interface RecentProject {
  cwd: string
  lastUsed: number
}

export interface RecentSession {
  sessionId: string
  cwd: string
  gitBranch: string
  title: string
  lastPrompt: string
  prs: number[]
  mtime: number
}

export interface LaunchRequest {
  cwd: string
  resumeSessionId?: string
  initialPrompt?: string
  permissionMode?: string
  /** standing orders to commit, push and raise a PR when work is done.
   *  Omitted = on; only an explicit false turns it off. */
  autoShip?: boolean
  /** give this clone its own git worktree, so it gets its own branch and PR */
  worktree?: boolean
  worktreeName?: string
}

export interface PtyInfo {
  ptyId: string
  pid: number
  cwd: string
}

/** wrap-up check: one repo the fleet is working in, and whether closing the
 *  lid would lose anything */
export interface WrapupRepo {
  cwd: string
  repo: string
  /** names of the clones working in this folder */
  clones: string[]
  branch: string
  /** uncommitted files (staged, unstaged, untracked) */
  dirty: number
  /** commits not yet on the upstream branch */
  ahead: number
  /** branch has no remote counterpart at all */
  noUpstream: boolean
  /** on main/master — no PR expected */
  defaultBranch: boolean
  pr: { number: number; url: string; title: string } | null
  /** gh unavailable/errored — PR state unknown */
  prError?: string
  /** folder isn't a git repo / git failed */
  error?: string
}

export interface WrapupReport {
  repos: WrapupRepo[]
  generatedAt: number
}
