import { contextBridge, ipcRenderer } from 'electron'
import type { FleetSnapshot, LaunchRequest, PtyInfo, RecentProject, RecentSession } from '../shared/types'

const api = {
  // fleet status
  getFleet: (): Promise<FleetSnapshot> => ipcRenderer.invoke('fleet:get'),
  onFleet: (cb: (snap: FleetSnapshot) => void): (() => void) => {
    const listener = (_e: unknown, snap: FleetSnapshot): void => cb(snap)
    ipcRenderer.on('fleet:snapshot', listener)
    return () => ipcRenderer.removeListener('fleet:snapshot', listener)
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

  // misc
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open:external', url),
  openPath: (p: string): Promise<void> => ipcRenderer.invoke('open:path', p)
}

contextBridge.exposeInMainWorld('fleet', api)

export type FleetApi = typeof api
