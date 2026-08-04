import { useRef, useState } from 'react'
import type { ContextHealth } from '../../../shared/types'
import { agoShort, fmtTokens, rotStage } from '../format'

const TIP_W = 280
const TIP_EST_H = 170

/**
 * RotBar — context rot at a glance, told through Clawd's health. The block-
 * glyph mascot from the Claude Code welcome screen IS the meter: fresh he
 * bobs and blinks orange; as the context window fills he stales, slumps,
 * draws flies, and at ~100% (auto-compact — the forced summary that loses
 * detail) he's belly-up while his soul drifts off. He's drawn in block
 * characters, so his pixels die one by one — feet first, core last.
 * All the numbers and the explanation live in the hover tip.
 *
 * The tip is position:fixed and placed by JS — every row that hosts Clawd
 * (card meta, pane title) clips overflow, so an absolutely-positioned tip
 * would be cut off.
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

export function RotBar(props: {
  context?: ContextHealth
  /** wall-clock ms — for the "compacted 3m ago" line in the tip */
  now: number
}): React.JSX.Element | null {
  const rootRef = useRef<HTMLSpanElement>(null)
  const [tipPos, setTipPos] = useState<React.CSSProperties | null>(null)
  const ctx = props.context
  if (!ctx) return null
  const stage = rotStage(ctx.pct)
  const pctWord = `${Math.min(999, Math.round(ctx.pct * 100))}%`
  // rot creeps in past 50%: up to 12 of Clawd's 20 pixels dim before he dies
  const decayBase = Math.min(1, Math.max(0, (ctx.pct - 0.5) / 0.5))
  const deadPixels = Math.round(Math.pow(decayBase, 1.4) * 12)

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

  return (
    <span
      ref={rootRef}
      className="rot"
      data-stage={stage}
      onMouseEnter={showTip}
      onMouseLeave={() => setTipPos(null)}
    >
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
                    className={
                      (DECAY_INDEX.get(`${r}-${c}`) ?? 99) < deadPixels ? 'px-dead' : undefined
                    }
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
            How full this clone&apos;s memory (context window) is — Clawd&apos;s health is the
            meter. At ~100% Claude Code auto-compacts: the conversation is squashed into a
            summary and the details rot away — early instructions, file states, your corrections.
          </span>
          <span className="rot-tip-stage">{STAGE_LINE[stage]}</span>
          {ctx.compactions > 0 && (
            <span className="rot-tip-scar">
              ☠ Compacted {ctx.compactions > 1 ? `${ctx.compactions}× ` : ''}this session
              {ctx.lastCompactAt ? ` (last ${agoShort(ctx.lastCompactAt, props.now)} ago)` : ''} —
              memory from before then is summary-only.
            </span>
          )}
        </span>
      )}
    </span>
  )
}
