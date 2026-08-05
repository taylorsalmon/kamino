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
  /** last size reported to the PTY — a ConPTY resize forces the CLI to
   *  redraw its composer, which can visibly mangle text being typed, so we
   *  never send one unless the grid dimensions actually changed */
  lastCols?: number
  lastRows?: number
}

const registry = new Map<string, TermEntry>()
let wired = false
let fontSize = 13

/** how long an exited terminal's buffer sticks around before disposal */
const EXIT_DISPOSE_MS = 60_000

/** The CLI paints for its own theme (~/.claude.json, absent = dark); the
 *  terminal background must match or its art renders unreadably. */
const THEMES = {
  light: {
    background: '#fdf6e3',
    foreground: '#33302a',
    cursor: '#d97757',
    cursorAccent: '#fdf6e3',
    selectionBackground: '#e8dcb8',
    black: '#33302a',
    red: '#cc3a2a',
    green: '#2f8f3e',
    yellow: '#b07d00',
    blue: '#1f6fc2',
    magenta: '#b13a86',
    cyan: '#14918a',
    white: '#efe6cd',
    brightBlack: '#7a7156',
    brightRed: '#e0432f',
    brightGreen: '#3aa04a',
    brightYellow: '#c28e00',
    brightBlue: '#2f83d6',
    brightMagenta: '#c94a99',
    brightCyan: '#17a89f',
    brightWhite: '#fdf6e3'
  },
  dark: {
    background: '#0f141a',
    foreground: '#d5dde5',
    cursor: '#d97757',
    cursorAccent: '#0f141a',
    selectionBackground: '#2f3b48',
    black: '#1c242e',
    red: '#ff5d5d',
    green: '#5fb88a',
    yellow: '#e5a83b',
    blue: '#5aa7e0',
    magenta: '#c792ea',
    cyan: '#56c8bc',
    white: '#d5dde5',
    brightBlack: '#7c8894',
    brightRed: '#ff7d7d',
    brightGreen: '#7fd0a4',
    brightYellow: '#efc06b',
    brightBlue: '#82c0ee',
    brightMagenta: '#d7aef2',
    brightCyan: '#7edcd2',
    brightWhite: '#f0f4f8'
  }
} as const

let cliTheme: keyof typeof THEMES = 'dark'
applyTermBg()
void window.fleet.claudeTheme().then((t) => {
  cliTheme = t
  applyTermBg()
  // retheme terminals created before the answer arrived
  for (const e of registry.values()) e.term.options.theme = THEMES[cliTheme]
})

/** keeps the container padding around each terminal the same color as it */
function applyTermBg(): void {
  document.documentElement.style.setProperty('--term-bg', THEMES[cliTheme].background)
}

function wireGlobalListeners(): void {
  if (wired) return
  wired = true
  // a file dropped outside a terminal must never navigate the window to it
  // (Chromium's default) — swallow file drags everywhere; terminals opt in below
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  })
  window.addEventListener('drop', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  })
  window.fleet.onPtyData((ptyId, data) => {
    registry.get(ptyId)?.term.write(data)
  })
  window.fleet.onPtyExit((ptyId, exitCode) => {
    const e = registry.get(ptyId)
    if (e) {
      e.exited = true
      e.term.write(`\r\n\x1b[38;5;245m— session ended (exit ${exitCode}) —\x1b[0m\r\n`)
      // free the terminal once its pane has gone (ptyIds are never reused) —
      // otherwise every decommissioned clone's scrollback buffer stays in the
      // registry for the app's lifetime. The delay keeps the ended message
      // readable while the pane is still on screen.
      setTimeout(() => disposeTerminal(ptyId), EXIT_DISPOSE_MS)
    }
  })
}

/** Windows Terminal clipboard conventions: Ctrl+C copies when text is
 *  selected (else passes ^C through), Ctrl+V pastes text — or forwards the
 *  keystroke when the clipboard holds no text, so Claude Code can grab
 *  images from the clipboard itself. Ctrl+Shift+C/V always copy/paste.
 *  Right-click: copy the selection if there is one, otherwise paste. */
