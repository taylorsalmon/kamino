/**
 * openExternal — every URL Kamino hands to the browser goes through here.
 *
 * One click should be one tab. Two paths in this app can reach the browser: the
 * renderer's open:external IPC (PR chips, terminal link clicks) and the window
 * open handler (anything that manages a window.open, e.g. an OSC 8 hyperlink
 * xterm activates itself). A single click that trips both — or any bounced
 * dispatch — opens the same page twice, and the only symptom the user sees is
 * the duplicate tab, with nothing to point at.
 *
 * So: identical URL inside DEDUPE_MS opens once, and every call is written to a
 * log next to the other userData state. Suppressions name the path that got
 * there first, which is what turns "it opened twice again" into a fact.
 */
import { shell } from 'electron'
import * as fs from 'node:fs'

/** Long enough to swallow a double dispatch, short enough that deliberately
 *  reopening the same PR still works. */
const DEDUPE_MS = 1200

/** Above this the log is truncated — it's a breadcrumb trail, not history. */
const MAX_LOG_BYTES = 64 * 1024

export type OpenSource = 'ipc' | 'window-open'

const lastOpened = new Map<string, { at: number; source: OpenSource }>()

let logPath: string | null = null

/** Called once at startup with a path under userData. */
export function setOpenLogPath(p: string): void {
  logPath = p
}

function note(line: string): void {
  if (!logPath) return
  try {
    if ((fs.statSync(logPath).size ?? 0) > MAX_LOG_BYTES) fs.writeFileSync(logPath, '')
  } catch {
    /* no log yet — appendFileSync creates it */
  }
  try {
    fs.appendFileSync(logPath, line + '\n')
  } catch {
    /* logging must never break opening a link */
  }
}

/** Drop entries that can no longer suppress anything. */
function prune(now: number): void {
  if (lastOpened.size < 64) return
  for (const [url, seen] of lastOpened) {
    if (now - seen.at > DEDUPE_MS) lastOpened.delete(url)
  }
}

/**
 * Open a URL in the user's browser unless the same one was just opened.
 * Returns false when the call was suppressed as a duplicate.
 */
export function openExternalOnce(url: unknown, source: OpenSource): boolean {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return false
  const now = Date.now()
  prune(now)
  const prev = lastOpened.get(url)
  lastOpened.set(url, { at: now, source })
  const stamp = new Date(now).toISOString()
  if (prev && now - prev.at < DEDUPE_MS) {
    note(`${stamp} SUPPRESSED ${source} — ${now - prev.at}ms after ${prev.source} — ${url}`)
    return false
  }
  note(`${stamp} OPEN ${source} — ${url}`)
  shell.openExternal(url)
  return true
}
