/**
 * Watching a clone's transcript for a marked block it was ordered to write.
 *
 * Two features need the same trick: a handoff brief, and an arbiter's verdict.
 * In both cases Kamino types an order into a terminal and then has to know when
 * the answer is finished — and the only channel back is the session transcript
 * on disk. Markers are what make that reliable: a streamed reply lands as
 * several records that each grow the same text, so "has it finished" cannot be
 * answered by the presence of text, only by the closing marker.
 *
 * Reading starts from a byte offset captured BEFORE the order goes in, so an
 * older marked block earlier in the same session can never be mistaken for this
 * one.
 */
import * as fs from 'node:fs'
import { describeAssistant, parseRecord } from './claude-data'

/** never read more than this much new transcript in one pass */
const MAX_TAIL = 4 * 1024 * 1024

export function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** New transcript bytes since `offset`, capped — '' when nothing grew. */
export function readSince(file: string, offset: number): string {
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    return ''
  }
  if (size <= offset) return ''
  const start = size - offset > MAX_TAIL ? size - MAX_TAIL : offset
  let text: string
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf-8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
  if (start > offset) {
    // we skipped ahead — the first line is torn mid-record
    const nl = text.indexOf('\n')
    text = nl < 0 ? '' : text.slice(nl + 1)
  }
  return text
}

export interface Marked {
  /** text between the markers, or the whole reply when falling back */
  text: string
  /** the closing marker arrived — the block is complete */
  complete: boolean
}

/**
 * Pull a marked block out of the assistant records in `chunk`. The LAST
 * candidate wins, since a streamed reply rewrites the same text as it grows —
 * which also makes this a live progress read while the clone is still typing.
 *
 * `fallback` decides what an unmarked reply means. A handoff brief takes it
 * (a long partial beats nothing when the clock runs out); a verdict must not,
 * because half a JSON object is worse than none.
 */
export function findMarked(
  chunk: string,
  start: string,
  end: string,
  opts?: { fallback?: boolean }
): Marked | null {
  let marked: string | null = null
  let anyText: string | null = null
  for (const line of chunk.split('\n')) {
    const rec = parseRecord(line)
    if (!rec || rec.type !== 'assistant' || rec.isSidechain) continue
    const text = describeAssistant(rec)?.text
    if (!text) continue
    anyText = text
    if (text.includes(start)) marked = text
  }
  if (marked) {
    const body = marked.slice(marked.indexOf(start) + start.length)
    const close = body.indexOf(end)
    return close >= 0
      ? { text: body.slice(0, close).trim(), complete: true }
      : { text: body.trim(), complete: false }
  }
  if (opts?.fallback && anyText) return { text: anyText.trim(), complete: false }
  return null
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
