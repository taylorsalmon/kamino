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

export const KIND_WORD: Record<string, string> = {
  embedded: 'in bay',
  external: 'field-deployed',
  background: 'covert ops',
  dead: 'archived'
}
