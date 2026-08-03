import { contextBridge, ipcRenderer } from 'electron'
import type { FleetSnapshot, LaunchRequest, PrStatusMap, PtyInfo, RecentProject, RecentSession } from '../shared/types'

const api = {
  // fleet status
  getFleet: (): Promise<FleetSnapshot> => ipcRenderer.invoke('fleet:get'),
  onFleet: (cb: (snap: FleetSnapshot) => void): (() => void) => {
    const listener = (_e: unknown, snap: FleetSnapshot): void => cb(snap)
    ipcRenderer.on('fleet:snapshot', listener)
    return () => ipcRenderer.removeListener('fleet:snapshot', listener)
  },

  // live PR status (gh CLI)
  getPrStatus: (): Promise<PrStatusMap> => ipcRenderer.invoke('pr:status:get'),
  onPrStatus: (cb: (map: PrStatusMap) => void): (() => void) => {
    const listener = (_e: unknown, map: PrStatusMap): void => cb(map)
    ipcRenderer.on('pr:status', listener)
    return () => ipcRenderer.removeListener('pr:status', listener)
  },

  // embedded terminals
  spawn: (req: LaunchRequest): Promise<PtyInfo> => ipcRenderer.invoke('pty:spawn', req),
  ptyInput: (ptyId: string, data: string): void => ipcRenderer.send('pty:input', ptyId, data),
  ptyResize: (ptyId: string, cols: number, rows: number): void =>
    ipcRenderer.send('pty:resize', ptyId, cols, rows),
  ptyKill: (ptyId: string): Promise<void> => ipcRenderer.invoke('pty:kill', ptyId),
  ptyBacklog: (ptyId: string): Promise<string> => ipcRenderer.invoke('pty:backlog', ptyId),
  ptyList: (): Promise<PtyInfo[]> => ipcRenderer.invoke('pty:list'),
  onPtyData: (cb: (ptyId: string, data: string) => void): (() => void) => {
    const listener = (_e: unknown, ptyId: string, data: string): void => cb(ptyId, data)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },
  onPtyExit: (cb: (ptyId: string, exitCode: number) => void): (() => void) => {
    const listener = (_e: unknown, ptyId: string, exitCode: number): void => cb(ptyId, exitCode)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  },

  // pickers
  recentProjects: (): Promise<RecentProject[]> => ipcRenderer.invoke('projects:recent'),
  recentSessions: (): Promise<RecentSession[]> => ipcRenderer.invoke('sessions:recent'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-folder'),
  /** use instead of window.confirm(), which kills keyboard focus on Windows */
  confirm: (message: string, detail?: string): Promise<boolean> =>
    ipcRenderer.invoke('dialog:confirm', message, detail),

  // recap
  recap: (sessionId: string): Promise<{ text: string; generatedAt: number; fromCache: boolean }> =>
    ipcRenderer.invoke('recap:get', sessionId),

  // hooks + focus routing
  hooksStatus: (): Promise<boolean> => ipcRenderer.invoke('hooks:status'),
  hooksInstall: (): Promise<{ installed: string[]; settingsPath: string }> =>
    ipcRenderer.invoke('hooks:install'),
  reportSelected: (sessionId: string | null): void => ipcRenderer.send('ui:selected', sessionId),
  onSelectSession: (cb: (sessionId: string) => void): (() => void) => {
    const listener = (_e: unknown, sessionId: string): void => cb(sessionId)
    ipcRenderer.on('ui:select-session', listener)
    return () => ipcRenderer.removeListener('ui:select-session', listener)
  },

  // misc
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open:external', url),
  openPath: (p: string): Promise<void> => ipcRenderer.invoke('open:path', p),
  openVsCode: (p: string): Promise<void> => ipcRenderer.invoke('open:vscode', p),
  killPid: (pid: number): Promise<boolean> => ipcRenderer.invoke('kill:pid', pid),
  claudeTheme: (): Promise<'light' | 'dark'> => ipcRenderer.invoke('claude:theme')
}

contextBridge.exposeInMainWorld('fleet', api)

export type FleetApi = typeof api
