import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { spawn } from 'node:child_process'
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
        notify(`${inst?.name ?? 'Claude'} needs you`, reason, ev.sessionId)
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
        notify(`${inst.name} finished`, inst.now.title || 'Turn complete', ev.sessionId)
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
    backgroundColor: '#0b0f14',
    title: 'Claude Fleet',
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
  app.setAppUserModelId('com.lkg.claude-fleet') // Windows toast identity
  store.setEmbeddedPidSource(() => ptys.pids())
  store.start()
  store.on('snapshot', (snap) => broadcast('fleet:snapshot', snap))
  hookServer.start()
  hookServer.on('hook', onHook)

  ptys.on('data', (ptyId: string, data: string) => broadcast('pty:data', ptyId, data))
  ptys.on('exit', (ptyId: string, exitCode: number) => broadcast('pty:exit', ptyId, exitCode))

  // ── fleet ────────────────────────────────────────────────────────────
  ipcMain.handle('fleet:get', () => store.snapshot())

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
