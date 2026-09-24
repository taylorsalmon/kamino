/**
 * Tests for the phone link.
 *
 * This server is remote control of the machine, so most of what's checked
 * here is the fence: off by default, nothing answered without the pairing
 * token, a rotated token locks the old one out, guessing gets throttled,
 * keystrokes only from the allowlist, launch bodies stripped to known
 * fields, and the desktop board's own files never served.
 *
 * Run with: npm test
 */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  cleanTunnelUrl,
  isTailnet,
  pasteSequence,
  RemoteServer,
  REMOTE_KEYS,
  toLaunchRequest,
  type RemoteDeps
} from '../src/main/remote-server'
import type { LaunchRequest, RemoteFleetState } from '../src/shared/types'

let failed = 0
let checks = 0

function check(label: string, actual: unknown, expected: unknown): void {
  checks++
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  failed++
  console.log(`FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── pure helpers ──────────────────────────────────────────────────────────

check('100.64.x is tailnet', isTailnet('100.64.0.1'), true)
check('100.101.x is tailnet', isTailnet('100.101.2.3'), true)
check('100.127.x is tailnet', isTailnet('100.127.255.1'), true)
check('100.63.x is not', isTailnet('100.63.0.1'), false)
check('100.128.x is not', isTailnet('100.128.0.1'), false)
check('LAN is not', isTailnet('192.168.1.20'), false)

check('paste wraps in bracketed paste, Enter separate', pasteSequence('fix it'), ['\x1b[200~fix it\x1b[201~', '\r'])
check('CRLF becomes LF, ends trimmed', pasteSequence('  a\r\nb\r  ')[0], '\x1b[200~a\nb\x1b[201~')

check('esc is ESC', REMOTE_KEYS.esc, '\x1b')
check('digits 1-9 present', ['1', '5', '9'].map((k) => REMOTE_KEYS[k]), ['1', '5', '9'])
check('no 0 key', REMOTE_KEYS['0'], undefined)

check('tunnel address reduced to its origin', cleanTunnelUrl('https://abc-47832.aue.devtunnels.ms/some/path#x'), 'https://abc-47832.aue.devtunnels.ms')
check('tunnel address must be https', cleanTunnelUrl('http://abc.devtunnels.ms'), null)
check('tunnel junk refused', cleanTunnelUrl('not a url'), null)
check('empty tunnel clears it', cleanTunnelUrl('  '), null)
check('absent tunnel leaves it alone', cleanTunnelUrl(undefined), undefined)

check('launch needs a cwd', toLaunchRequest({ initialPrompt: 'x' }), null)
check(
  'launch keeps only known, well-typed fields',
  toLaunchRequest({ cwd: ' C:/r ', worktree: true, autoShip: 'yes', evil: 1, initialPrompt: 42 }),
  {
    cwd: 'C:/r',
    worktree: true
  } satisfies Partial<LaunchRequest>
)

// ── the server ────────────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kamino-remote-'))
const staticRoot = path.join(tmp, 'renderer')
fs.mkdirSync(path.join(staticRoot, 'assets'), { recursive: true })
fs.writeFileSync(path.join(staticRoot, 'remote.html'), '<html>phone</html>')
fs.writeFileSync(path.join(staticRoot, 'index.html'), '<html>desktop</html>')
fs.writeFileSync(path.join(staticRoot, 'assets', 'app.js'), 'console.log(1)'.repeat(200))
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'nope')

const port = 48000 + Math.floor(Math.random() * 1500)
const settingsFile = path.join(tmp, 'remote.json')
fs.writeFileSync(settingsFile, JSON.stringify({ enabled: false, mode: 'tailscale', port, token: 'x'.repeat(32) }))

const writes: Array<[string, string]> = []
const launched: LaunchRequest[] = []
const events = new EventEmitter()
let tailnetUp = false

const STATE: RemoteFleetState = { host: 'test-pc', termTheme: 'dark', instances: [], ptys: [], pr: {}, updatedAt: 1 }

const deps: RemoteDeps = {
  state: () => STATE,
  clis: async () => [],
  projects: () => [{ cwd: tmp, lastUsed: 1 }],
  tail: () => [{ who: 'clone', text: 'hi' }],
  recap: async () => ({ text: 'recap', generatedAt: 1, fromCache: false }),
  raisePr: async () => ({ ok: true, number: 7, url: 'u' }),
  commission: async (req) => {
    launched.push(req)
    return { ptyId: 'pty-9', pid: 9, cwd: req.cwd, cli: 'claude' }
  },
  approveKeys: () => '1',
  pty: {
    exists: (id) => id === 'pty-1',
    write: (id, data) => writes.push([id, data]),
    kill: (id) => writes.push([id, 'KILL']),
    backlog: () => 'old output',
    size: () => ({ cols: 100, rows: 30 }),
    events
  },
  staticRoot,
  devUrl: null,
  interfaces: () => ({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: null }],
    wifi: [{ address: '192.168.1.20', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }],
    ...(tailnetUp
      ? { ts: [{ address: '100.99.1.2', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }] }
      : {})
  })
}

const base = `http://127.0.0.1:${port}`

async function get(p: string, token?: string): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  return { status: res.status, body: await res.text(), headers: res.headers }
}
async function post(p: string, body: unknown, token: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function run(): Promise<void> {
  const server = new RemoteServer(settingsFile, deps)
  server.start()
  await sleep(50)
  check('off by default: not listening', server.status().listening, false)
  check('off: no urls offered', server.status().urls, [])

  check('old mode: tailscale setting carries over as the tailscale method', server.settings().method, 'tailscale')
  const st = await server.setSettings({ enabled: true })
  check('on: listening on loopback', st.listening, true)
  check('tailscale method without a tailnet says so', st.tailscaleMissing, true)
  check('tailscale method never offers the Wi-Fi address', st.urls.some((u) => u.url.includes('192.168.')), false)
  check('LAN addresses reported for the Wi-Fi steps', st.lanAddresses, ['192.168.1.20'])
  const token = st.token
  check('token survives from the settings file', token, 'x'.repeat(32))

  // the fence
  check('no token → 401', (await get('/api/state')).status, 401)
  check('wrong token → 401', (await get('/api/state', 'y'.repeat(32))).status, 401)
  const ok = await get('/api/state', token)
  check('right token → 200', ok.status, 200)
  check('state comes from deps', JSON.parse(ok.body).host, 'test-pc')
  check('api is never cached', ok.headers.get('cache-control'), 'no-store')
  check('no CORS header — pages elsewhere cannot read it', ok.headers.get('access-control-allow-origin'), null)
  check('token in query works (EventSource)', (await get(`/api/projects?k=${token}`)).status, 200)
  const viaHeader = (key: string): Promise<Response> =>
    fetch(base + '/api/state', { headers: { 'X-Kamino-Key': key } })
  check('X-Kamino-Key works (tunnel drops Authorization)', (await viaHeader(token)).status, 200)
  check('wrong X-Kamino-Key → 401', (await viaHeader('y'.repeat(32))).status, 401)

  // the phone app, and nothing else
  const page = await get('/')
  check('/ serves the phone page without a token', [page.status, page.body], [200, '<html>phone</html>'])
  check('desktop board is not served', (await get('/index.html')).status, 404)
  check('no escaping the folder', (await get('/assets/../../secret.txt')).status, 404)
  check('encoded escape blocked too', (await get('/assets/%2e%2e/%2e%2e/secret.txt')).status, 404)
  const gz = await fetch(base + '/assets/app.js', { headers: { 'Accept-Encoding': 'gzip' } })
  check('assets go gzipped when asked', gz.headers.get('content-encoding'), 'gzip')
  check('gzipped asset still decodes', (await gz.text()).startsWith('console.log(1)'), true)

  // steering
  const sent = await post('/api/pty/pty-1/send', { text: 'run the tests' }, token)
  check('send → ok', sent.status, 200)
  check('send pastes first', writes.at(-1), ['pty-1', '\x1b[200~run the tests\x1b[201~'])
  await sleep(500)
  check('then presses Enter', writes.at(-1), ['pty-1', '\r'])
  check('empty message refused', (await post('/api/pty/pty-1/send', { text: '  ' }, token)).status, 400)
  check('huge message refused', (await post('/api/pty/pty-1/send', { text: 'x'.repeat(20_001) }, token)).status, 413)
  check('closed terminal → 404', (await post('/api/pty/pty-2/send', { text: 'hi' }, token)).status, 404)

  await post('/api/pty/pty-1/keys', { keys: ['approve'] }, token)
  check('approve uses the CLI approve keys', writes.at(-1), ['pty-1', '1'])
  await post('/api/pty/pty-1/keys', { keys: ['down', 'enter'] }, token)
  check('keys chain in order', writes.at(-1), ['pty-1', '\x1b[B\r'])
  const n = writes.length
  check('unknown key refused', (await post('/api/pty/pty-1/keys', { keys: ['enter', 'rm -rf /'] }, token)).status, 400)
  check('…and nothing typed at all', writes.length, n)

  // commissioning
  check('no cwd → 400', (await post('/api/commission', { initialPrompt: 'x' }, token)).status, 400)
  check('missing folder → 400', (await post('/api/commission', { cwd: path.join(tmp, 'nope') }, token)).status, 400)
  const c = await post('/api/commission', { cwd: tmp, initialPrompt: 'build it', worktree: true, junk: 1 }, token)
  check('commission → the new pty', c.json.ptyId, 'pty-9')
  check('commission gets a clean request', launched.at(-1), { cwd: tmp, initialPrompt: 'build it', worktree: true })

  // live stream: state up front, then pushes and alerts
  const ctrl = new AbortController()
  const res = await fetch(`${base}/api/stream?k=${token}`, { signal: ctrl.signal })
  const reader = res.body!.getReader()
  let buf = ''
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += new TextDecoder().decode(value)
      }
    } catch {
      /* aborted */
    }
  })()
  await sleep(100)
  check('stream opens with the state', buf.includes('event: state') && buf.includes('test-pc'), true)
  check('status counts the phone', server.status().clients, 1)
  server.alert({ kind: 'ask', sessionId: 's1', title: 'Rex awaits orders', body: 'Approve?', at: 1 })
  server.pushState()
  await sleep(450)
  check('alerts reach the phone', buf.includes('Rex awaits orders'), true)
  check('pushState sends a fresh state', (buf.match(/event: state/g) ?? []).length, 2)

  // screen mirror
  const sctrl = new AbortController()
  const sres = await fetch(`${base}/api/pty/pty-1/stream?k=${token}`, { signal: sctrl.signal })
  const sreader = sres.body!.getReader()
  let sbuf = ''
  const spump = (async () => {
    try {
      for (;;) {
        const { value, done } = await sreader.read()
        if (done) break
        sbuf += new TextDecoder().decode(value)
      }
    } catch {
      /* aborted */
    }
  })()
  await sleep(100)
  events.emit('data', 'pty-1', 'hello ')
  events.emit('data', 'pty-1', 'world')
  events.emit('data', 'pty-2', 'someone else')
  await sleep(150)
  check('mirror starts with size + backlog', sbuf.includes('"cols":100') && sbuf.includes('old output'), true)
  check('mirror batches its own bytes', sbuf.includes('"hello world"'), true)
  check("mirror ignores other terminals", sbuf.includes('someone else'), false)
  sctrl.abort()
  await spump
  await sleep(50)
  check('mirror unsubscribes on close', events.listenerCount('data'), 0)

  // unpairing
  const rotated = server.rotateToken()
  await pump
  ctrl.abort()
  check('rotate mints a new token', rotated.token !== token, true)
  check('rotate drops open streams', server.status().clients, 0)
  check('old token locked out', (await get('/api/state', token)).status, 401)
  check('new token works', (await get('/api/state', rotated.token)).status, 200)
  check('new token persisted', JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).token, rotated.token)

  // guessing gets throttled (a few failures already above, from this ip)
  for (let i = 0; i < 12; i++) await get('/api/state', 'guess' + i)
  check('guessing → 429', (await get('/api/state', 'guess-again')).status, 429)
  check('even the right token waits it out', (await get('/api/state', rotated.token)).status, 429)

  // a tailnet address appearing is offered as the way in
  tailnetUp = true
  const withTs = await server.setSettings({})
  check('tailnet url offered', withTs.urls[0]?.label, 'Tailscale')
  check('tailnet url has the port', withTs.urls[0]?.url, `http://100.99.1.2:${port}`)

  // the VS Code tunnel: loopback only, the forwarded address is the way in
  const tun = await server.setSettings({ method: 'tunnel', tunnelUrl: 'https://abc-47832.aue.devtunnels.ms/' })
  check('tunnel method offers the tunnel first', tun.urls[0], { label: 'VS Code tunnel', url: 'https://abc-47832.aue.devtunnels.ms' })
  check('tunnel method offers no network address', tun.urls.some((u) => /100\.99|192\.168/.test(u.url)), false)
  check('tunnel method still listens (loopback)', tun.listening, true)
  const badTun = await server.setSettings({ tunnelUrl: 'http://plain.example' })
  check('a non-https tunnel address is refused', badTun.settings.tunnelUrl, undefined)
  check('tunnel address persisted as cleared', JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).tunnelUrl, undefined)
  check('method persisted', JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).method, 'tunnel')

  const off = await server.setSettings({ enabled: false })
  check('off again: stops listening', off.listening, false)
  let refused = false
  try {
    await fetch(base + '/')
  } catch {
    refused = true
  }
  check('off: port closed', refused, true)
  await server.stop()
}

run()
  .catch((e) => {
    failed++
    console.log('FAIL threw', e)
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    console.log(`${checks - failed}/${checks} remote-server checks passed`)
    process.exit(failed ? 1 : 0)
  })
