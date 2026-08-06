/**
 * Reincarnation — hand a rotting clone's working state over to a fresh one.
 *
 * Auto-compact is the CLI's own answer to a full context window: it squashes
 * the conversation into a summary you never see, at a moment you don't pick.
 * A handoff is that same lossy step taken deliberately, and it wins on three
 * counts: the brief is written while there's still headroom (not at 100%, when
 * replies are already degrading), you get to read it, and the successor starts
 * on a clean window with a fresh system prompt — so it re-grounds itself in
 * the repo instead of trusting a summary. Detail the brief missed is still on
 * disk; detail a compaction dropped is gone.
 *
 * The pipeline runs itself: order the brief → watch the transcript for it →
 * commission a successor in the same folder → paste the brief in as its first
 * orders. Only embedded clones can be handed off — Kamino has no input channel
 * into a terminal it didn't spawn.
 */
import { EventEmitter } from 'node:events'
import { transcriptPath } from './claude-data'
import { fileSize, findMarked, readSince, sleep, type Marked } from './marker-watch'
import type { InstanceStore } from './instance-store'
import type { PtyManager } from './pty-manager'
import type { HandoffProgress } from '../shared/types'

const START = '===KAMINO-HANDOFF-START==='
const END = '===KAMINO-HANDOFF-END==='

/** How long to wait for the brief. Generous: the order queues behind whatever
 *  turn the clone is already running. */
const BRIEF_TIMEOUT_MS = 300_000
const POLL_MS = 800
/** a new clone is ready for input once its output has been quiet this long */
const READY_QUIET_MS = 1500
const READY_TIMEOUT_MS = 30_000

/** The order that produces the brief. One line — it goes into the CLI
 *  composer as a single prompt, and queues if the clone is mid-turn. */
const HANDOFF_ORDER =
  'Your context window is nearly full, so this work is being handed to a fresh clone that continues it ' +
  'in this same folder with NO memory of this conversation. Write that clone its handoff brief. Output ' +
  `ONLY the brief, wrapped exactly between ${START} and ${END} — no preamble, no closing remarks, and do ` +
  'not run any tools first. Write it as orders TO your successor under these headings: GOAL (what we are ' +
  'ultimately trying to achieve); DONE (what is finished and verified, with file paths); IN FLIGHT (exactly ' +
  'where you are mid-task right now); NEXT (the next concrete steps, in order); DECISIONS (choices already ' +
  'made and approaches already rejected, so they are not relitigated); GOTCHAS (constraints, failures ' +
  'already hit, and preferences the user has stated this session); FILES (the handful of files to read ' +
  'first to get re-grounded). Be specific — name files, commands, branches, exact error text. Do not ' +
  'summarise our conversation; transfer the working state.'

function successorOrders(brief: string, repo: string): string {
  return (
    `You are taking over an in-progress task in ${repo} from a previous Claude Code session whose context ` +
    'window filled up. Below is the handoff brief it wrote for you. Read the files it names to re-ground ' +
    'yourself in the current state before you change anything, then carry on from its NEXT section. Treat ' +
    'the brief as what happened, but verify the state on disk — the code is the truth, the brief is a ' +
    'pointer.\n\n' +
    brief
  )
}

/** the unmarked fallback is kept as the TIMEOUT answer, never as a completion */
function findBrief(chunk: string): Marked | null {
  return findMarked(chunk, START, END, { fallback: true })
}

interface Run {
  cancelled: boolean
}

export class HandoffRunner extends EventEmitter {
  private active = new Map<string, Run>()

