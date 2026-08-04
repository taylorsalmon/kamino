import { agoShort } from '../format'

/**
 * FeedPanel — one chronological ticker for the whole fleet. Every state
 * transition, PR event, and arrival/departure lands here, newest first, so
 * you scan one column instead of eight panes to learn what moved while you
 * were looking away. Events are derived in App by diffing snapshots — no
 * extra polling, no model calls.
 */

export type FeedTone = 'ok' | 'ask' | 'busy' | 'bad' | 'info'

export interface FeedEvent {
  id: number
  at: number
  sessionId: string
  /** clone name at the time of the event */
  name: string
  text: string
  tone: FeedTone
}

const TONE_GLYPH: Record<FeedTone, string> = {
  ok: '✓',
  ask: '⚑',
  busy: '▸',
  bad: '✕',
  info: '·'
}

export function FeedPanel(props: {
  events: FeedEvent[]
  now: number
  onJump: (sessionId: string) => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <aside className="feed-panel">
      <div className="feed-head">
        <span className="feed-title">FLEET FEED</span>
        <span className="topbar-spacer" />
        {props.events.length > 0 && (
          <button className="feed-clear" title="Clear the feed" onClick={props.onClear}>
            clear
          </button>
        )}
      </div>
      <div className="feed-list">
        {props.events.length === 0 && (
          <div className="feed-empty">Quiet so far — clone activity lands here as it happens.</div>
        )}
        {props.events.map((ev) => (
          <button
            key={ev.id}
            className="feed-item"
            data-tone={ev.tone}
            title={`${ev.text} — click to jump to ${ev.name}`}
            onClick={() => props.onJump(ev.sessionId)}
          >
            <span className="feed-glyph" data-tone={ev.tone}>
              {TONE_GLYPH[ev.tone]}
            </span>
            <span className="feed-body">
              <span className="feed-top">
                <span className="feed-name">{ev.name}</span>
                <span className="feed-when">{agoShort(ev.at, props.now)}</span>
              </span>
              <span className="feed-text">{ev.text}</span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  )
}
