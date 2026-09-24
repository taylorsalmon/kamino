/**
 * RemoteServer — the phone link. Serves the mobile board (src/renderer/remote)
 * and a small JSON + Server-Sent-Events API over it, so the fleet can be
 * watched, answered and commissioned from a phone.
 *
 * It is remote control of this machine by design, so the defaults are narrow:
 * off until switched on, loopback + the tailnet address only (Tailscale does
 * the encryption and the who-may-connect), and every API call carries a
 * pairing token that only ever leaves the desktop inside the QR code. No CORS
 * headers are sent, so no web page can read the API even from inside the LAN.
 *
 * Pure Node — no Electron — so the test script can drive it directly.
 */
import { EventEmitter } from 'node:events'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import type {
  LaunchRequest,
  PrCreateResult,
  PtyInfo,
  RecentProject,
  RemoteAlert,
  RemoteCli,
  RemoteFleetState,
  RemoteMethod,
  RemoteSettings,
  RemoteStatus,
  RemoteUrl,
  TranscriptTailMsg
} from '../shared/types'

export const REMOTE_PORT = 47832

/** What the phone reaches through. Everything else stays in index.ts. */
export interface RemoteDeps {
  state(): RemoteFleetState
  clis(): Promise<RemoteCli[]>
  projects(): RecentProject[]
  tail(sessionId: string): TranscriptTailMsg[]
  recap(sessionId: string): Promise<{ text: string; generatedAt: number; fromCache: boolean }>
  raisePr(sessionId: string): Promise<PrCreateResult>
  commission(req: LaunchRequest): Promise<PtyInfo>
  /** keystrokes that take the Allow in this terminal's CLI */
  approveKeys(ptyId: string): string
  pty: {
    exists(ptyId: string): boolean
    write(ptyId: string, data: string): void
    kill(ptyId: string): void
    backlog(ptyId: string): string
    size(ptyId: string): { cols: number; rows: number } | null
    /** emits 'data' (ptyId, data), 'exit' (ptyId, code), 'resize' (ptyId, cols, rows) */
    events: EventEmitter
  }
  /** built phone app (out/renderer) — null in dev, where devUrl serves it */
  staticRoot: string | null
  /** the renderer's vite dev server, proxied in dev */
  devUrl: string | null
  /** os.networkInterfaces, swappable for tests */
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>
}

/**
 * Named keys the phone may press. An allowlist rather than raw bytes: a key
 * strip is all the screen mirror needs, and anything longer goes through
 * /send as a bracketed paste.
 */
export const REMOTE_KEYS: Record<string, string> = {
  enter: '\r',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  'ctrl-c': '\x03',
  backspace: '\x7f',
  space: ' ',
  y: 'y',
  n: 'n',
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), String(i + 1)]))
}

/** How a message lands: bracketed paste so newlines are text, then Enter a
 *  beat later — the same path handoff and the arbiter use to seed a clone. */
export function pasteSequence(text: string): [string, string] {
  const body = text.replace(/\r\n?/g, '\n').trim()
  return [`\x1b[200~${body}\x1b[201~`, '\r']
}

const SUBMIT_DELAY_MS = 400
const MAX_TEXT = 20_000
const MAX_BODY = 64_000
const STATE_THROTTLE_MS = 300
const PING_MS = 20_000
const REBIND_MS = 20_000
const FAIL_WINDOW_MS = 60_000
const FAIL_LIMIT = 12

interface Stored extends RemoteSettings {
  token: string
}

interface StreamClient {
  res: http.ServerResponse
  ping: NodeJS.Timeout
}

// the tunnel method listens on loopback only — the safest default to start from
const DEFAULTS: RemoteSettings = { enabled: false, method: 'tunnel', port: REMOTE_PORT }

const METHODS: RemoteMethod[] = ['wifi', 'tunnel', 'tailscale']

/**
 * The address VS Code forwarded the port to, reduced to its origin. Pasted by
 * hand, so anything that isn't an https origin is refused rather than guessed.
 */
