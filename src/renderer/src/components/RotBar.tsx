import { useId, useRef, useState } from 'react'
import type { CliKind, ContextHealth } from '../../../shared/types'
import { agoShort, fmtTokens, rotStage } from '../format'
import { OPENAI_PATH } from './CliMark'

const TIP_W = 280
const TIP_EST_H = 170

/**
 * RotBar — context rot at a glance, told through the mascot's health.
 *
 * For a Claude clone the mascot is Clawd, the block-glyph crab from the Claude
 * Code welcome screen: fresh he bobs and blinks orange; as the context window
 * fills he stales, slumps, draws flies, and at ~100% (auto-compact — the forced
 * summary that loses detail) he's belly-up while his soul drifts off. He's
 * drawn in block characters, so his pixels die one by one — feet first, core
 * last.
 *
 * For a Codex clone the mascot is the OpenAI blossom, and its six petals are
 * the pixels: they fall away one wedge at a time as the window fills, the mark
 * turns the same clay-to-grave colours, and at the end it flips over too.
 *
 * All the numbers and the explanation live in the hover tip. The tip is
 * position:fixed and placed by JS — every row that hosts the mascot (card
 * meta, pane title) clips overflow, so an absolutely-positioned tip would be
 * cut off.
 */

const CLAWD = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  ']
const CLAWD_SOUL = ' ▐▛█▜▌\n▝▜██▛▘'
// which pixel dies at which point of decay — feet first, then corners,
// shoulders, flanks; the core is the last light out
const DECAY_ORDER = [
  '2-2', '2-7', '2-3', '2-6', // feet
  '1-0', '1-8', '0-1', '0-7', // outer corners
  '1-1', '1-7', '0-2', '0-6', // shoulders
  '1-2', '1-6', '0-3', '0-5', // flanks
  '1-3', '1-5', '0-4', '1-4' // core
]
const DECAY_INDEX = new Map(DECAY_ORDER.map((k, i) => [k, i]))

/** six 60° wedges around the blossom's centre — one per petal */
const WEDGES = Array.from({ length: 6 }, (_, k) => {
  const a1 = ((k * 60 - 120) * Math.PI) / 180
  const a2 = ((k * 60 - 60) * Math.PI) / 180
  const r = 13
  const p = (a: number): string => `${(12 + r * Math.cos(a)).toFixed(3)},${(12 + r * Math.sin(a)).toFixed(3)}`
  return `M12,12 L${p(a1)} A${r},${r} 0 0,1 ${p(a2)} Z`
})
// petals go alternately around the ring, so the mark thins evenly rather
// than losing one side first
const PETAL_ORDER = [3, 0, 4, 1, 5, 2]

function ClawdMascot(props: { deadPixels: number }): React.JSX.Element {
  return (
    <span className="clawd">
      <pre className="clawd-body">
        {CLAWD.map((line, r) => (
          <span key={r}>
            {Array.from(line).map((ch, c) =>
              ch === ' ' ? (
                ' '
              ) : (
                <span
                  key={c}
                  className={(DECAY_INDEX.get(`${r}-${c}`) ?? 99) < props.deadPixels ? 'px-dead' : undefined}
                >
                  {ch}
                </span>
              )
            )}
            {r < CLAWD.length - 1 ? '\n' : ''}
          </span>
        ))}
      </pre>
      <span className="cl-fly cl-fly-1" />
      <span className="cl-fly cl-fly-2" />
      <pre className="cl-soul">{CLAWD_SOUL}</pre>
    </span>
  )
}

function BlossomMascot(props: { deadPetals: number }): React.JSX.Element {
  const id = useId().replace(/:/g, '')
  return (
    <span className="clawd oai">
      <svg viewBox="0 0 24 24" className="oai-mark" aria-hidden focusable="false">
        <defs>
          <mask id={`oai-${id}`}>
            <rect width="24" height="24" fill="white" />
            {WEDGES.map((d, k) => (
              <path
                key={k}
                d={d}
                className={`oai-wedge${PETAL_ORDER.indexOf(k) < props.deadPetals ? ' px-dead' : ''}`}
              />
            ))}
          </mask>
        </defs>
        <path d={OPENAI_PATH} fill="currentColor" mask={`url(#oai-${id})`} />
      </svg>
      <span className="cl-fly cl-fly-1" />
      <span className="cl-fly cl-fly-2" />
      <svg viewBox="0 0 24 24" className="oai-soul" aria-hidden focusable="false">
        <path d={OPENAI_PATH} fill="currentColor" />
      </svg>
    </span>
  )
}

