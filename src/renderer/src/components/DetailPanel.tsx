import type { Instance } from '../../../shared/types'
import { elapsed, STATE_WORD } from '../format'

export function DetailPanel(props: { instance: Instance; now: number }): React.JSX.Element {
  const { instance: inst, now } = props

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

      <div className="section">
        <div className="section-label">Now</div>
        <div className="now-line">
          <span className="caret">▸</span>
          {inst.now.activity}
        </div>
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
        </div>
      </div>
    </div>
  )
}