export function cleanTunnelUrl(v: unknown): string | undefined | null {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || !v.trim()) return null // cleared
  try {
    const u = new URL(v.trim())
    return u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

function newToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

/** 100.64.0.0/10 — the CGNAT block Tailscale hands out tailnet addresses from */
export function isTailnet(ip: string): boolean {
  const m = /^100\.(\d+)\./.exec(ip)
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
}
const TEXTUAL = new Set(['.html', '.js', '.css', '.svg', '.webmanifest'])

export class RemoteServer extends EventEmitter {
  private stored: Stored
  private servers: http.Server[] = []
  private boundTo: string[] = []
  private streams = new Set<StreamClient>()
  private lastSeenAt: number | undefined
  private error: string | undefined
  private stateTimer: NodeJS.Timeout | null = null
  private rebindTimer: NodeJS.Timeout | null = null
  private fails = new Map<string, { n: number; until: number }>()

  constructor(
    private readonly file: string,
    private readonly deps: RemoteDeps
  ) {
    super()
    this.stored = this.load()
  }

  // ── settings ─────────────────────────────────────────────────────────

  private load(): Stored {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
      // earliest builds stored mode: 'lan' | 'tailscale'
      const legacy = raw.mode === 'lan' ? 'wifi' : raw.mode === 'tailscale' ? 'tailscale' : undefined
      return {
        enabled: raw.enabled === true,
        method: METHODS.includes(raw.method) ? raw.method : (legacy ?? DEFAULTS.method),
        port: Number.isInteger(raw.port) && raw.port > 1024 && raw.port < 65536 ? raw.port : REMOTE_PORT,
        tunnelUrl: cleanTunnelUrl(raw.tunnelUrl) ?? undefined,
        token: typeof raw.token === 'string' && raw.token.length >= 24 ? raw.token : newToken()
      }
    } catch {
      return { ...DEFAULTS, token: newToken() }
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.stored, null, 2))
    } catch (e) {
      console.warn('[remote] could not save settings', e)
    }
  }

  settings(): RemoteSettings {
    const { enabled, method, port, tunnelUrl } = this.stored
    return { enabled, method, port, tunnelUrl }
  }

  async setSettings(next: Partial<RemoteSettings>): Promise<RemoteStatus> {
    if (typeof next.enabled === 'boolean') this.stored.enabled = next.enabled
    if (next.method && METHODS.includes(next.method)) this.stored.method = next.method
    const tunnel = cleanTunnelUrl(next.tunnelUrl)
    if (tunnel !== undefined) this.stored.tunnelUrl = tunnel ?? undefined
    this.save()
    await this.rebind()
    return this.status()
  }

  /** Unpairs every phone: the old QR stops working and open streams drop. */
  rotateToken(): RemoteStatus {
    this.stored.token = newToken()
    this.save()
    for (const c of [...this.streams]) this.dropStream(c)
    this.changed()
    return this.status()
  }

  status(): RemoteStatus {
    const { tailnet, lan } = this.addresses()
    return {
      settings: this.settings(),
      listening: this.servers.length > 0,
      urls: this.urls(),
      token: this.stored.token,
      clients: this.streams.size,
      lastSeenAt: this.lastSeenAt,
      tailscaleMissing: this.stored.enabled && this.stored.method === 'tailscale' && tailnet.length === 0,
      lanAddresses: lan,
      error: this.error
    }
  }

  private changed(): void {
    this.emit('status', this.status())
  }

  // ── binding ──────────────────────────────────────────────────────────

  private addresses(): { tailnet: string[]; lan: string[] } {
    const tailnet: string[] = []
    const lan: string[] = []
    const ifaces = (this.deps.interfaces ?? os.networkInterfaces)()
    for (const list of Object.values(ifaces)) {
      for (const a of list ?? []) {
        if (a.family !== 'IPv4' || a.internal) continue
        if (isTailnet(a.address)) tailnet.push(a.address)
        else if (!a.address.startsWith('169.254.')) lan.push(a.address)
      }
    }
    return { tailnet, lan }
  }

  /** Loopback always (tunnels, tailscale serve, desktop testing); plus the
   *  tailnet address for tailscale; every interface for wifi. */
  private wantedHosts(): string[] {
    if (!this.stored.enabled) return []
    if (this.stored.method === 'wifi') return ['0.0.0.0']
    if (this.stored.method === 'tunnel') return ['127.0.0.1']
    return ['127.0.0.1', ...this.addresses().tailnet]
  }

  /** The addresses a phone can use for the chosen method, best first. */
  private urls(): RemoteUrl[] {
    if (!this.stored.enabled) return []
    const { port, method, tunnelUrl } = this.stored
    const { tailnet, lan } = this.addresses()
    const out: RemoteUrl[] = []
    if (method === 'tunnel' && tunnelUrl) out.push({ label: 'VS Code tunnel', url: tunnelUrl })
    if (method === 'tailscale') for (const ip of tailnet) out.push({ label: 'Tailscale', url: `http://${ip}:${port}` })
    if (method === 'wifi') {
      for (const ip of lan) out.push({ label: 'Wi-Fi', url: `http://${ip}:${port}`, exposed: true })
      // 0.0.0.0 covers the tailnet too, if there is one
      for (const ip of tailnet) out.push({ label: 'Tailscale', url: `http://${ip}:${port}` })
    }
    out.push({ label: 'This PC', url: `http://127.0.0.1:${port}` })
    return out
  }

  start(): void {
    void this.rebind()
    // a tailnet address can come and go (Tailscale started after Kamino,
    // laptop re-joined) — keep the listeners matching what exists
    this.rebindTimer = setInterval(() => {
      const want = this.wantedHosts()
      if (want.join() !== this.boundTo.join()) void this.rebind()
    }, REBIND_MS)
  }

  private async rebind(): Promise<void> {
    const want = this.wantedHosts()
    await this.closeServers()
    this.error = undefined
    const port = this.stored.port
    for (const host of want) {
      const server = http.createServer((req, res) => this.handle(req, res))
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, host, () => {
            server.off('error', reject)
            resolve()
          })
        })
        this.servers.push(server)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        this.error =
          code === 'EADDRINUSE'
            ? `Port ${port} is taken on ${host} — another Kamino, or something else, holds it.`
            : `Could not listen on ${host}:${port} — ${(e as Error).message}`
      }
    }
    this.boundTo = want
    this.changed()
  }

  private async closeServers(): Promise<void> {
    for (const c of [...this.streams]) this.dropStream(c)
    const closing = this.servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve())
          s.closeAllConnections?.()
        })
    )
    this.servers = []
    await Promise.all(closing)
  }

  async stop(): Promise<void> {
    if (this.rebindTimer) clearInterval(this.rebindTimer)
    this.rebindTimer = null
    if (this.stateTimer) clearTimeout(this.stateTimer)
    this.stateTimer = null
    await this.closeServers()
  }

  /** Where the server is actually listening — tests bind port 0. */
  boundPort(): number | null {
    const a = this.servers[0]?.address()
    return a && typeof a === 'object' ? a.port : null
  }

  // ── push ─────────────────────────────────────────────────────────────

  /** Fleet changed — coalesced, because snapshots arrive in bursts. */
  pushState(): void {
    if (this.streams.size === 0 || this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      this.broadcast('state', this.deps.state())
    }, STATE_THROTTLE_MS)
  }

  alert(a: RemoteAlert): void {
    this.broadcast('alert', a)
  }

  private broadcast(event: string, data: unknown): void {
    if (this.streams.size === 0) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const c of this.streams) c.res.write(frame)
  }

  private dropStream(c: StreamClient): void {
    clearInterval(c.ping)
    this.streams.delete(c)
    c.res.end()
  }

  // ── requests ─────────────────────────────────────────────────────────

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const url = new URL(req.url ?? '/', 'http://kamino')
    if (!url.pathname.startsWith('/api/')) {
      this.serveApp(req, res, url)
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    const ip = req.socket.remoteAddress ?? '?'
    const lock = this.fails.get(ip)
    if (lock && lock.n >= FAIL_LIMIT && Date.now() < lock.until) {
      this.json(res, 429, { error: 'Too many bad pairing attempts — wait a minute.' })
      return
    }
    if (!this.authorised(req, url)) {
      const f = lock && Date.now() < lock.until ? lock : { n: 0, until: Date.now() + FAIL_WINDOW_MS }
      f.n++
      this.fails.set(ip, f)
      this.json(res, 401, { error: 'Not paired — scan the QR code in Kamino again.' })
      return
    }
    this.fails.delete(ip)
    this.lastSeenAt = Date.now()
    this.route(req, res, url).catch((e) => {
      if (!res.headersSent) this.json(res, 500, { error: e instanceof Error ? e.message : String(e) })
    })
  }

  private authorised(req: http.IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization
    const given = header?.startsWith('Bearer ')
      ? header.slice(7)
      : // EventSource cannot set headers, so streams carry it in the query
        url.searchParams.get('k') ?? ''
    const a = crypto.createHash('sha256').update(given).digest()
    const b = crypto.createHash('sha256').update(this.stored.token).digest()
    return given.length > 0 && crypto.timingSafeEqual(a, b)
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent) // ['api', ...]
    const [, a, id, b] = parts
    const method = req.method ?? 'GET'

    if (method === 'GET' && a === 'state') return this.json(res, 200, this.deps.state())
    if (method === 'GET' && a === 'stream') return this.openStream(res)
    if (method === 'GET' && a === 'clis') return this.json(res, 200, await this.deps.clis())
    if (method === 'GET' && a === 'projects') return this.json(res, 200, this.deps.projects())

    if (a === 'session' && id) {
      if (method === 'GET' && b === 'tail') return this.json(res, 200, this.deps.tail(id))
      if (method === 'POST' && b === 'recap') return this.json(res, 200, await this.deps.recap(id))
      if (method === 'POST' && b === 'pr') return this.json(res, 200, await this.deps.raisePr(id))
    }

    if (method === 'POST' && a === 'commission') {
      const body = await this.body(req)
      const reqBody = toLaunchRequest(body)
      if (!reqBody) return this.json(res, 400, { error: 'Pick a project folder first.' })
      if (!isDir(reqBody.cwd)) return this.json(res, 400, { error: `No folder at ${reqBody.cwd}` })
      const info = await this.deps.commission(reqBody)
      return this.json(res, 200, info)
    }

    if (a === 'pty' && id) {
      if (!this.deps.pty.exists(id)) return this.json(res, 404, { error: 'That terminal has closed.' })
      if (method === 'GET' && b === 'stream') return this.openScreen(res, id)
      if (method === 'POST' && b === 'send') {
        const body = await this.body(req)
        const text = typeof body.text === 'string' ? body.text : ''
        if (!text.trim()) return this.json(res, 400, { error: 'Nothing to send.' })
        if (text.length > MAX_TEXT) return this.json(res, 413, { error: 'That message is too long.' })
        const [paste, submit] = pasteSequence(text)
        this.deps.pty.write(id, paste)
        setTimeout(() => this.deps.pty.write(id, submit), SUBMIT_DELAY_MS)
        return this.json(res, 200, { ok: true })
      }
      if (method === 'POST' && b === 'keys') {
        const body = await this.body(req)
        const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === 'string') : []
        const seq: string[] = []
        for (const k of keys.slice(0, 16)) {
          const bytes = k === 'approve' ? this.deps.approveKeys(id) : REMOTE_KEYS[k]
          if (bytes === undefined) return this.json(res, 400, { error: `Unknown key: ${k}` })
          seq.push(bytes)
        }
        this.deps.pty.write(id, seq.join(''))
        return this.json(res, 200, { ok: true })
      }
      if (method === 'POST' && b === 'kill') {
        this.deps.pty.kill(id)
        return this.json(res, 200, { ok: true })
      }
    }

    this.json(res, 404, { error: 'No such endpoint.' })
  }

  /** The board's live feed: the whole state up front, then every change. */
  private openStream(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    res.write('retry: 3000\n\n')
    res.write(`event: state\ndata: ${JSON.stringify(this.deps.state())}\n\n`)
    const client: StreamClient = { res, ping: setInterval(() => res.write(': ping\n\n'), PING_MS) }
    this.streams.add(client)
    res.on('close', () => {
      clearInterval(client.ping)
      if (this.streams.delete(client)) this.changed()
    })
    this.changed()
  }

  /** One terminal, mirrored: its scrollback, then its bytes as they come.
   *  Chunks are batched so a busy TUI isn't hundreds of events a second. */
  private openScreen(res: http.ServerResponse, ptyId: string): void {
    const ev = this.deps.pty.events
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    const size = this.deps.pty.size(ptyId) ?? { cols: 120, rows: 32 }
    res.write(`event: init\ndata: ${JSON.stringify({ ...size, backlog: this.deps.pty.backlog(ptyId) })}\n\n`)
    let pending = ''
    let flush: NodeJS.Timeout | null = null
    const onData = (id: string, data: string): void => {
      if (id !== ptyId) return
      pending += data
      flush ??= setTimeout(() => {
        flush = null
        res.write(`event: data\ndata: ${JSON.stringify(pending)}\n\n`)
        pending = ''
      }, 50)
    }
    const onResize = (id: string, cols: number, rows: number): void => {
      if (id === ptyId) res.write(`event: resize\ndata: ${JSON.stringify({ cols, rows })}\n\n`)
    }
    const onExit = (id: string, code: number): void => {
      if (id !== ptyId) return
      res.write(`event: exit\ndata: ${JSON.stringify({ code })}\n\n`)
      res.end()
    }
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
    ev.on('data', onData)
    ev.on('resize', onResize)
    ev.on('exit', onExit)
    res.on('close', () => {
      clearInterval(ping)
      if (flush) clearTimeout(flush)
      ev.off('data', onData)
      ev.off('resize', onResize)
      ev.off('exit', onExit)
    })
  }

  // ── the phone app itself ─────────────────────────────────────────────

  private serveApp(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    if (this.deps.devUrl) {
      this.proxyDev(req, res, url)
      return
    }
    const root = this.deps.staticRoot
    const rel = url.pathname === '/' ? 'remote.html' : url.pathname.slice(1)
    // the desktop board lives in the same folder — serve only the phone's files
    const allowed = rel === 'remote.html' || rel.startsWith('assets/') || rel.startsWith('remote/')
    const file = root ? path.resolve(root, rel) : ''
    if (!root || !allowed || !file.startsWith(path.resolve(root) + path.sep)) {
      res.writeHead(404).end()
      return
    }
    fs.readFile(file, (err, raw) => {
      if (err) {
        res.writeHead(404).end()
        return
      }
      const ext = path.extname(file)
      // the shared chunk is ~1 MB — worth squeezing for a phone on mobile data
      const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'])) && TEXTUAL.has(ext)
      const buf = gzip ? this.gzipped(file, raw) : raw
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        // hashed assets never change; the page must, so updates land
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
        ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {})
      })
      res.end(req.method === 'HEAD' ? undefined : buf)
    })
  }

  private gzCache = new Map<string, { size: number; mtime: number; gz: Buffer }>()

  /** Compressed once per file version; a new build (new mtime) recompresses. */
  private gzipped(file: string, raw: Buffer): Buffer {
    let mtime = 0
    try {
      mtime = fs.statSync(file).mtimeMs
    } catch {
      /* read just succeeded; a stat failure only costs the cache */
    }
    const hit = this.gzCache.get(file)
    if (hit && hit.size === raw.length && hit.mtime === mtime) return hit.gz
    const gz = zlib.gzipSync(raw)
    this.gzCache.set(file, { size: raw.length, mtime, gz })
    return gz
  }

  /** In dev the page comes from the renderer's vite server (no HMR socket —
   *  reload the phone to pick up changes). */
  private proxyDev(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const target = new URL(url.pathname === '/' ? '/remote.html' : url.pathname + url.search, this.deps.devUrl!)
    const up = http.request(target, { method: req.method, headers: { accept: req.headers.accept ?? '*/*' } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => res.writeHead(502).end('Kamino dev server not reachable'))
    up.end()
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private json(res: http.ServerResponse, code: number, data: unknown): void {
    const body = JSON.stringify(data)
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

  private body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (c) => {
        raw += c
        if (raw.length > MAX_BODY) {
          reject(new Error('Request too large'))
          req.destroy()
        }
      })
      req.on('end', () => {
        try {
          const v = JSON.parse(raw || '{}')
          resolve(v && typeof v === 'object' ? v : {})
        } catch {
          reject(new Error('Malformed request'))
        }
      })
      req.on('error', reject)
    })
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

/** Only the fields a launch takes, each type-checked — the body is from the network. */
export function toLaunchRequest(b: Record<string, unknown>): LaunchRequest | null {
  const cwd = str(b.cwd)
  if (!cwd) return null
  return {
    cwd,
    cli: str(b.cli),
    resumeSessionId: str(b.resumeSessionId),
    initialPrompt: str(b.initialPrompt),
    permissionMode: str(b.permissionMode),
    model: str(b.model),
    autoShip: bool(b.autoShip),
    linear: bool(b.linear),
    linearIssue: str(b.linearIssue),
    worktree: bool(b.worktree),
    worktreeName: str(b.worktreeName)
  }
}
