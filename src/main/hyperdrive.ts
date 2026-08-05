/**
 * Hyperdrive — automatic fixes, dispatched to the clone that raised the PR.
 *
 * Scope is deliberately narrow. Every trigger here is a FACT reported by
 * GitHub — checks are red, the branch no longer merges — never an inference
 * about what a clone is probably doing. Guessing "is it stuck?" or "should it
 * hand off?" means sometimes interrupting a clone that was working fine, and
 * one wrong interruption costs more trust than ten right ones earn.
 *
 * It exists because a clone ends its turn the moment it opens the PR, and CI
 * takes minutes: by the time the checks fail the clone is idle and nothing
 * wakes it. With several clones shipping into one repo it is worse — the first
 * PR to merge leaves every other branch conflicting, and they all sit there.
 *
 * Rules that keep it trustworthy:
 *  - acts on an observed TRANSITION only, never on first sight, so a restart
 *    never re-dispatches against PRs that were already red hours ago
 *  - an intent it cannot deliver is kept, not dropped, and retried when the
 *    clone becomes reachable
 *  - capped attempts per PR per kind, reset only when the PR recovers
 *  - every action and every skip is logged
 */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import type {
  HyperdriveEvent,
  HyperdriveKind,
  HyperdriveSettings,
  HyperdriveState,
  PrStatus,
  PrStatusMap
} from '../shared/types'

const LOG_LIMIT = 200
const DEFAULTS: HyperdriveSettings = { ci: false, conflict: false, maxAttempts: 2 }

/** The clone that owns a PR, and whether we can actually type into it. */
export interface PrOwner {
  sessionId: string
  name: string
  /** null when the clone runs outside Kamino — nothing to write to */
  ptyId: string | null
  /** blocked on a real decision of yours; orders would queue behind it */
  awaitingUser: boolean
  alive: boolean
}

export interface HyperdriveDeps {
  /** who raised this PR, or null if no live clone claims it */
  ownerOf: (prUrl: string) => PrOwner | null
  /** deliver orders into a clone's terminal */
  send: (ptyId: string, text: string) => void
}

function ciOrders(pr: PrStatus): string {
  return (
    `Hyperdrive: CI is failing on PR #${pr.number} (${pr.url}) — ` +
    `${pr.checksFailed} check${pr.checksFailed === 1 ? '' : 's'} red. Find the real cause: get the failing logs ` +
    `(gh pr checks ${pr.url}, then gh run view --log-failed on the failing run), fix what actually broke, then ` +
    `commit and push. Do not disable, skip, weaken or delete tests to make them pass, and do not force-push. ` +
    `If the failure is not caused by your change, or you cannot reproduce it, stop and say so plainly rather ` +
    `than guessing at a fix.`
  )
}

function conflictOrders(pr: PrStatus): string {
  const base = pr.baseRef || 'the base branch'
  return (
    `Hyperdrive: PR #${pr.number} (${pr.url}) no longer merges into ${base} — another branch landed first. ` +
    `Resolve it: fetch origin, then merge origin/${base} into this branch. Merge, do not rebase, and never ` +
    `force-push — this branch is already pushed and may be shared. Resolve each conflict by keeping BOTH ` +
    `intents where they are compatible; the other change is somebody else's finished work, so do not discard ` +
    `it to make the conflict go away. Run the tests afterwards, then commit and push. If a conflict is a real ` +
    `design clash you cannot settle safely, stop and say which files and why.`
  )
}

interface Attempt {
  ci: number
  conflict: number
}

interface Intent {
  prUrl: string
  kind: HyperdriveKind
  since: number
}

export class Hyperdrive extends EventEmitter {
  private settings: HyperdriveSettings = { ...DEFAULTS }
  private attempts = new Map<string, Attempt>() // key: prUrl
  private intents = new Map<string, Intent>() // key: `${prUrl}|${kind}`
  private prev = new Map<string, PrStatus>() // last status we saw per PR
  private log: HyperdriveEvent[] = []
  private dispatched = 0
  private seq = 0

  constructor(
    private readonly deps: HyperdriveDeps,
    private readonly settingsPath?: string
  ) {
    super()
    if (settingsPath) {
      try {
        const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        this.settings = {
          ci: raw?.ci === true,
          conflict: raw?.conflict === true,
          maxAttempts: Number.isInteger(raw?.maxAttempts) ? Math.min(5, Math.max(1, raw.maxAttempts)) : DEFAULTS.maxAttempts
        }
        if (typeof raw?.dispatched === 'number') this.dispatched = raw.dispatched
      } catch {
        /* first run — both behaviours stay off until asked for */
      }
    }
  }

  getState(): HyperdriveState {
    return {
      settings: { ...this.settings },
      events: this.log,
      pending: [...this.intents.values()].map((i) => ({ prUrl: i.prUrl, kind: i.kind, since: i.since })),
      dispatched: this.dispatched
    }
  }

  setSettings(next: Partial<HyperdriveSettings>): HyperdriveSettings {
    if (typeof next.ci === 'boolean') this.settings.ci = next.ci
    if (typeof next.conflict === 'boolean') this.settings.conflict = next.conflict
    if (Number.isInteger(next.maxAttempts)) {
      this.settings.maxAttempts = Math.min(5, Math.max(1, next.maxAttempts as number))
    }
    // turning a behaviour off drops its outstanding intents rather than firing
    // them later when you have stopped expecting it
    for (const [key, intent] of this.intents) {
      if (!this.enabled(intent.kind)) this.intents.delete(key)
    }
    this.persist()
    this.emit('change')
    return { ...this.settings }
  }

