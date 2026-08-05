/**
 * TranscriptTailer — incremental reader for one session's .jsonl transcript.
 *
 * On attach it catches up on the file's tail to build the session's history
 * (title, PRs, last prompt, turn count), then follows the file by byte offset —
 * appended lines only, never re-reading. Handles torn final lines by buffering
 * the partial tail until the next flush completes it.
 *
 * Reads are synchronous and on the main thread, so no single read may be
 * unbounded: a long session with big tool outputs runs to tens or hundreds of
 * MB, and at startup this happens once per live session. Anything beyond
 * MAX_CATCHUP is skipped — the cost is that a very long session's earliest
 * history (its first title, PRs raised long ago, early turns) is missed, which
 * is a fair trade against freezing the UI and the hook server.
 */
import * as fs from 'node:fs'
import { parseRecord, type TranscriptRecord } from './claude-data'

/** most bytes any one read will pull off disk */
const MAX_CATCHUP = 3 * 1024 * 1024

export class TranscriptTailer {
  private offset = 0
  private partial = ''
  private watcher: fs.StatWatcher | null = null
  private reading = false
  private pendingRead = false

  constructor(
    readonly filePath: string,
    private readonly onRecord: (rec: TranscriptRecord) => void,
    private readonly onFlush: () => void
  ) {}

  /** Read everything currently in the file, then start following. */
  start(): void {
    this.readNew()
    // fs.watch on Windows can miss writes from other processes to files we
    // only stat; watchFile (polling) is dependable and cheap at this scale.
    this.watcher = fs.watchFile(this.filePath, { interval: 700 }, (curr, prev) => {
      if (curr.size !== prev.size || curr.mtimeMs !== prev.mtimeMs) this.readNew()
    })
  }

  stop(): void {
    fs.unwatchFile(this.filePath)
    this.watcher = null
  }

  /** Synchronous catch-up read. Hooks arrive instantly while the file watch
   *  polls at 700ms — call this before deriving state from tailed data. */
  poke(): void {
    this.readNew()
  }

  private readNew(): void {
    if (this.reading) {
      this.pendingRead = true
      return
    }
    this.reading = true
    try {
      let size: number
      try {
        size = fs.statSync(this.filePath).size
      } catch {
        return // file gone (session moved/cleaned) — keep last known state
      }
      if (size < this.offset) {
        // truncated/rewritten (compaction) — restart from scratch
        this.offset = 0
        this.partial = ''
      }
      if (size === this.offset) return

      // skip ahead when there is more to catch up on than we will read in one
      // go — the first surviving line is then torn, so drop it
      let start = this.offset
      let skipTorn = false
      if (size - start > MAX_CATCHUP) {
        start = size - MAX_CATCHUP
        this.partial = ''
        skipTorn = true
      }

      const fd = fs.openSync(this.filePath, 'r')
      try {
        const len = size - start
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, start)
        this.offset = size
        const chunk = this.partial + buf.toString('utf-8')
        const lines = chunk.split('\n')
        if (skipTorn) lines.shift()
        this.partial = lines.pop() ?? '' // last element is '' on a clean trailing \n
        let emitted = false
        for (const line of lines) {
          const rec = parseRecord(line)
          if (rec) {
            this.onRecord(rec)
            emitted = true
          }
        }
        if (emitted) this.onFlush()
      } finally {
        fs.closeSync(fd)
      }
    } finally {
      this.reading = false
      if (this.pendingRead) {
        this.pendingRead = false
        this.readNew()
      }
    }
  }
}