function wireClipboard(ptyId: string, term: Terminal, host: HTMLDivElement): void {
  const copySelection = (): void => {
    void navigator.clipboard.writeText(term.getSelection())
    term.clearSelection()
  }
  const pasteText = (fallbackKeystroke?: string): void => {
    void navigator.clipboard.readText().then((t) => {
      if (t) term.paste(t)
      else if (fallbackKeystroke) window.fleet.ptyInput(ptyId, fallbackKeystroke)
    })
  }

  term.attachCustomKeyEventHandler((e) => {
    // F2 flips Terminal ⇄ Intel even while the terminal owns the keyboard
    if (e.type === 'keydown' && e.key === 'F2') {
      window.dispatchEvent(new Event('kamino:toggle-info'))
      return false
    }
    if (e.type === 'keydown' && e.key === 'F1' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      window.dispatchEvent(new CustomEvent('kamino:action', { detail: 'cheats' }))
      return false
    }
    // Ctrl+Shift+letter fleet actions — codes must stay in sync with App's
    // CHORDS map and the CheatSheet rows. C/V stay with the terminal (copy
    // & paste below).
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
      const chord = { KeyG: 'flipView', KeyN: 'launch', KeyD: 'density', KeyS: 'sweep' }[e.code]
      if (chord) {
        window.dispatchEvent(new CustomEvent('kamino:action', { detail: chord }))
        return false
      }
    }
    // fleet navigation works even while a terminal owns the keyboard:
    // Ctrl+1..9 jumps to that slot, Ctrl+` to the next clone awaiting orders
    if (e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const digit = /^Digit([1-9])$/.exec(e.code)
      if (digit) {
        window.dispatchEvent(new CustomEvent('kamino:focus-slot', { detail: Number(digit[1]) - 1 }))
        return false
      }
      if (e.code === 'Backquote') {
        window.dispatchEvent(new Event('kamino:next-ask'))
        return false
      }
    }
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true
    if (e.code === 'KeyC' && (e.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) copySelection()
      else return true // Ctrl+Shift+C with nothing selected — don't blank the clipboard
      return false
    }
    if (e.code === 'KeyV') {
      // preventDefault, or the browser ALSO delivers a native paste event to
      // xterm's textarea and the clipboard lands twice
      e.preventDefault()
      pasteText(e.shiftKey ? undefined : '\x16')
      return false
    }
    return true
  })

  host.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (term.hasSelection()) copySelection()
    else pasteText()
  })
}

/** Drop files from Explorer onto a terminal → paste their paths (quoted when
 *  they hold spaces), like Windows Terminal — so Claude Code can pick them up. */
function wireFileDrop(term: Terminal, host: HTMLDivElement): void {
  host.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  })
  host.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files
    if (!files?.length) return
    e.preventDefault()
    const text = Array.from(files)
      .map((f) => window.fleet.pathForFile(f))
      .filter(Boolean)
      .map((p) => (/\s/.test(p) ? `"${p}"` : p))
      .join(' ')
    if (!text) return
    term.paste(text + ' ')
    term.focus()
  })
}

export function getOrCreateTerminal(ptyId: string): TermEntry {
  wireGlobalListeners()
  let entry = registry.get(ptyId)
  if (entry) return entry

  const term = new Terminal({
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
    fontSize,
    lineHeight: 1.15,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 20000,
    // the CLI paints much of its UI in its own truecolor, which we can't
    // theme — but xterm can force washed-out text up to readable contrast
    minimumContrastRatio: 4.5,
    theme: THEMES[cliTheme]
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, url) => window.fleet.openExternal(url)))
  term.onData((data) => window.fleet.ptyInput(ptyId, data))

  const host = document.createElement('div')
  host.className = 'term-host'
  wireClipboard(ptyId, term, host)
  wireFileDrop(term, host)
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

/** give a pane's terminal the keyboard and bring it into view */
export function focusTerminal(ptyId: string): void {
  const e = registry.get(ptyId)
  if (!e) return
  e.term.focus()
  e.host.scrollIntoView({ block: 'nearest' })
}

/** grid density: smaller glyphs fit more clones per screen. Applies to every
 *  live terminal and becomes the default for ones created later. */
export function setTermFontSize(px: number): void {
  if (px === fontSize) return
  fontSize = px
  for (const [id, e] of registry) {
    e.term.options.fontSize = px
    fitAndReport(id)
  }
}

export function fitAndReport(ptyId: string): void {
  const e = registry.get(ptyId)
  if (!e || e.exited) return
  e.fit.fit()
  const { cols, rows } = e.term
  if (cols === e.lastCols && rows === e.lastRows) return
  e.lastCols = cols
  e.lastRows = rows
  window.fleet.ptyResize(ptyId, cols, rows)
}
