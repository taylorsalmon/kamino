import type { FleetSnapshot, LaunchRequest, PrStatusMap, PtyInfo, RecentProject, RecentSession, WrapupReport } from '../shared/types'

declare global {
  interface Window {
    fleet: {
      getFleet: () => Promise<FleetSnapshot>
      onFleet: (cb: (snap: FleetSnapshot) => void) => () => void
      getPrStatus: () => Promise<PrStatusMap>
      onPrStatus: (cb: (map: PrStatusMap) => void) => () => void
      spawn: (req: LaunchRequest) => Promise<PtyInfo>
      ptyInput: (ptyId: string, data: string) => void
      ptyResize: (ptyId: string, cols: number, rows: number) => void
      ptyKill: (ptyId: string) => Promise<void>
      ptyBacklog: (ptyId: string) => Promise<string>
      ptyList: () => Promise<PtyInfo[]>
      onPtyData: (cb: (ptyId: string, data: string) => void) => () => void
      onPtyExit: (cb: (ptyId: string, exitCode: number) => void) => () => void
      recentProjects: () => Promise<RecentProject[]>
      recentSessions: () => Promise<RecentSession[]>
      pickFolder: () => Promise<string | null>
      confirm: (message: string, detail?: string) => Promise<boolean>
      wrapupCheck: () => Promise<WrapupReport>
      recap: (sessionId: string) => Promise<{ text: string; generatedAt: number; fromCache: boolean }>
      hooksStatus: () => Promise<boolean>
      hooksInstall: () => Promise<{ installed: string[]; settingsPath: string }>
      reportSelected: (sessionId: string | null) => void
      onSelectSession: (cb: (sessionId: string) => void) => () => void
      openExternal: (url: string) => Promise<void>
      openPath: (p: string) => Promise<void>
      openVsCode: (p: string) => Promise<void>
      killPid: (pid: number) => Promise<boolean>
      claudeTheme: () => Promise<'light' | 'dark'>
    }
  }
}

export {}
