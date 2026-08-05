import type { AirspaceState, DeconflictEvent, DeconflictMode, FleetSnapshot, HandoffProgress, HyperdriveEvent, HyperdriveSettings, HyperdriveState, LaunchRequest, PrStatusMap, PtyInfo, RecentProject, RecentSession, TranscriptTailMsg, WrapupReport } from '../shared/types'

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
      transcriptTail: (sessionId: string) => Promise<TranscriptTailMsg[]>
      hyperdriveGet: () => Promise<HyperdriveState>
      hyperdriveSet: (next: Partial<HyperdriveSettings>) => Promise<HyperdriveSettings>
      onHyperdriveEvent: (cb: (ev: HyperdriveEvent) => void) => () => void
      airspaceGet: () => Promise<AirspaceState>
      airspaceSetMode: (mode: DeconflictMode) => Promise<DeconflictMode>
      onAirspaceEvent: (cb: (ev: DeconflictEvent) => void) => () => void
      handoffStart: (sessionId: string, killOld: boolean) => Promise<void>
      handoffCancel: (sessionId: string) => Promise<void>
      handoffCompact: (sessionId: string) => Promise<boolean>
      onHandoff: (cb: (p: HandoffProgress) => void) => () => void
      hooksStatus: () => Promise<boolean>
      hooksInstall: () => Promise<{ installed: string[]; settingsPath: string }>
      reportSelected: (sessionId: string | null) => void
      onSelectSession: (cb: (sessionId: string) => void) => () => void
      pathForFile: (file: File) => string
      openExternal: (url: string) => Promise<void>
      openPath: (p: string) => Promise<void>
      openVsCode: (p: string) => Promise<void>
      killPid: (pid: number) => Promise<boolean>
      claudeTheme: () => Promise<'light' | 'dark'>
    }
  }
}

export {}
