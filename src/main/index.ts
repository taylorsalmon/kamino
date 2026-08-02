import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import * as path from 'node:path'
import { InstanceStore } from './instance-store'
import { PtyManager } from './pty-manager'
import { recentProjects, recentSessions } from './recents'
import type { LaunchRequest } from '../shared/types'

const store = new InstanceStore()
const ptys = new PtyManager()
let win: BrowserWindow | null = null

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
  store.setEmbeddedPidSource(() => ptys.pids())
  store.start()
  store.on('snapshot', (snap) => broadcast('fleet:snapshot', snap))

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

  // ── misc ─────────────────────────────────────────────────────────────
  ipcMain.handle('open:external', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
  })
  ipcMain.handle('open:path', (_e, p: string) => {
    if (typeof p === 'string') shell.openPath(p)
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
