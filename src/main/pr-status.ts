/**
 * pr-status — live GitHub state for the PRs each clone has raised, polled
 * through the `gh` CLI (which brings its own auth; we never touch tokens).
 * Defensive by design: if gh is missing, unauthenticated, or the PR is on a
 * repo the active gh account can't see, the map entry carries an error and
 * the UI falls back to the plain PR chip.
 */
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { PrChecks, PrStatus, PrStatusMap } from '../shared/types'

const OPEN_POLL_MS = 60_000
const SETTLED_POLL_MS = 10 * 60_000 // merged/closed rarely change — but closed can reopen
const GH_TIMEOUT_MS = 15_000

/** statusCheckRollup mixes CheckRun (status/conclusion) and StatusContext (state) nodes. */
interface RollupNode {
  status?: string
  conclusion?: string
  state?: string
}

function normalizeState(s: unknown): PrStatus['state'] {
  const v = typeof s === 'string' ? s.toUpperCase() : ''
  if (v === 'OPEN') return 'open'
  if (v === 'MERGED') return 'merged'
  if (v === 'CLOSED') return 'closed'
  return 'unknown'
}

function summarizeChecks(nodes: RollupNode[]): {
  checks: PrChecks
  checksTotal: number
  checksFailed: number
  checksPending: number
} {
  let failed = 0
  let pending = 0
  for (const n of nodes) {
    const conclusion = (n.conclusion ?? '').toUpperCase()
    const state = (n.state ?? '').toUpperCase()
    const status = (n.status ?? '').toUpperCase()
    if (
      ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion) ||
      ['FAILURE', 'ERROR'].includes(state)
    ) {
      failed++
    } else if ((status && status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(state)) {
      pending++
    }
    // SUCCESS / NEUTRAL / SKIPPED all count as passing
  }
  const checks: PrChecks = nodes.length === 0 ? 'none' : failed > 0 ? 'fail' : pending > 0 ? 'pending' : 'pass'
  return { checks, checksTotal: nodes.length, checksFailed: failed, checksPending: pending }
}

/** gh error output starts with useful text but can trail into usage noise. */
function shortGhError(msg: string): string {
  const line = msg.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('Command failed')) ?? 'gh error'
  return line.trim().slice(0, 120)
}

export class PrStatusPoller extends EventEmitter {
  private watched = new Set<string>()
  private cache = new Map<string, PrStatus>()
  private timer: NodeJS.Timeout | null = null
  private sweeping = false
  private ghMissing = false

  start(): void {
    this.timer = setInterval(() => void this.sweep(), OPEN_POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  snapshot(): PrStatusMap {
    const map: PrStatusMap = {}
    for (const [url, st] of this.cache) map[url] = st
    return map
  }

  /** Replace the watch list with the PRs currently on the board. */
  setWatched(urls: string[]): void {
    const next = new Set(urls.filter((u) => /^https:\/\/github\.com\/.+\/pull\/\d+/.test(u)))
    let added = false
    for (const u of next) if (!this.watched.has(u)) added = true
    for (const u of [...this.cache.keys()]) if (!next.has(u)) this.cache.delete(u)
    this.watched = next
    if (added) void this.sweep()
  }

  private due(url: string, now: number): boolean {
    const st = this.cache.get(url)
    if (!st) return true
    const interval = st.state === 'open' || st.state === 'unknown' ? OPEN_POLL_MS : SETTLED_POLL_MS
    return now - st.fetchedAt >= interval - 1_000
  }

  private async sweep(): Promise<void> {
    if (this.sweeping || this.ghMissing || this.watched.size === 0) return
    this.sweeping = true
    const now = Date.now()
    let changed = false
    try {
      for (const url of this.watched) {
        if (!this.due(url, now)) continue
        const st = await this.fetch(url)
        if (st) {
          this.cache.set(url, st)
          changed = true
        }
        if (this.ghMissing) break
      }
    } finally {
      this.sweeping = false
    }
    if (changed) this.emit('update', this.snapshot())
  }

  private fetch(url: string): Promise<PrStatus | null> {
    return new Promise((resolve) => {
      execFile(
        'gh',
        ['pr', 'view', url, '--json', 'number,state,isDraft,reviewDecision,statusCheckRollup'],
        { timeout: GH_TIMEOUT_MS, windowsHide: true },
        (err, stdout, stderr) => {
          const numberFromUrl = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0)
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            this.ghMissing = true // no gh on PATH — stand down for this run
            resolve(null)
            return
          }
          if (err) {
            const error = shortGhError(stderr || err.message)
            const prev = this.cache.get(url)
            if (prev && prev.state !== 'unknown') {
              // Keep the last-known status instead of stomping it with '?' —
              // a single network blip shouldn't erase a good answer.
              resolve({ ...prev, fetchedAt: Date.now(), stale: true, error })
              return
            }
            resolve({
              url,
              number: numberFromUrl,
              state: 'unknown',
              isDraft: false,
              reviewDecision: '',
              checks: 'none',
              checksTotal: 0,
              checksFailed: 0,
              checksPending: 0,
              fetchedAt: Date.now(),
              error
            })
            return
          }
          try {
            const d = JSON.parse(stdout)
            const rollup: RollupNode[] = Array.isArray(d.statusCheckRollup) ? d.statusCheckRollup : []
            resolve({
              url,
              number: typeof d.number === 'number' ? d.number : numberFromUrl,
              state: normalizeState(d.state),
              isDraft: !!d.isDraft,
              reviewDecision: typeof d.reviewDecision === 'string' ? d.reviewDecision : '',
              ...summarizeChecks(rollup),
              fetchedAt: Date.now()
            })
          } catch {
            resolve(null) // torn/unexpected output — keep the previous entry
          }
        }
      )
    })
  }
}
