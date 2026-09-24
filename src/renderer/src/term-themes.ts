/** Terminal palettes. The CLI paints for its own theme (~/.claude.json, absent
 *  = dark); the terminal background must match or its art renders unreadably.
 *  Shared by the desktop terminals and the phone's screen mirror. */
export const THEMES = {
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
