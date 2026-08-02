import { contextBridge, ipcRenderer } from 'electron'
import type { FleetSnapshot } from '../shared/types'

const api = {
  getFleet: (): Promise<FleetSnapshot> => ipcRenderer.invoke('fleet:get'),
  onFleet: (cb: (snap: FleetSnapshot) => void): (() => void) => {
    const listener = (_e: unknown, snap: FleetSnapshot): void => cb(snap)
    ipcRenderer.on('fleet:snapshot', listener)
    return () => ipcRenderer.removeListener('fleet:snapshot', listener)
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open:external', url),
  openPath: (p: string): Promise<void> => ipcRenderer.invoke('open:path', p)
}

contextBridge.exposeInMainWorld('fleet', api)

export type FleetApi = typeof api
