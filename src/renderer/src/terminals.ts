/**
 * Terminal registry — one long-lived xterm instance per PTY, kept in a
 * detached DOM node so switching cards never loses scrollback. React
 * components adopt/release the node; the Terminal itself is never destroyed
 * until the PTY exits.
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

export interface TermEntry {
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  exited: boolean
}

const registry = new Map<string, TermEntry>()
let wired = false

function wireGlobalListeners(): void {
  if (wired) return
  wired = true
  window.fleet.onPtyData((ptyId, data) => {
    registry.get(ptyId)?.term.write(data)
  })
  window.fleet.onPtyExit((ptyId, exitCode) => {
    const e = registry.get(ptyId)
    if (e) {
      e.exited = true
      e.term.write(`\r\n\x1b[38;5;245m— session ended (exit ${exitCode}) —\x1b[0m\r\n`)
    }
  })
}

export function getOrCreateTerminal(ptyId: string): TermEntry {
  wireGlobalListeners()
  let entry = registry.get(ptyId)
  if (entry) return entry

  const term = new Terminal({
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 20000,
    theme: {
      background: '#0b0f14',
      foreground: '#d5dde5',
      cursor: '#d97757',
      selectionBackground: '#2f3b48',
      black: '#1a2129',
      brightBlack: '#55616d'
    }
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, url) => window.fleet.openExternal(url)))
  term.onData((data) => window.fleet.ptyInput(ptyId, data))

  const host = document.createElement('div')
  host.className = 'term-host'
  term.open(host)

  // restore anything emitted before this terminal existed (e.g. app reload)
  window.fleet.ptyBacklog(ptyId).then((backlog) => {
    if (backlog && term.buffer.active.length <= 1) term.write(backlog)
  })

  entry = { term, fit, host, exited: false }
  registry.set(ptyId, entry)
  return entry
}

export function disposeTerminal(ptyId: string): void {
  const e = registry.get(ptyId)
  if (e) {
    e.term.dispose()
    e.host.remove()
    registry.delete(ptyId)
  }
}

export function fitAndReport(ptyId: string): void {
  const e = registry.get(ptyId)
  if (!e || e.exited) return
  e.fit.fit()
  const { cols, rows } = e.term
  window.fleet.ptyResize(ptyId, cols, rows)
}
