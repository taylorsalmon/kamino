/**
 * updater — how a running Kamino learns a newer one shipped. Polls the GitHub
 * release feed (latest.yml, uploaded by the release workflow), downloads the
 * installer in the background, verifies it against the feed's sha512, and only
 * then raises the flag — so the click in the banner is always "restart now",
 * never "wait and see". Packaged builds only: dev runs have no app-update.yml
 * and nothing meaningful to update into.
 */
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'

const CHECK_EVERY_MS = 60 * 60_000
/** let startup (store scan, PTY spawns) settle before touching the network */
const FIRST_CHECK_DELAY_MS = 15_000

export class Updater extends EventEmitter {
  private state: UpdateState = { status: 'idle' }
  private timer: NodeJS.Timeout | null = null

  snapshot(): UpdateState {
    return this.state
  }

  start(): void {
    if (!app.isPackaged) return
    autoUpdater.autoDownload = true
    // even a dismissed flag isn't lost — a normal quit installs it on the way out
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-available', (info) =>
      this.set({ status: 'downloading', version: info.version })
    )
    autoUpdater.on('download-progress', (p) =>
      this.set({ ...this.state, status: 'downloading', percent: Math.round(p.percent) })
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ status: 'ready', version: info.version })
    )
    autoUpdater.on('update-not-available', () => this.set({ status: 'idle' }))
    autoUpdater.on('error', (err) => {
      // a failed CHECK is a non-event — the next sweep retries and the running
      // version keeps working. Only a download that began and died is news.
      if (this.state.status !== 'downloading') return
      this.set({
        status: 'error',
        version: this.state.version,
        error: String(err instanceof Error ? err.message : err).slice(0, 160)
      })
    })
    const check = (): void => void autoUpdater.checkForUpdates().catch(() => {})
    setTimeout(check, FIRST_CHECK_DELAY_MS)
    this.timer = setInterval(check, CHECK_EVERY_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Hand over to the staged installer: quit, install silently, relaunch. */
  restart(): void {
    if (this.state.status !== 'ready') return
    autoUpdater.quitAndInstall(true, true)
  }

  private set(next: UpdateState): void {
    this.state = next
    this.emit('state', next)
  }
}
