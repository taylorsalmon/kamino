/**
 * The phone's line to Kamino: the pairing token, JSON calls, and the live
 * state stream. The token arrives once in the QR link (#k=…) and is kept —
 * in the URL too, because iOS gives a Home Screen app its own storage and
 * the link it was saved from is all it has.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteAlert, RemoteFleetState } from '../../shared/types'

const TOKEN_KEY = 'kamino:token'

export function readToken(): string | null {
  const m = /[#&]k=([^&]+)/.exec(location.hash)
  if (m) {
    const t = decodeURIComponent(m[1])
    try {
      localStorage.setItem(TOKEN_KEY, t)
    } catch {
      /* private mode — the URL still carries it */
    }
    return t
  }
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function forgetToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* nothing stored */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

let token: string | null = readToken()

export function hasToken(): boolean {
  return !!token
}

export function setToken(t: string): void {
  token = t
  try {
    localStorage.setItem(TOKEN_KEY, t)
  } catch {
    /* ignore */
  }
  history.replaceState(null, '', `${location.pathname}#k=${encodeURIComponent(t)}`)
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token ?? ''}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch {
    throw new ApiError("Can't reach Kamino. Is the PC awake and on the network?", 0)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data?.error ?? `Kamino said ${res.status}`, res.status)
  return data as T
}

export const send = (ptyId: string, text: string): Promise<unknown> =>
  api(`pty/${encodeURIComponent(ptyId)}/send`, { text })

export const keys = (ptyId: string, k: string[]): Promise<unknown> =>
  api(`pty/${encodeURIComponent(ptyId)}/keys`, { keys: k })

export function streamUrl(path: string): string {
  return `/api/${path}?k=${encodeURIComponent(token ?? '')}`
}

export type Link = 'connecting' | 'live' | 'offline' | 'unpaired'

/**
 * The live board. One EventSource for state + alerts; when it drops (phone
 * locked, network change) it's rebuilt as soon as the page is visible again,
 * and a plain GET first tells an expired pairing apart from a dead link.
 */
export function useFleet(onAlert: (a: RemoteAlert) => void): {
  state: RemoteFleetState | null
  link: Link
  reconnect: () => void
} {
  const [state, setState] = useState<RemoteFleetState | null>(null)
  const [link, setLink] = useState<Link>(token ? 'connecting' : 'unpaired')
  const esRef = useRef<EventSource | null>(null)
  // bumped on every connect and on unmount: a connect still awaiting its
  // first GET when a newer one starts must not open a second stream
  const gen = useRef(0)
  const alertRef = useRef(onAlert)
  alertRef.current = onAlert

  const connect = useCallback(async () => {
    const mine = ++gen.current
    esRef.current?.close()
    esRef.current = null
    if (!token) {
      setLink('unpaired')
      return
    }
    try {
      const first = await api<RemoteFleetState>('state')
      if (mine !== gen.current) return
      setState(first)
    } catch (e) {
      if (mine !== gen.current) return
      setLink(e instanceof ApiError && e.status === 401 ? 'unpaired' : 'offline')
      return
    }
    const es = new EventSource(streamUrl('stream'))
    esRef.current = es
    es.onopen = () => setLink('live')
    es.addEventListener('state', (ev) => {
      setState(JSON.parse((ev as MessageEvent).data))
      setLink('live')
    })
    es.addEventListener('alert', (ev) => alertRef.current(JSON.parse((ev as MessageEvent).data)))
    es.onerror = () => {
      // EventSource retries by itself; a CLOSED one never will
      setLink('offline')
      if (es.readyState === EventSource.CLOSED && mine === gen.current) setTimeout(() => void connect(), 3000)
    }
  }, [])

  useEffect(() => {
    void connect()
    const onVis = (): void => {
      if (document.visibilityState !== 'visible') return
      const es = esRef.current
      if (!es || es.readyState !== EventSource.OPEN) void connect()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onVis)
      gen.current++
      esRef.current?.close()
      esRef.current = null
    }
  }, [connect])

  return { state, link, reconnect: () => void connect() }
}
