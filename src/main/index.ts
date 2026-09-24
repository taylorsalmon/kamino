import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { InstanceStore } from './instance-store'
import { PtyManager } from './pty-manager'
import { HookServer, type HookEvent } from './hook-server'
import { hooksInstalled, installHooks, migrateHooks } from './hook-installer'
import { recentProjects, recentSessions } from './recents'
import { recap } from './recap'
import { PrStatusPoller } from './pr-status'
import { raisePr } from './pr-create'
import { transcriptTail } from './transcript-peek'
import { checkRepo } from './wrapup'
import { HandoffRunner } from './handoff'
import { Deconflictor } from './deconflict'
import { createWorktree, ensureWorktreeIgnored } from './worktree'
import { Hyperdrive, type PrOwner } from './hyperdrive'
import { openExternalOnce, setOpenLogPath } from './open-external'
import { Arbiter } from './arbiter'
import { Updater } from './updater'
import { Retitler } from './retitle'
import { Zoom } from './zoom'
import { CliRegistry } from './cli-registry'
import { CodexTracker } from './codex-tracker'
import { RemoteServer } from './remote-server'
import type {
  ArbiterCase,
  ArbiterSettings,
  CliDefinition,
  DeconflictEvent,
  DeconflictMode,
  FleetSnapshot,
  HandoffProgress,
  HyperdriveEvent,
  HyperdriveSettings,
  Instance,
  LaunchRequest,
  PtyInfo,
  RemoteAlert,
  RemoteCli,
  RemoteFleetState,
  RemoteSettings,
  ZoomState
} from '../shared/types'

const store = new InstanceStore(path.join(app.getPath('userData'), 'model-windows.json'))
// which CLIs clones can run on — Claude Code and Codex built in, custom ones saved
const clis = new CliRegistry(path.join(app.getPath('userData'), 'clis.json'))
const ptys = new PtyManager(clis)
// Codex has no session registry, so its embedded clones are bound to their
// rollouts by the tracker instead of by pid
const codex = new CodexTracker(store, ptys)
const hookServer = new HookServer()
const prPoller = new PrStatusPoller()
const handoff = new HandoffRunner(ptys, store)
const deconflictor = new Deconflictor(path.join(app.getPath('userData'), 'airspace.json'))
const arbiter = new Arbiter(
  {
    ptys,
    store,
    exempt: (sessionId) => deconflictor.exemptSession(sessionId),
    unexempt: (sessionId) => deconflictor.unexemptSession(sessionId)
  },
  path.join(app.getPath('userData'), 'arbiter.json')
)
deconflictor.setArbiterEnabled(arbiter.isEnabled())

/** Which live clone raised a PR, and whether its terminal can be reached. */
function prOwner(prUrl: string): PrOwner | null {
  for (const inst of store.snapshot().instances) {
    if (!inst.recent.prs.some((p) => p.url === prUrl)) continue
    return {
      sessionId: inst.sessionId,
      name: inst.name,
      ptyId: ptys.ptyIdForPid(inst.pid),
      awaitingUser: inst.state === 'needs-you',
      alive: inst.state !== 'dead'
    }
  }
  return null
}

const hyperdrive = new Hyperdrive(
  { ownerOf: prOwner, send: (ptyId, text) => ptys.write(ptyId, text) },
  path.join(app.getPath('userData'), 'hyperdrive.json')
)
const updater = new Updater()
// pane titles go stale the moment a session moves on from its opening prompt
const retitler = new Retitler(store)
// whole-board zoom (Ctrl+= / - / 0, Ctrl+wheel), remembered across restarts
const zoom = new Zoom(path.join(app.getPath('userData'), 'zoom.json'))

/**
 * Commission a clone — the one path the desktop launch dialog and the phone
 * both take, so a clone started from the couch is the same as one started at
 * the desk (worktree, standing orders, Codex binding and all).
 */
async function commission(req: LaunchRequest): Promise<PtyInfo> {
  const def = ptys.definition(req.cli)
  let cwd = req.cwd
  if (req.worktree) {
    // before the tree exists, so the parent repo never reports it as untracked
    // and no clone can stage a second checkout into its own commit
    await ensureWorktreeIgnored(req.cwd)
    // Claude makes its own tree (--worktree); everyone else gets Kamino's
    if (!def.supports.nativeWorktree) cwd = await createWorktree(req.cwd, req.worktreeName)
  }
  const info = ptys.spawn({
    cwd,
    cli: def.id,
    resumeSessionId: req.resumeSessionId,
    initialPrompt: req.initialPrompt,
    permissionMode: req.permissionMode,
    model: req.model,
    autoShip: req.autoShip,
    linear: req.linear,
    linearIssue: req.linearIssue,
    worktree: req.worktree,
    worktreeName: req.worktreeName
  })
  if (def.kind === 'codex') {
    codex.expect({
      ptyId: info.ptyId,
      pid: info.pid,
      cwd,
      startedAt: Date.now(),
      resumeSessionId: req.resumeSessionId,
      permissionMode: req.permissionMode,
      model: req.model
    })
  }
  // the desktop board must grow a pane for it, whoever asked
  broadcast('pty:spawned', info)
  remote.pushState()
  return info
}

