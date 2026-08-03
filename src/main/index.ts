import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { InstanceStore } from './instance-store'
import { PtyManager } from './pty-manager'
import { HookServer, type HookEvent } from './hook-server'
import { hooksInstalled, installHooks } from './hook-installer'
import { recentProjects, recentSessions } from './recents'
import { recap } from './recap'
import type { LaunchRequest } from '../shared/types'

const store = new InstanceStore()
const ptys = new PtyManager()
const hookServer = new HookServer()
let win: BrowserWindow | null = null

const LONG_TURN_MS = 30_000

// one Fleet only — a second launch (auto-start + shortcut) would fight over port 47831
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

function notify(title: string, body: string, sessionId: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, silent: false })
  n.on('click', () => {
    win?.show()
    win?.focus()
    broadcast('ui:select-session', sessionId)
  })
  n.show()
}

function shouldToast(sessionId: string): boolean {
  // stay quiet when the user is already looking at this instance
  return !(win?.isFocused() && lastSelectedSession === sessionId)
}

let lastSelectedSession: string | null = null

function onHook(ev: HookEvent): void {
  const inst = store.get(ev.sessionId)
  switch (ev.kind) {
    case 'notification': {
      const reason = ev.message || 'needs your input'
      store.setNeedsYou(ev.sessionId, reason)
      if (shouldToast(ev.sessionId)) {
        notify(`${inst?.name ?? 'Clone'} awaits orders`, reason, ev.sessionId)
      }
      break
    }
    case 'stop': {
      const turnStartedAt = inst?.now.turnStartedAt
      store.clearNeedsYou(ev.sessionId, 'idle')
      if (
        inst &&
        turnStartedAt &&
        Date.now() - turnStartedAt > LONG_TURN_MS &&
        shouldToast(ev.sessionId)
      ) {
        notify(`${inst.name} — mission complete`, inst.now.title || 'Another happy landing.', ev.sessionId)
      }
      break
    }
    case 'prompt':
      store.clearNeedsYou(ev.sessionId, 'busy')
      break
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#f4efe6', // matches the light theme (renderer default)
    title: 'Kamino',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win?.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, ...args)
}

app.whenReady().then(() => {
  app.setAppUserModelId('au.com.lkg.kamino') // Windows toast identity
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true })
  store.setEmbeddedPidSource(() => ptys.pids())
  store.start()
  store.on('snapshot', (snap) => broadcast('fleet:snapshot', snap))
  hookServer.start()
  hookServer.on('hook', onHook)

  ptys.on('data', (ptyId: string, data: string) => broadcast('pty:data', ptyId, data))
  ptys.on('exit', (ptyId: string, exitCode: number) => broadcast('pty:exit', ptyId, exitCode))

  // ── fleet ────────────────────────────────────────────────────────────
  ipcMain.handle('fleet:get', () => store.snapshot())

  // the CLI paints for its own theme; the embedded terminal must match it.
  // Claude Code stores it in ~/.claude.json ("theme"); absent = dark.
  ipcMain.handle('claude:theme', () => {
    try {
      const raw = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8')
      const theme = JSON.parse(raw).theme
      return typeof theme === 'string' && theme.includes('light') ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })

  // ── ptys ─────────────────────────────────────────────────────────────
  ipcMain.handle('pty:spawn', (_e, req: LaunchRequest) => {
    return ptys.spawn({
      cwd: req.cwd,
      resumeSessionId: req.resumeSessionId,
      initialPrompt: req.initialPrompt,
      permissionMode: req.permissionMode
    })
  })
  ipcMain.on('pty:input', (_e, ptyId: string, data: string) => ptys.write(ptyId, data))
  ipcMain.on('pty:resize', (_e, ptyId: string, cols: number, rows: number) =>
    ptys.resize(ptyId, cols, rows)
  )
  ipcMain.handle('pty:kill', (_e, ptyId: string) => ptys.kill(ptyId))
  ipcMain.handle('pty:backlog', (_e, ptyId: string) => ptys.backlog(ptyId))
  ipcMain.handle('pty:list', () => ptys.list())

  // ── launch/resume pickers ────────────────────────────────────────────
  ipcMain.handle('projects:recent', () => recentProjects())
  ipcMain.handle('sessions:recent', () =>
    recentSessions({ excludeSessionIds: store.liveSessionIds() })
  )
  ipcMain.handle('dialog:pick-folder', async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  // ── recap ────────────────────────────────────────────────────────────
  ipcMain.handle('recap:get', async (_e, sessionId: string) => {
    const inst = store.get(sessionId)
    if (!inst) throw new Error('unknown session')
    return recap(sessionId, inst.cwd)
  })

  // ── hooks ────────────────────────────────────────────────────────────
  ipcMain.handle('hooks:status', () => hooksInstalled())
  ipcMain.handle('hooks:install', () => installHooks())
  ipcMain.on('ui:selected', (_e, sessionId: string | null) => {
    lastSelectedSession = sessionId
  })

  // ── misc ─────────────────────────────────────────────────────────────
  ipcMain.handle('open:external', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
  })
  ipcMain.handle('open:path', (_e, p: string) => {
    if (typeof p === 'string') shell.openPath(p)
  })
  ipcMain.handle('kill:pid', (_e, pid: number) => {
    // external instances aren't our PTY children — only allow pids that are
    // known live Claude sessions, never arbitrary processes
    if (typeof pid !== 'number' || store.sessionIdForPid(pid) === null) return false
    try {
      process.kill(pid)
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('open:vscode', (_e, p: string) => {
    if (typeof p !== 'string') return
    spawn('cmd.exe', ['/c', 'code', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  ptys.disposeAll()
  store.stop()
  app.quit()
})
