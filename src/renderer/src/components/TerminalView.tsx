import { useEffect, useRef } from 'react'
import { fitAndReport, getOrCreateTerminal } from '../terminals'

export function TerminalView(props: { ptyId: string }): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const entry = getOrCreateTerminal(props.ptyId)
    mount.appendChild(entry.host)
    fitAndReport(props.ptyId)
    entry.term.focus()

    const ro = new ResizeObserver(() => fitAndReport(props.ptyId))
    ro.observe(mount)
    return () => {
      ro.disconnect()
      // release, don't destroy — scrollback survives card switches
      if (entry.host.parentElement === mount) mount.removeChild(entry.host)
    }
  }, [props.ptyId])

  return <div className="terminal-view" ref={mountRef} />
}
