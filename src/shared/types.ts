/** Shared between main and renderer. Keep pure types here — no imports. */

export type InstanceKind = 'embedded' | 'external' | 'background' | 'dead'

export type InstanceState = 'busy' | 'needs-you' | 'idle' | 'dead'

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
  /** ms since the current turn started (only while busy) */
  turnStartedAt?: number
  /** Prompts queued behind the current turn */
  queued: string[]
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
  /** Last path segment of cwd, for display */
  repo: string
  gitBranch: string
  name: string
  kind: InstanceKind
  state: InstanceState
  now: InstanceNow
  recent: InstanceRecent
  startedAt: number
  lastActiveAt: number
  /** cli version, e.g. 2.1.220 */
  version?: string
  model?: string
  permissionMode?: string
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
}

export interface PtyInfo {
  ptyId: string
  pid: number
  cwd: string
}