export function RotBar(props: {
  context?: ContextHealth
  /** wall-clock ms — for the "compacted 3m ago" line in the tip */
  now: number
  /** when given, the mascot is clickable and opens the reincarnation dialog */
  sessionId?: string
  /** which CLI's mascot to draw — Clawd unless told otherwise */
  mark?: CliKind
}): React.JSX.Element | null {
  const rootRef = useRef<HTMLSpanElement>(null)
  const [tipPos, setTipPos] = useState<React.CSSProperties | null>(null)
  const ctx = props.context
  if (!ctx) return null
  const codex = props.mark === 'codex'
  const stage = rotStage(ctx.pct)
  const pctWord = `${Math.min(999, Math.round(ctx.pct * 100))}%`
  // rot creeps in past 50%: up to 12 of Clawd's 20 pixels dim before he dies;
  // the blossom loses up to 5 of its 6 petals the same way
  const decayBase = Math.min(1, Math.max(0, (ctx.pct - 0.5) / 0.5))
  const deadPixels = Math.round(Math.pow(decayBase, 1.4) * 12)
  const deadPetals = Math.round(Math.pow(decayBase, 1.4) * 5)
  const mascotName = codex ? 'the blossom' : 'Clawd'
  const cliName = codex ? 'Codex' : 'Claude Code'

  const STAGE_LINE: Record<string, string> = {
    fresh: 'Plenty of headroom.',
    rotting: 'Going stale — start thinking about the wrap-up.',
    late: 'Festering — the flies are circling. Wrap up or hand off soon.',
    dying: 'Barely breathing — compaction is close.',
    dead: 'Belly-up. Compaction imminent — wrap up NOW if you care what it remembers.'
  }

  function showTip(): void {
    const r = rootRef.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.max(8, Math.min(r.left, window.innerWidth - TIP_W - 12))
    const below = r.bottom + TIP_EST_H < window.innerHeight
    setTipPos(
      below
        ? { left, top: r.bottom + 6 }
        : { left, bottom: window.innerHeight - r.top + 6 }
    )
  }

  const sessionId = props.sessionId
  const open = sessionId
    ? (e: React.MouseEvent | React.KeyboardEvent): void => {
        // RotBar lives inside clickable cards — a click here means the mascot, not the card
        e.stopPropagation()
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('kamino:handoff', { detail: sessionId }))
      }
    : undefined

  return (
    <span
      ref={rootRef}
      className="rot"
      data-stage={stage}
      data-mark={codex ? 'codex' : 'claude'}
      data-clickable={open ? 'yes' : undefined}
      onMouseEnter={showTip}
      onMouseLeave={() => setTipPos(null)}
      onClick={open}
      onKeyDown={
        open
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') open(e)
            }
          : undefined
      }
      role={open ? 'button' : undefined}
      tabIndex={open ? 0 : undefined}
      aria-label={open ? `Context ${pctWord} full — transfer or compact` : undefined}
    >
      {codex ? <BlossomMascot deadPetals={deadPetals} /> : <ClawdMascot deadPixels={deadPixels} />}
      {stage !== 'fresh' && <span className="rot-label">ROT {pctWord}</span>}
      {ctx.compactions > 0 && (
        <span className="rot-scar">☠{ctx.compactions > 1 ? `×${ctx.compactions}` : ''}</span>
      )}
      {tipPos && (
        <span className="rot-tip" style={tipPos}>
          <span className="rot-tip-head">
            <span className="rot-tip-title">CONTEXT ROT</span>
            <span className="rot-tip-pct">
              {fmtTokens(ctx.tokens)} / {fmtTokens(ctx.window)} · {pctWord}
            </span>
          </span>
          <span className="rot-tip-body">
            How full this clone&apos;s memory (context window) is — {mascotName}&apos;s health is the
            meter. At ~100% {cliName} auto-compacts: the conversation is squashed into a summary and
            the details rot away — early instructions, file states, your corrections.
            {codex && ' Codex reports its window size exactly, so this reading is measured, not estimated.'}
          </span>
          <span className="rot-tip-stage">{STAGE_LINE[stage]}</span>
          {ctx.compactions > 0 && (
            <span className="rot-tip-scar">
              ☠ Compacted {ctx.compactions > 1 ? `${ctx.compactions}× ` : ''}this session
              {ctx.lastCompactAt ? ` (last ${agoShort(ctx.lastCompactAt, props.now)} ago)` : ''} —
              memory from before then is summary-only.
            </span>
          )}
          {open && (
            <span className="rot-tip-cta">
              Click {mascotName} → transfer this clone&apos;s working state to a fresh one, or compact
              in place.
            </span>
          )}
        </span>
      )}
    </span>
  )
}
