import type { FleetSnapshot } from '../shared/types'

declare global {
  interface Window {
    fleet: {
      getFleet: () => Promise<FleetSnapshot>
      onFleet: (cb: (snap: FleetSnapshot) => void) => () => void
      openExternal: (url: string) => Promise<void>
      openPath: (p: string) => Promise<void>
    }
  }
}

export {}