  constructor(
    private ptys: PtyManager,
    private store: InstanceStore
  ) {
    super()
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  cancel(sessionId: string): void {
    const run = this.active.get(sessionId)
    if (run) run.cancelled = true
  }

  /** the in-place alternative: let the CLI squash its own history */
  compact(sessionId: string): boolean {
    const ptyId = this.ptyIdFor(sessionId)
    if (!ptyId) return false
    this.ptys.write(ptyId, '/compact\r')
    return true
  }

  private ptyIdFor(sessionId: string): string | null {
    const inst = this.store.get(sessionId)
    return inst ? this.ptys.ptyIdForPid(inst.pid) : null
  }

  private emitProgress(p: HandoffProgress): void {
    this.emit('progress', p)
  }

  async run(sessionId: string, opts: { killOld: boolean }): Promise<void> {
    if (this.active.has(sessionId)) return
    const run: Run = { cancelled: false }
    this.active.set(sessionId, run)
    try {
      const inst = this.store.get(sessionId)
      if (!inst) throw new Error('That clone is no longer on the board.')
      const oldPtyId = this.ptys.ptyIdForPid(inst.pid)
      if (!oldPtyId) {
        throw new Error(
          "This clone runs outside Kamino — there's no way to type the order into its terminal. Hand off from an in-bay clone, or compress in place from its own window."
        )
      }

      // watch only what arrives after the order, so an earlier brief in this
      // session's history can't be mistaken for this one
      const file = transcriptPath(inst.cwd, sessionId)
      const offset = fileSize(file)
      this.ptys.write(oldPtyId, HANDOFF_ORDER + '\r')
      this.emitProgress({ sessionId, stage: 'briefing' })

      const found = await this.awaitBrief(sessionId, file, offset, run)
      if (run.cancelled) return
      this.emitProgress({ sessionId, stage: 'brief', brief: found.text, partial: !found.complete })

      const successor = this.ptys.spawn({
        cwd: inst.cwd,
        permissionMode: inst.permissionMode
      })
      this.emitProgress({
        sessionId,
        stage: 'commissioning',
        brief: found.text,
        partial: !found.complete,
        successor
      })

      await this.awaitReady(successor.ptyId, run)
      if (run.cancelled) return
      this.emitProgress({ sessionId, stage: 'seeding', brief: found.text, successor })
      this.paste(successor.ptyId, successorOrders(found.text, inst.repo))

      if (opts.killOld) this.ptys.kill(oldPtyId)
      this.emitProgress({
        sessionId,
        stage: 'done',
        brief: found.text,
        partial: !found.complete,
        successor,
        killedOld: opts.killOld
      })
    } catch (err) {
      if (!run.cancelled) {
        this.emitProgress({
          sessionId,
          stage: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    } finally {
      this.active.delete(sessionId)
    }
  }

  /** poll the transcript until the closing marker lands, streaming progress */
  private async awaitBrief(
    sessionId: string,
    file: string,
    offset: number,
    run: Run
  ): Promise<Marked> {
    const deadline = Date.now() + BRIEF_TIMEOUT_MS
    let last: Marked | null = null
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      if (run.cancelled) throw new Error('cancelled')
      const found = findBrief(readSince(file, offset))
      if (found) {
        if (found.complete) return found
        if (found.text !== last?.text) {
          this.emitProgress({ sessionId, stage: 'briefing', brief: found.text, partial: true })
        }
        last = found
      }
    }
    // out of time: a long partial still beats nothing — it goes to the
    // successor flagged as partial so the dialog can say so
    if (last && last.text.length >= 200) return last
    throw new Error(
      "The clone didn't produce a brief in time. It may be stuck waiting on a permission prompt in its own terminal — check it, then try again."
    )
  }

  /** a freshly spawned CLI eats input sent before it has painted its composer */
  private async awaitReady(ptyId: string, run: Run): Promise<void> {
    let lastData = 0
    const onData = (id: string): void => {
      if (id === ptyId) lastData = Date.now()
    }
    this.ptys.on('data', onData)
    try {
      const deadline = Date.now() + READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        await sleep(250)
        if (run.cancelled) throw new Error('cancelled')
        if (lastData && Date.now() - lastData > READY_QUIET_MS) return
      }
    } finally {
      this.ptys.off('data', onData)
    }
  }

  /** bracketed paste, so the brief's newlines land as text instead of a dozen
   *  premature submits — same path a real Ctrl+V takes */
  private paste(ptyId: string, text: string): void {
    const body = text.replace(/\r\n?/g, '\n').trim()
    this.ptys.write(ptyId, `\x1b[200~${body}\x1b[201~`)
    setTimeout(() => this.ptys.write(ptyId, '\r'), 400)
  }
}
