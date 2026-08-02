import { app, BrowserWindow, ipcMain, shell } from 'electron'
import * as path from 'node:path'
import { InstanceStore } from './instance-store'

const store = new InstanceStore()
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

app.whenReady().then(() => {
  store.start()
  store.on('snapshot', (snap) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('fleet:snapshot', snap)
  })

  ipcMain.handle('fleet:get', () => store.snapshot())
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
  store.stop()
  app.quit()
})
