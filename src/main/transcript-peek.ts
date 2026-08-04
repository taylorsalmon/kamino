/**
 * transcript-peek — on-demand read of the last few exchanges of a session's
 * transcript, for the hover peek in the grid. Reads only the file tail (the
 * transcript can be MBs; the peek needs the last handful of lines), so it's
 * cheap enough to call on every hover.
 */
import * as fs from 'node:fs'
import { describeAssistant, extractUserPrompt, parseRecord, transcriptPath } from './claude-data'
import type { TranscriptTailMsg } from '../shared/types'

const TAIL_BYTES = 256 * 1024

export function transcriptTail(cwd: string, sessionId: string, limit = 6): TranscriptTailMsg[] {
  const file = transcriptPath(cwd, sessionId)
  let chunk: string
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - TAIL_BYTES)
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      chunk = buf.toString('utf-8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
  const lines = chunk.split('\n')
  if (lines.length > 0) lines.shift() // first line is likely torn mid-record

  const msgs: TranscriptTailMsg[] = []
  for (const line of lines) {
    const rec = parseRecord(line)
    if (!rec || rec.isSidechain) continue
    const at = rec.timestamp ? Date.parse(rec.timestamp) : undefined
    if (rec.type === 'user') {
      const prompt = extractUserPrompt(rec)
      if (prompt) msgs.push({ who: 'you', text: prompt, at })
    } else if (rec.type === 'assistant') {
      const d = describeAssistant(rec)
      if (d?.text) {
        // streamed replies land as several records growing the same text —
        // collapse them so the peek shows finished messages, not drafts
        const last = msgs[msgs.length - 1]
        if (last?.who === 'clone' && d.text.startsWith(last.text.slice(0, 40))) {
          last.text = d.text
          last.at = at ?? last.at
        } else {
          msgs.push({ who: 'clone', text: d.text, at })
        }
      }
    }
  }
  return msgs.slice(-limit)
}