/** The CLI paints for its own theme; a terminal (desktop or phone) must
 *  match it. Claude Code stores it in ~/.claude.json ("theme"); absent = dark. */
function claudeTheme(): 'light' | 'dark' {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8')
    const theme = JSON.parse(raw).theme
    return typeof theme === 'string' && theme.includes('light') ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** The phone's whole board: every instance plus the terminal that steers it. */
function remoteState(): RemoteFleetState {
  const snap = store.snapshot()
  const boundPids = new Set(snap.instances.filter((i) => i.state !== 'dead').map((i) => i.pid))
  return {
    host: os.hostname(),
    termTheme: claudeTheme(),
    instances: snap.instances.map((i) => {
      const ptyId = i.state === 'dead' ? null : ptys.ptyIdForPid(i.pid)
      return ptyId ? { ...i, ptyId } : i
    }),
    ptys: ptys.list().map((p) => ({
      ...p,
      ...(ptys.size(p.ptyId) ?? { cols: 120, rows: 32 }),
      bound: boundPids.has(p.pid)
    })),
    pr: prPoller.snapshot(),
    updatedAt: snap.updatedAt
  }
}

// the phone link — off until switched on from ⋯ → Phone link
const remote = new RemoteServer(path.join(app.getPath('userData'), 'remote.json'), {
  state: remoteState,
  clis: async (): Promise<RemoteCli[]> => {
    const status = await clis.statuses()
    return clis.list().map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      brand: c.brand,
      permissionModes: c.permissionModes.map((m) => ({ value: m.value, label: m.label })),
      supports: c.supports,
      installed: status[c.id]?.installed ?? false
    }))
  },
  projects: () => recentProjects(),
  tail: (sessionId) => {
    const inst = store.get(sessionId)
    const file = store.transcriptFile(sessionId)
    return inst && file ? transcriptTail(file, inst.cliKind, 12) : []
  },
  recap: async (sessionId) => {
    const inst = store.get(sessionId)
    const file = store.transcriptFile(sessionId)
    if (!inst) throw new Error('unknown session')
    if (!file || inst.cliKind === 'custom') throw new Error('No transcript to report from for this CLI.')
    return recap(sessionId, file, inst.cliKind)
  },
  raisePr: async (sessionId) => {
    const inst = store.get(sessionId)
    if (!inst) return { ok: false, error: 'unknown session' }
    const res = await raisePr(inst.cwd)
    if (res.ok && res.url && typeof res.number === 'number') {
      store.addPr(sessionId, { number: res.number, url: res.url })
    }
    return res
  },
  commission,
  approveKeys: (ptyId) => ptys.definition(ptys.cliOf(ptyId) ?? undefined).approveKeys,
  pty: {
    exists: (ptyId) => ptys.size(ptyId) !== null,
    write: (ptyId, data) => ptys.write(ptyId, data),
    kill: (ptyId) => ptys.kill(ptyId),
    backlog: (ptyId) => ptys.backlog(ptyId),
    size: (ptyId) => ptys.size(ptyId),
    events: ptys
  },
  staticRoot: process.env['ELECTRON_RENDERER_URL'] ? null : path.join(__dirname, '../renderer'),
  devUrl: process.env['ELECTRON_RENDERER_URL'] ?? null
})

function remoteAlert(kind: RemoteAlert['kind'], sessionId: string, title: string, body: string): void {
  remote.alert({ kind, sessionId, title, body, at: Date.now() })
}
let win: BrowserWindow | null = null
/** true once the user has confirmed the update restart — the close guard must
 *  stand down or its dialog would cancel the very quit the user just approved */
