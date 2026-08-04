export function agoShort(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function elapsed(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

// Kamino vocabulary — clone status callouts. Meaning must stay instantly
// readable: ENGAGED = mid-turn, AWAITING ORDERS = blocked on you.
export const STATE_WORD: Record<string, string> = {
  busy: 'ENGAGED',
  'needs-you': 'AWAITING ORDERS',
  idle: 'STANDING BY',
  dead: 'DECOMMISSIONED'
}

/** needs-you refined by WHY it needs you — the triage signal. */
export function stateWord(state: string, askKind?: string): string {
  if (state === 'needs-you') {
    if (askKind === 'question') return 'ANSWER NEEDED'
    if (askKind === 'plan') return 'PLAN READY'
    if (askKind === 'permission') return 'APPROVE?'
  }
  return STATE_WORD[state] ?? state
}

/** Rotating flavor lines for empty states and dialogs — never for errors or
 *  anything the user needs to parse under pressure. */
const JEDI_QUOTES = [
  '“Do. Or do not. There is no try.” — Yoda',
  '“Your focus determines your reality.” — Qui-Gon Jinn',
  '“In my experience there’s no such thing as luck.” — Obi-Wan Kenobi',
  '“Patience you must have, my young Padawan.” — Yoda',
  '“The Force will be with you. Always.” — Obi-Wan Kenobi',
  '“This is where the fun begins.” — Anakin Skywalker',
  '“A surprise, to be sure, but a welcome one.” — Sheev Palpatine',
  '“Great, kid. Don’t get cocky.” — Han Solo',
  '“Never tell me the odds.” — Han Solo',
  '“Begun, the Clone War has.” — Yoda',
  '“I find your lack of tests disturbing.” — almost Vader',
  '“These aren’t the droids you’re looking for.” — Obi-Wan Kenobi'
]

/** Stable within the hour so the UI doesn't flicker between renders. */
export function jediQuote(offset = 0): string {
  const hourly = Math.floor(Date.now() / 3_600_000)
  return JEDI_QUOTES[(hourly + offset) % JEDI_QUOTES.length]
}

import type { PrStatus } from '../../shared/types'

export interface PrBadge {
  /** one glyph for the chip */
  glyph: string
  /** CSS tone: pass | fail | pending | merged | closed | unknown */
  tone: string
  /** short words for wider surfaces (detail panel) */
  words: string
  /** full hover text */
  title: string
}

/** Live decoration for a PR chip; null (plain chip) when no status yet. */
export function prBadge(st: PrStatus | undefined): PrBadge | null {
  if (!st) return null
  const review =
    st.reviewDecision === 'APPROVED'
      ? 'approved'
      : st.reviewDecision === 'CHANGES_REQUESTED'
        ? 'changes requested'
        : ''
  const checksWord =
    st.checks === 'pass'
      ? 'checks passing'
      : st.checks === 'fail'
        ? `${st.checksFailed}/${st.checksTotal} checks failing`
        : st.checks === 'pending'
          ? 'checks running'
          : ''
  const parts: string[] = []
  let glyph: string
  let tone: string
  let words: string
  if (st.state === 'merged') {
    glyph = '◆'
    tone = 'merged'
    words = 'merged'
    parts.push('merged')
  } else if (st.state === 'closed') {
    glyph = '⊘'
    tone = 'closed'
    words = 'closed'
    parts.push('closed')
  } else if (st.state === 'unknown') {
    glyph = '?'
    tone = 'unknown'
    words = 'status unknown'
    parts.push(st.error ?? 'status unknown')
  } else {
    parts.push(st.isDraft ? 'draft' : 'open')
    if (checksWord) parts.push(checksWord)
    if (review) parts.push(review)
    if (st.checks === 'fail') {
      glyph = '✕'
      tone = 'fail'
      words = 'checks failing'
    } else if (st.checks === 'pending') {
      glyph = '●'
      tone = 'pending'
      words = 'checks running'
    } else if (review === 'changes requested') {
      glyph = '±'
      tone = 'fail'
      words = 'changes requested'
    } else if (st.checks === 'pass') {
      glyph = '✓'
      tone = 'pass'
      words = review === 'approved' ? 'passing · approved' : 'checks passing'
    } else {
      glyph = '○'
      tone = 'open'
      words = review || (st.isDraft ? 'draft' : 'open')
    }
  }
  if (st.stale) parts.push(`last check failed (${st.error ?? 'gh error'}) — showing last-known status`)
  return { glyph, tone, words, title: `PR #${st.number} — ${parts.join(' · ')}` }
}

export const KIND_WORD: Record<string, string> = {
  embedded: 'in bay',
  external: 'field-deployed',
  background: 'covert ops',
  dead: 'archived'
}
