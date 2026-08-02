import { useEffect, useState } from 'react'
import type { Instance } from '../../../shared/types'
import { elapsed, STATE_WORD } from '../format'

export function DetailPanel(props: {
  instance: Instance
  now: number
  adoptPending?: boolean
  onAdopt?: () => void
}): React.JSX.Element {
  const { instance: inst, now } = props
  const [recapText, setRecapText] = useState<string | null>(null)
  const [recapBusy, setRecapBusy] = useState(false)
  const [recapErr, setRecapErr] = useState<string | null>(null)

  useEffect(() => {
    // recap belongs to a session — drop it when the card changes
    setRecapText(null)
    setRecapErr(null)
    setRecapBusy(false)
  }, [inst.sessionId])

  async function catchMeUp(): Promise<void> {
    setRecapBusy(true)
    setRecapErr(null)
    try {
      const r = await window.fleet.recap(inst.sessionId)
      setRecapText(r.text)
    } catch (e) {
      setRecapErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRecapBusy(false)
    }
  }

  return (
    <div>
      <div className="detail-head">
        <span className="detail-name">{inst.name}</span>
        <span className="state-pill" data-state={inst.state}>
          {STATE_WORD[inst.state]}
        </span>
        {inst.state === 'busy' && inst.now.turnStartedAt && (
          <span className="topbar-clock">turn running {elapsed(inst.now.turnStartedAt, now)}</span>
        )}
      </div>
      {inst.now.title && <div className="detail-title">{inst.now.title}</div>}

      {inst.kind === 'external' && inst.state !== 'dead' && props.onAdopt && (
        props.adoptPending ? (
          <div className="adopt-banner waiting">
            <span className="adopt-spinner">◌</span> Waiting for you to close its Windows Terminal
            tab — Fleet takes over the session automatically the moment it exits.
          </div>
        ) : (
          <div className="adopt-banner">
            <span>
              This instance runs in an outside terminal, so you can&apos;t type here yet. Move it
              into Fleet to get an embedded terminal with the same conversation.
            </span>
            <button className="btn primary" onClick={props.onAdopt}>
              Move into Fleet
            </button>
          </div>
        )
      )}

      <div className="section">
        <div className="section-label">Now</div>
        <div className="now-line">
          <span className="caret">▸</span>
          {inst.now.activity}
        </div>
      </div>

      <div className="section">
        <div className="section-label">Catch me up</div>
        {recapText ? (
          <div className="recap">{recapText}</div>
        ) : (
          <div className="actions">
            <button className="btn" onClick={catchMeUp} disabled={recapBusy}>
              {recapBusy ? 'Summarizing…' : '✦ Catch me up'}
            </button>
            {recapErr && <span className="recap-err">{recapErr}</span>}
          </div>
        )}
        {recapText && (
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="btn" onClick={catchMeUp} disabled={recapBusy}>
              {recapBusy ? 'Summarizing…' : 'Refresh'}
            </button>
          </div>
        )}
      </div>

      {inst.recent.awaySummary && (
        <div className="section">
          <div className="section-label">While you were away</div>
          <div className="away">{inst.recent.awaySummary}</div>
        </div>
      )}

      {inst.recent.lastPrompt && (
        <div className="section">
          <div className="section-label">Your last prompt</div>
          <div className="quote">{inst.recent.lastPrompt}</div>
        </div>
      )}

      {inst.recent.lastAssistantText && (
        <div className="section">
          <div className="section-label">Last reply</div>
          <div className="quote">{inst.recent.lastAssistantText}</div>
        </div>
      )}

      {inst.now.queued.length > 0 && (
        <div className="section">
          <div className="section-label">Queued prompts</div>
          <div className="queued-list">
            {inst.now.queued.map((q, i) => (
              <div key={i} className="queued-item">
                {q}
              </div>
            ))}
          </div>
        </div>
      )}

      {inst.recent.prs.length > 0 && (
        <div className="section">
          <div className="section-label">Pull requests</div>
          <div className="pr-list">
            {inst.recent.prs.map((pr) => (
              <button key={pr.url} className="pr-link" onClick={() => window.fleet.openExternal(pr.url)}>
                #{pr.number} ↗
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-label">Session</div>
        <dl className="meta-grid">
          <dt>folder</dt>
          <dd>{inst.cwd}</dd>
          <dt>branch</dt>
          <dd>{inst.gitBranch || '—'}</dd>
          <dt>pid</dt>
          <dd>{inst.pid}</dd>
          <dt>session</dt>
          <dd>{inst.sessionId}</dd>
          <dt>turns</dt>
          <dd>{inst.recent.turns}</dd>
          <dt>model</dt>
          <dd>{inst.model ?? '—'}</dd>
          <dt>permissions</dt>
          <dd>{inst.permissionMode ?? '—'}</dd>
          <dt>cli</dt>
          <dd>{inst.version ?? '—'}</dd>
        </dl>
      </div>

      <div className="section">
        <div className="section-label">Actions</div>
        <div className="actions">
          <button className="btn" onClick={() => window.fleet.openPath(inst.cwd)}>
            Open folder
          </button>
          <button className="btn" onClick={() => window.fleet.openVsCode(inst.cwd)}>
            Open in VS Code
          </button>
          <button
            className="btn"
            onClick={() => navigator.clipboard.writeText(`claude --resume ${inst.sessionId}`)}
          >
            Copy resume command
          </button>
          {inst.gitBranch && (
            <button className="btn" onClick={() => navigator.clipboard.writeText(inst.gitBranch)}>
              Copy branch
            </button>
          )}
          {inst.kind === 'external' && inst.state !== 'dead' && (
            <button
              className="btn danger"
              onClick={() => {
                if (confirm(`Kill ${inst.name} (pid ${inst.pid})? Its terminal tab will close the session.`)) {
                  window.fleet.killPid(inst.pid)
                }
              }}
            >
              Kill instance
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