let updateRestarting = false

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
      const kind = store.setNeedsYou(ev.sessionId, reason)
      // kind === null → just the idle nag; no toast, board stays calm
      if (kind) {
        const ask = store.get(ev.sessionId)?.now.pendingAsk
        const title = `${inst?.name ?? 'Clone'} awaits orders`
        // the phone hears every real ask — you're not at the desk to see the board
        remoteAlert('ask', ev.sessionId, title, ask || reason)
        if (shouldToast(ev.sessionId)) notify(title, ask || reason, ev.sessionId)
      }
      break
    }
    case 'stop': {
      const turnStartedAt = inst?.now.turnStartedAt
      store.clearNeedsYou(ev.sessionId, 'idle')
      if (inst && turnStartedAt && Date.now() - turnStartedAt > LONG_TURN_MS) {
        const body = inst.now.title || 'Another happy landing.'
        remoteAlert('done', ev.sessionId, `${inst.name} — mission complete`, body)
        if (shouldToast(ev.sessionId)) notify(`${inst.name} — mission complete`, body, ev.sessionId)
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

  zoom.attach(win)

  win.on('ready-to-show', () => win?.show())

  // closing the window kills every embedded clone — never do that silently
  win.on('close', (e) => {
    if (updateRestarting) return // already confirmed on the update banner
    const n = ptys.list().length
    if (n === 0) return
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['Close and terminate', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Kamino',
      message: `${n} embedded clone${n === 1 ? ' is' : 's are'} still running.`,
      detail: 'Closing Kamino ends their sessions. Unsaved work in a running turn is lost.'
    })
    if (choice !== 0) e.preventDefault()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalOnce(url, 'window-open')
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
  setOpenLogPath(path.join(app.getPath('userData'), 'open-external.log'))
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true })
  migrateHooks() // repair hook commands written by older Fleet versions
  store.setEmbeddedPidSource(() => ptys.pids())
  store.start()
  retitler.start()
  store.on('snapshot', (snap: FleetSnapshot) => {
    broadcast('fleet:snapshot', snap)
    remote.pushState()
    prPoller.setWatched(snap.instances.flatMap((i) => i.recent.prs.map((p) => p.url)))
  })
  prPoller.start()
  prPoller.on('update', (map) => {
    broadcast('pr:status', map)
    remote.pushState()
    hyperdrive.onPrStatus(map)
  })
  hyperdrive.on('event', (ev: HyperdriveEvent) => {
    broadcast('hyperdrive:event', ev)
    if (ev.outcome === 'sent') {
      notify(
        `Hyperdrive — ${ev.cloneName}`,
        ev.kind === 'ci'
          ? `PR #${ev.prNumber} CI was red; sent it back to fix (try ${ev.attempt})`
          : `PR #${ev.prNumber} stopped merging; sent it back to resolve (try ${ev.attempt})`,
        ev.sessionId
      )
    }
  })
  hookServer.start()
  hookServer.on('hook', onHook)

  // ── Codex clones: same toasts as the hook path gives Claude clones ────
  codex.start()
  codex.on('ask', (sessionId: string, text: string) => {
    const inst = store.get(sessionId)
    if (!inst) return
    remoteAlert('ask', sessionId, `${inst.name} awaits orders`, text)
    if (shouldToast(sessionId)) notify(`${inst.name} awaits orders`, text, sessionId)
  })
  codex.on('stop', (sessionId: string, turnStartedAt?: number) => {
    const inst = store.get(sessionId)
    if (inst && turnStartedAt && Date.now() - turnStartedAt > LONG_TURN_MS) {
      const body = inst.now.title || 'Another happy landing.'
      remoteAlert('done', sessionId, `${inst.name} — mission complete`, body)
      if (shouldToast(sessionId)) notify(`${inst.name} — mission complete`, body, sessionId)
    }
  })

  // ── CLIs: which ones exist, which are installed ──────────────────────
  ipcMain.handle('clis:list', async () => ({ clis: clis.list(), status: await clis.statuses() }))
  ipcMain.handle('clis:save', (_e, def: Partial<CliDefinition>) => clis.save(def ?? {}))
  ipcMain.handle('clis:remove', (_e, id: string) => (typeof id === 'string' ? clis.remove(id) : false))
  ipcMain.handle('clis:detect', (_e, id: string) => clis.status(String(id)))

  // ── zoom: the whole board scales like a browser page ─────────────────
  zoom.on('change', (st: ZoomState) => broadcast('zoom:state', st))
  ipcMain.handle('zoom:get', () => zoom.snapshot())
  ipcMain.on('zoom:step', (_e, dir: string) => (dir === 'in' ? zoom.zoomIn() : zoom.zoomOut()))

  // ── auto-update: the flag that says a newer Kamino is staged ─────────
  updater.start()
  updater.on('state', (st) => broadcast('update:state', st))
  ipcMain.handle('update:get', () => updater.snapshot())
  ipcMain.handle('update:restart', async () => {
    const n = ptys.list().length
    if (n > 0) {
      const res = await dialog.showMessageBox(win!, {
        type: 'warning',
        buttons: ['Restart and upgrade', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Kamino',
        message: `${n} embedded clone${n === 1 ? ' is' : 's are'} still running.`,
        detail: 'Restarting into the new version ends their sessions. Unsaved work in a running turn is lost.'
      })
      if (res.response !== 0) return false
    }
    updateRestarting = true
    updater.restart()
    return true
  })

  // ── airspace control ─────────────────────────────────────────────────
  // the ledger of who is mid-edit where, fed straight off the transcript
  // stream, so the PreToolUse answer never needs disk or a subprocess
  store.on('tool-use', (inst: Instance, name: string, input?: Record<string, unknown>) => {
    deconflictor.noteToolUse(inst.sessionId, name, inst.name, inst.cwd, input)
  })
  store.on('died', (sessionId: string) => deconflictor.release(sessionId))
  hookServer.setPreToolDecider((req) =>
    deconflictor.decide({
      sessionId: req.sessionId,
      cwd: req.cwd || store.get(req.sessionId)?.cwd || '',
      toolName: req.toolName,
      input: req.input,
      cloneName: store.get(req.sessionId)?.name
    })
  )
  deconflictor.on('event', (ev: DeconflictEvent) => {
    broadcast('airspace:event', ev)
    if (!ev.denied) return
    // with an arbiter coming, the collision itself is not news — you'll hear
    // about it once, at the verdict, and only if it needs you
    if (arbiter.isEnabled()) {
      arbiter.open(ev)
      return
    }
    notify(
      `Collision stopped — ${ev.cloneName}`,
      `${ev.command} would have hit ${ev.siblings.join(', ')}`,
      ev.sessionId
    )
  })

  // ── the arbiter: settle the collision instead of handing it to you ────
  store.setArbiterPidSource(() => arbiter.arbiterPids())
  arbiter.on('change', () => deconflictor.setArbiterEnabled(arbiter.isEnabled()))
  arbiter.on('case', (c: ArbiterCase) => {
    broadcast('arbiter:case', c)
    if (c.stage === 'resolved') {
      notify(`Airspace settled — ${c.repo}`, c.summary || `${c.blockedClone} is moving again.`, c.blockedSessionId)
    } else if (c.stage === 'escalated' || c.stage === 'failed') {
      notify(
        `Airspace needs you — ${c.repo}`,
        c.question || c.error || 'The arbiter could not settle this one.',
        c.arbiterSessionId || c.blockedSessionId
      )
    }
  })

  ptys.on('data', (ptyId: string, data: string) => broadcast('pty:data', ptyId, data))
  ptys.on('exit', (ptyId: string, exitCode: number) => {
    broadcast('pty:exit', ptyId, exitCode)
    remote.pushState()
  })

  // ── phone link ───────────────────────────────────────────────────────
  remote.on('status', (st) => broadcast('remote:state', st))
  remote.start()
  ipcMain.handle('remote:get', () => remote.status())
  ipcMain.handle('remote:set', (_e, next: Partial<RemoteSettings>) => remote.setSettings(next ?? {}))
  ipcMain.handle('remote:rotate', () => remote.rotateToken())

  // ── fleet ────────────────────────────────────────────────────────────
  ipcMain.handle('fleet:get', () => store.snapshot())
  ipcMain.handle('pr:status:get', () => prPoller.snapshot())

  // ── the always-there PR button: raise (or find) the PR for a clone's branch
  ipcMain.handle('pr:create', async (_e, sessionId: string) => {
    const inst = store.get(sessionId)
    if (!inst) return { ok: false, error: 'unknown session' }
    const res = await raisePr(inst.cwd)
    if (res.ok && res.url && typeof res.number === 'number') {
      // snapshot listener re-feeds prPoller.setWatched, which sweeps the new URL
      store.addPr(sessionId, { number: res.number, url: res.url })
    }
    return res
  })

  // the CLI paints for its own theme; the embedded terminal must match it.
  // Claude Code stores it in ~/.claude.json ("theme"); absent = dark.
  ipcMain.handle('claude:theme', () => claudeTheme())

  // ── ptys ─────────────────────────────────────────────────────────────
  ipcMain.handle('pty:spawn', (_e, req: LaunchRequest) => commission(req))
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

  // window.confirm() breaks keyboard focus for the whole window on Windows
  // (electron#19977) — every terminal goes deaf until you alt-tab away and
  // back. Confirmations must go through a main-process dialog instead.
  ipcMain.handle('dialog:confirm', async (_e, message: string, detail?: string) => {
    const res = await dialog.showMessageBox(win!, {
      type: 'warning',
      buttons: ['OK', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: String(message),
      detail: detail ? String(detail) : undefined
    })
    return res.response === 0
  })

  // ── recap ────────────────────────────────────────────────────────────
  ipcMain.handle('recap:get', async (_e, sessionId: string) => {
    const inst = store.get(sessionId)
    if (!inst) throw new Error('unknown session')
    const file = store.transcriptFile(sessionId)
    if (!file || inst.cliKind === 'custom') {
      throw new Error('No transcript to report from — Kamino can host this CLI but cannot read it.')
    }
    return recap(sessionId, file, inst.cliKind)
  })

  // ── reincarnation: hand a rotting clone's state to a fresh one ────────
  handoff.on('progress', (p: HandoffProgress) => broadcast('handoff:progress', p))
  ipcMain.handle('handoff:start', (_e, sessionId: string, killOld: boolean) => {
    void handoff.run(sessionId, { killOld: killOld !== false })
  })
  ipcMain.handle('handoff:cancel', (_e, sessionId: string) => handoff.cancel(sessionId))
  ipcMain.handle('handoff:compact', (_e, sessionId: string) => handoff.compact(sessionId))

  // ── airspace control: mode + log ─────────────────────────────────────
  ipcMain.handle('airspace:get', () => ({
    mode: deconflictor.getMode(),
    claims: deconflictor.claimList(),
    events: deconflictor.events(),
    contested: deconflictor.contestedFiles(),
    prevented: deconflictor.preventedCount()
  }))
  ipcMain.handle('airspace:set-mode', (_e, mode: DeconflictMode) => {
    if (mode === 'off' || mode === 'warn' || mode === 'enforce') deconflictor.setMode(mode)
    return deconflictor.getMode()
  })

  // ── the arbiter ──────────────────────────────────────────────────────
  ipcMain.handle('arbiter:get', () => arbiter.getState())
  ipcMain.handle('arbiter:set', (_e, next: Partial<ArbiterSettings>) => arbiter.setSettings(next ?? {}))

  // ── hyperdrive: automatic fixes ──────────────────────────────────────
  ipcMain.handle('hyperdrive:get', () => hyperdrive.getState())
  ipcMain.handle('hyperdrive:set', (_e, next: Partial<HyperdriveSettings>) =>
    hyperdrive.setSettings(next ?? {})
  )

  // ── hover peek: last few transcript exchanges ────────────────────────
  ipcMain.handle('transcript:tail', (_e, sessionId: string) => {
    const inst = store.get(sessionId)
    const file = store.transcriptFile(sessionId)
    if (!inst || !file) return []
    return transcriptTail(file, inst.cliKind)
  })

  // ── hooks ────────────────────────────────────────────────────────────
  ipcMain.handle('hooks:status', () => hooksInstalled())
  ipcMain.handle('hooks:install', () => installHooks())
  ipcMain.on('ui:selected', (_e, sessionId: string | null) => {
    lastSelectedSession = sessionId
  })

  // ── wrap-up check ────────────────────────────────────────────────────
  ipcMain.handle('wrapup:check', async () => {
    // one row per working folder — several clones can share a repo
    const byCwd = new Map<string, string[]>()
    for (const i of store.snapshot().instances) {
      if (i.state === 'dead' || !i.cwd) continue
      byCwd.set(i.cwd, [...(byCwd.get(i.cwd) ?? []), i.name])
    }
    for (const p of ptys.list()) {
      if (p.cwd && !byCwd.has(p.cwd)) byCwd.set(p.cwd, ['new clone'])
    }
    const repos = await Promise.all([...byCwd].map(([cwd, clones]) => checkRepo(cwd, clones)))
    repos.sort((a, b) => a.repo.localeCompare(b.repo))
    return { repos, generatedAt: Date.now() }
  })

  // ── misc ─────────────────────────────────────────────────────────────
  ipcMain.handle('open:external', (_e, url: string) => {
    openExternalOnce(url, 'ipc')
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
  codex.stop()
  store.stop()
  retitler.stop()
  prPoller.stop()
  updater.stop()
  // stop answering PreToolUse before the port closes, so nothing is left
  // half-deciding while we shut down
  hookServer.setPreToolDecider(null)
  hookServer.stop()
  void remote.stop()
  app.quit()
})
