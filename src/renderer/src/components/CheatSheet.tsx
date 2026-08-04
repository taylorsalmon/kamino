import { useEffect } from 'react'

/**
 * CheatSheet — the fleet's keyboard reference. Every binding here must also
 * be forwarded from terminals.ts (xterm owns the keyboard while a pane is
 * focused) and handled in App's mount-once key listener.
 */

const ROWS: Array<{ keys: string[]; what: string }> = [
  { keys: ['Ctrl', '`'], what: 'Jump to the next clone awaiting orders — answer, press again' },
  { keys: ['Ctrl', '1…9'], what: 'Jump straight to that pane on the wall' },
  { keys: ['Ctrl', 'Shift', 'G'], what: 'Flip Grid ⇄ Focus' },
  { keys: ['F2'], what: 'Flip Terminal ⇄ Intel for the selected clone' },
  { keys: ['Ctrl', 'Shift', 'N'], what: 'Commission a new clone' },
  { keys: ['Ctrl', 'Shift', 'D'], what: 'Cycle wall density — Roomy → Fit → Max' },
  { keys: ['Ctrl', 'Shift', 'S'], what: 'End-of-shift sweep' },
  { keys: ['F1'], what: 'This cheat sheet' }
]

export function CheatSheet(props: { onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal cheatsheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs">
          <span className="modal-tab active">⌨ FLEET COMMANDS</span>
          <button className="modal-close" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {ROWS.map((r) => (
            <div key={r.what} className="cheat-row">
              <span className="cheat-keys">
                {r.keys.map((k, ix) => (
                  <span key={k}>
                    {ix > 0 && <span className="cheat-plus">+</span>}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </span>
              <span className="cheat-what">{r.what}</span>
            </div>
          ))}
          <div className="cheat-note">
            Shortcuts work everywhere — even while a terminal owns the keyboard.
          </div>
        </div>
      </div>
    </div>
  )
}
