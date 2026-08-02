/**
 * Recents — recent project folders (from ~/.claude/history.jsonl) and
 * recent/resumable sessions (from transcript files across all project dirs).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CLAUDE_DIR, PROJECTS_DIR, parseRecord } from './claude-data'
import type { RecentProject, RecentSession } from '../shared/types'

export function recentProjects(limit = 12): RecentProject[] {
  const byPath = new Map<string, number>()
  try {
    const lines = fs.readFileSync(path.join(CLAUDE_DIR, 'history.jsonl'), 'utf-8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const d = JSON.parse(line)
        if (typeof d.project === 'string' && d.timestamp) {
          const ts = Number(d.timestamp)
          if (ts > (byPath.get(d.project) ?? 0)) byPath.set(d.project, ts)
        }
      } catch {
        /* torn line */
      }
    }
  } catch {
    return []
  }
  return [...byPath.entries()]
    .filter(([p]) => {
      try {
        return fs.statSync(p).isDirectory()
      } catch {
        return false
      }
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cwd, lastUsed]) => ({ cwd, lastUsed }))
}

/** Scan transcripts (newest first) and summarize each for a resume picker. */
export function recentSessions(opts: { excludeSessionIds: string[]; limit?: number }): RecentSession[] {
  const exclude = new Set(opts.excludeSessionIds)
  const limit = opts.limit ?? 25
  const files: { file: string; mtime: number; sessionId: string }[] = []
  let dirs: string[]
  try {
    dirs = fs.readdirSync(PROJECTS_DIR)
  } catch {
    return []
  }
  for (const dir of dirs) {
    const full = path.join(PROJECTS_DIR, dir)
    let names: string[]
    try {
      names = fs.readdirSync(full)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      if (exclude.has(sessionId)) continue
      try {
        const st = fs.statSync(path.join(full, name))
        if (st.size < 2000) continue // empty/aborted sessions aren't worth resuming
        files.push({ file: path.join(full, name), mtime: st.mtimeMs, sessionId })
      } catch {
        /* skip */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)

  const out: RecentSession[] = []
  for (const f of files) {
    if (out.length >= limit) break
    const s = summarize(f.file, f.sessionId, f.mtime)
    if (s) out.push(s)
  }
  return out
}

/** Read head + tail of a transcript and pull out what the picker needs. */
function summarize(file: string, sessionId: string, mtime: number): RecentSession | null {
  let cwd = ''
  let gitBranch = ''
  let title = ''
  let lastPrompt = ''
  const prs: number[] = []
  try {
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r')
    try {
      const headLen = Math.min(size, 16_384)
      const head = Buffer.alloc(headLen)
      fs.readSync(fd, head, 0, headLen, 0)
      const tailLen = Math.min(size, 32_768)
      const tail = Buffer.alloc(tailLen)
      fs.readSync(fd, tail, 0, tailLen, size - tailLen)
      const lines = [...head.toString('utf-8').split('\n'), ...tail.toString('utf-8').split('\n')]
      for (const line of lines) {
        const rec = parseRecord(line)
        if (!rec) continue
        if (rec.cwd && !cwd) cwd = rec.cwd
        if (rec.gitBranch) gitBranch = rec.gitBranch
        if (rec.type === 'ai-title' && rec.aiTitle) title = rec.aiTitle
        if (rec.type === 'last-prompt' && rec.lastPrompt) lastPrompt = rec.lastPrompt
        if (rec.type === 'pr-link' && typeof rec.prNumber === 'number' && !prs.includes(rec.prNumber)) {
          prs.push(rec.prNumber)
        }
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  if (!cwd) return null // can't resume without knowing where
  return { sessionId, cwd, gitBranch, title, lastPrompt, prs, mtime }
}
