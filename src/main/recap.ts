/**
 * Recap — "Catch me up" on one instance. Distills the transcript tail into a
 * compact digest, then asks Haiku (via `claude -p`, the user's existing auth)
 * for a three-part brief. Cached by transcript size so unchanged sessions
 * never re-summarize.
 *
 * The digest reader depends on which CLI wrote the transcript; the question
 * asked of the model does not, so a Codex clone gets the same brief through the
 * same route.
 */
import * as fs from 'node:fs'
import { runClaude } from './claude-cli'
import { parseRecord, describeAssistant, extractUserPrompt } from './claude-data'
import { codexDigestLines } from './codex-data'
import type { CliKind } from '../shared/types'

export interface RecapResult {
  text: string
  generatedAt: number
  fromCache: boolean
}

interface CacheEntry {
  atSize: number
  text: string
  generatedAt: number
}

const cache = new Map<string, CacheEntry>()
const TAIL_BYTES = 200_000
const MAX_DIGEST_LINES = 80

function claudeDigest(file: string): string[] {
  const size = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  let lines: string[]
  try {
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    lines = buf.toString('utf-8').split('\n')
  } finally {
    fs.closeSync(fd)
  }

  const out: string[] = []
  for (const line of lines) {
    const rec = parseRecord(line)
    if (!rec || rec.isSidechain) continue
    const ts = rec.timestamp ? rec.timestamp.slice(11, 16) : ''
    switch (rec.type) {
      case 'user': {
        const p = extractUserPrompt(rec)
        if (p) out.push(`${ts} USER: ${p.slice(0, 300)}`)
        break
      }
      case 'assistant': {
        const d = describeAssistant(rec)
        if (d?.text) out.push(`${ts} CLAUDE: ${d.text.slice(0, 300)}`)
        else if (d) out.push(`${ts} ACTION: ${d.activity}`)
        break
      }
      case 'ai-title':
        if (rec.aiTitle) out.push(`TITLE: ${rec.aiTitle}`)
        break
      case 'pr-link':
        out.push(`PR OPENED: #${rec.prNumber} ${rec.prUrl}`)
        break
      case 'system':
        if (rec.subtype === 'away_summary' && typeof rec.content === 'string') {
          out.push(`RECAP: ${rec.content}`)
        }
        break
    }
  }
  return out.slice(-MAX_DIGEST_LINES)
}

const PROMPT = `You are summarizing a coding-agent session's transcript digest for its owner, who has been away and wants to catch up fast. The agent's own lines are marked CLAUDE or CODEX depending on which CLI it is.

Reply with EXACTLY this format, plain text, no preamble:
NOW: <one line — what the session is doing or waiting on right now>
DONE: <up to 3 short lines, each starting with "- ", of what it accomplished; include PR numbers if any>
NEEDS: <one line — what it needs from the owner, or "nothing">

Digest (oldest to newest):
`

export async function recap(sessionId: string, file: string, cli: CliKind): Promise<RecapResult> {
  const size = fs.statSync(file).size
  const hit = cache.get(sessionId)
  if (hit && hit.atSize === size) {
    return { text: hit.text, generatedAt: hit.generatedAt, fromCache: true }
  }

  const lines = cli === 'codex' ? codexDigestLines(file, MAX_DIGEST_LINES) : claudeDigest(file)
  const input = PROMPT + lines.join('\n')
  const text = await runClaude(input)
  cache.set(sessionId, { atSize: size, text, generatedAt: Date.now() })
  return { text, generatedAt: Date.now(), fromCache: false }
}
