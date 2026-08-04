import { useEffect, useState } from 'react'
import type { Instance, PrStatusMap } from '../../../shared/types'
import { elapsed, fmtTokens, prBadge, stateWord } from '../format'
import { RotBar } from './RotBar'

export function DetailPanel(props: {
  instance: Instance
  now: number
  adoptPending?: boolean
  prStatus?: PrStatusMap
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
          {stateWord(inst.state, inst.now.askKind)}
        </span>
        {inst.state === 'busy' && inst.now.turnStartedAt && (
          <span className="topbar-clock">turn running {elapsed(inst.now.turnStartedAt, now)}</span>
        )}
      </div>
      {inst.now.title && <div className="detail-title">{inst.now.title}</div>}

      {inst.kind === 'external' && inst.state !== 'dead' && props.onAdopt && (
        props.adoptPending ? (
          <div className="adopt-banner waiting">
            <span className="adopt-spinner">◌</span> Extraction armed — close its Windows Terminal
            tab and Kamino takes over the session the moment it exits.
          </div>
        ) : (
          <div className="adopt-banner">
            <span>
              This clone is field-deployed in an outside terminal, so you can&apos;t type here yet.
              Recall it to Kamino to get an embedded terminal with the same conversation.
            </span>
            <button className="btn primary" onClick={props.onAdopt}>
              Recall to Kamino
            </button>
          </div>
        )
      )}

      {inst.state === 'needs-you' && inst.now.pendingAsk && (
        <div className="section">
          <div className="section-label">Awaiting orders — what it needs</div>
          <div className="ask-detail">{inst.now.pendingAsk}</div>
        </div>
      )}

      <div className="section">
        <div className="section-label">Now</div>
        <div className="now-line">
          <span className="caret">▸</span>
          {inst.now.activity}
        </div>
      </div>

      <div className="section">
        <div className="section-label">Status report</div>
        {recapText ? (
          <div className="recap">{recapText}</div>
        ) : (
          <div className="actions">
            <button className="btn" onClick={catchMeUp} disabled={recapBusy}>
              {recapBusy ? 'Incoming transmission…' : '✦ Report in'}
            </button>
            {recapErr && <span className="recap-err">{recapErr}</span>}
          </div>
        )}
        {recapText && (
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="btn" onClick={catchMeUp} disabled={recapBusy}>
              {recapBusy ? 'Incoming transmission…' : 'Report again'}
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
            {inst.recent.prs.map((pr) => {
              const badge = prBadge(props.prStatus?.[pr.url])
              return (
                <button
                  key={pr.url}
                  className="pr-link"
                  title={badge?.title}
                  onClick={() => window.fleet.openExternal(pr.url)}
                >
                  #{pr.number}
                  {badge && (
                    <>
                      {' '}
                      <span className="pr-glyph" data-tone={badge.tone}>
                        {badge.glyph}
                      </span>{' '}
                      <span className="pr-words">{badge.words}</span>
                    </>
                  )}{' '}
                  ↗
                </button>
              )
            })}
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
          <dt>context</dt>
          <dd>
            {inst.context ? (
              <span className="detail-rot">
                <RotBar context={inst.context} now={now} />
                <span>
                  {fmtTokens(inst.context.tokens)} / {fmtTokens(inst.context.window)}
                  {inst.context.compactions > 0 && ` · ${inst.context.compactions} compaction${inst.context.compactions > 1 ? 's' : ''}`}
                </span>
              </span>
            ) : (
              '—'
            )}
          </dd>
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
              onClick={async () => {
                if (await window.fleet.confirm(`Decommission ${inst.name} (pid ${inst.pid})?`, 'Its terminal tab will close the session.')) {
                  window.fleet.killPid(inst.pid)
                }
              }}
            >
              Decommission clone
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