  private enabled(kind: HyperdriveKind): boolean {
    return kind === 'ci' ? this.settings.ci : this.settings.conflict
  }

  private persist(): void {
    if (!this.settingsPath) return
    try {
      fs.writeFileSync(this.settingsPath, JSON.stringify({ ...this.settings, dispatched: this.dispatched }))
    } catch {
      /* preference only */
    }
  }

  /**
   * Fold in a PR status sweep: note transitions, then try to deliver anything
   * outstanding. Called on every poll, so it must be cheap and idempotent.
   */
  onPrStatus(map: PrStatusMap): void {
    for (const [url, pr] of Object.entries(map)) {
      const before = this.prev.get(url)
      this.prev.set(url, pr)
      // stale carry-forward entries say nothing new about the PR's real state
      if (pr.stale || pr.error) continue
      if (pr.state !== 'open') {
        // merged or closed: forget it entirely, including its attempt budget
        this.intents.delete(`${url}|ci`)
        this.intents.delete(`${url}|conflict`)
        this.attempts.delete(url)
        continue
      }
      if (!before) continue // first sight — never act on history we just loaded

      if (pr.checks === 'fail' && before.checks !== 'fail') this.raise(url, 'ci', pr)
      if (pr.checks === 'pass' && before.checks === 'fail') this.recover(url, 'ci')

      if (pr.mergeable === 'conflicting' && before.mergeable !== 'conflicting') {
        this.raise(url, 'conflict', pr)
      }
      if (pr.mergeable === 'mergeable' && before.mergeable === 'conflicting') {
        this.recover(url, 'conflict')
      }
    }
    this.drain(map)
  }

  private raise(prUrl: string, kind: HyperdriveKind, pr: PrStatus): void {
    if (!this.enabled(kind)) return
    const key = `${prUrl}|${kind}`
    if (this.intents.has(key)) return
    this.intents.set(key, { prUrl, kind, since: Date.now() })
    void pr
  }

  /** The PR came good — clear the intent and give back the attempt budget, so a
   *  regression later gets a fresh set of tries. */
  private recover(prUrl: string, kind: HyperdriveKind): void {
    this.intents.delete(`${prUrl}|${kind}`)
    const a = this.attempts.get(prUrl)
    if (a) a[kind] = 0
  }

  /** Try to deliver every outstanding intent. */
  private drain(map: PrStatusMap): void {
    for (const [key, intent] of [...this.intents]) {
      const pr = map[intent.prUrl]
      if (!pr) {
        this.intents.delete(key) // no longer on the board
        continue
      }
      const attempts = this.attempts.get(intent.prUrl) ?? { ci: 0, conflict: 0 }
      if (attempts[intent.kind] >= this.settings.maxAttempts) {
        this.intents.delete(key)
        this.record({ kind: intent.kind, pr, owner: null, attempt: attempts[intent.kind], outcome: 'exhausted' })
        continue
      }

      const owner = this.deps.ownerOf(intent.prUrl)
      const blocked = this.whyBlocked(owner)
      if (blocked) {
        // keep the intent and try again next sweep — but only log the first
        // time, or a long-dead clone would fill the ledger every minute
        if (!this.log.some((e) => e.prUrl === intent.prUrl && e.kind === intent.kind && e.outcome === 'blocked')) {
          this.record({ kind: intent.kind, pr, owner, attempt: attempts[intent.kind], outcome: 'blocked', note: blocked })
        }
        continue
      }

      attempts[intent.kind] += 1
      this.attempts.set(intent.prUrl, attempts)
      this.intents.delete(key)
      const orders = intent.kind === 'ci' ? ciOrders(pr) : conflictOrders(pr)
      this.deps.send(owner!.ptyId!, orders + '\r')
      this.dispatched += 1
      this.persist()
      this.record({ kind: intent.kind, pr, owner, attempt: attempts[intent.kind], outcome: 'sent' })
    }
  }

  private whyBlocked(owner: PrOwner | null): string | null {
    if (!owner) return 'No live clone owns this PR any more — nothing to send orders to.'
    if (!owner.alive) return `${owner.name} has been decommissioned.`
    if (!owner.ptyId) return `${owner.name} runs outside Kamino, so its terminal cannot be typed into.`
    if (owner.awaitingUser) return `${owner.name} is waiting on a decision of yours — holding off until it is free.`
    return null
  }

  private record(args: {
    kind: HyperdriveKind
    pr: PrStatus
    owner: PrOwner | null
    attempt: number
    outcome: HyperdriveEvent['outcome']
    note?: string
  }): void {
    const event: HyperdriveEvent = {
      id: `hd-${++this.seq}`,
      at: Date.now(),
      kind: args.kind,
      prUrl: args.pr.url,
      prNumber: args.pr.number,
      cloneName: args.owner?.name ?? '—',
      sessionId: args.owner?.sessionId ?? '',
      attempt: args.attempt,
      outcome: args.outcome,
      note: args.note
    }
    this.log.unshift(event)
    if (this.log.length > LOG_LIMIT) this.log.pop()
    this.emit('event', event)
  }
}
