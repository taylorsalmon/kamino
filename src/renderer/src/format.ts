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

export const KIND_WORD: Record<string, string> = {
  embedded: 'in bay',
  external: 'field-deployed',
  background: 'covert ops',
  dead: 'archived'
}
