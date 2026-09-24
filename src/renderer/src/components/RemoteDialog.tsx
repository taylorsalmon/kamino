import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { RemoteMethod, RemoteSettings, RemoteStatus, RemoteUrl } from '../../../shared/types'
import { agoShort } from '../format'

/**
 * Phone link — the switch, a step-by-step guide for each way a phone can
 * reach this PC, and the pairing QR. The QR is the only place the pairing
 * secret ever appears; unpairing mints a new one and logs every phone out.
 */

const METHODS: Array<{ id: RemoteMethod; title: string; tag: string; body: string }> = [
  {
    id: 'tunnel',
    title: 'VS Code tunnel',
    tag: 'No install · works anywhere',
    body: "VS Code's built-in port forwarding. Private to your GitHub account, over HTTPS."
  },
  {
    id: 'wifi',
    title: 'Home Wi-Fi',
    tag: 'No install · same Wi-Fi only',
    body: 'Quickest to set up. Plain HTTP, so only on a network you trust.'
  },
  {
    id: 'tailscale',
    title: 'Tailscale',
    tag: 'Needs install · works anywhere',
    body: 'A private network between your own devices. Needs IT to approve the install.'
  }
]

const IT_REQUEST = `Hi, could I get approval to install Tailscale (tailscale.com) on my laptop? I use it to securely reach an internal dev tool on my laptop from my phone. It creates an encrypted private connection between my own two devices only (WireGuard, signed in with my work account), and it opens no inbound ports to the internet. Happy to use a company-managed tailnet if you prefer.`

export function RemoteDialog(props: { onClose: () => void; now: number }): React.JSX.Element {
  const [st, setSt] = useState<RemoteStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.fleet.remoteGet().then(setSt)
    return window.fleet.onRemote(setSt)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  const s = st?.settings
  const on = !!s?.enabled
  const connected = (st?.clients ?? 0) > 0

  async function set(next: Partial<RemoteSettings>): Promise<RemoteStatus | null> {
    setBusy(true)
    try {
      const res = await window.fleet.remoteSet(next)
      setSt(res)
      return res
    } finally {
      setBusy(false)
    }
  }

  async function unpair(): Promise<void> {
    const ok = await window.fleet.confirm(
      'Unpair every phone?',
      'A new pairing code is made. Every phone has to scan the new QR before it can reach Kamino again.'
    )
    if (ok) setSt(await window.fleet.remoteRotate())
  }

  const lamp = !on
    ? 'OFF'
    : !st?.listening
      ? 'NOT LISTENING'
      : connected
        ? `${st.clients} PHONE${st.clients === 1 ? '' : 'S'} LIVE`
        : 'WAITING FOR A PHONE'
  const local = st?.urls.find((u) => u.label === 'This PC')

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal hyperdrive remote-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs">
          <span className="modal-tab active">PHONE LINK</span>
          <span className={`hd-lamp${on && st?.listening ? ' on' : ''}`}>{lamp}</span>
          <button className="modal-close" onClick={props.onClose}>
            ✕ esc
          </button>
        </div>

        <div className="modal-body">
          <div className="hd-intro">
            Your board on your phone: see every clone, answer the ones awaiting orders, type into
            their terminals and commission new ones. Kamino has to stay running on this PC, and the
            PC has to stay awake.
          </div>

          <label className={`hd-switch${on ? ' on' : ''}`} style={{ marginBottom: 16 }}>
            <span className="hd-switch-head">
              <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void set({ enabled: e.target.checked })} />
              <span className="hd-switch-title">Phone link {on ? 'on' : 'off'}</span>
            </span>
            <span className="hd-switch-body">
              Anyone holding the pairing code can drive your clones, so it only ever appears in the
              QR below. Clones started outside Kamino show on the phone but can&apos;t be typed into.
            </span>
          </label>

          {on && st && s && (
            <>
              <div className="airspace-section">HOW WILL YOUR PHONE CONNECT?</div>
              <div className="rg-methods">
                {METHODS.map((m) => (
                  <label key={m.id} className={`hd-switch rg-method${s.method === m.id ? ' on' : ''}`}>
                    <span className="hd-switch-head">
                      <input
                        type="radio"
                        name="remote-method"
                        checked={s.method === m.id}
                        disabled={busy}
                        onChange={() => void set({ method: m.id })}
                      />
                      <span className="hd-switch-title">{m.title}</span>
                    </span>
                    <span className="rg-tag">{m.tag}</span>
                    <span className="hd-switch-body">{m.body}</span>
                  </label>
                ))}
              </div>

              {st.error && <div className="remote-callout bad">{st.error}</div>}

              <div className="airspace-section">
                STEPS
                <span className="airspace-section-note">follow them in order; ticks appear as Kamino sees each one done</span>
              </div>
              {s.method === 'tunnel' && <TunnelSteps st={st} set={set} busy={busy} connected={connected} />}
              {s.method === 'wifi' && <WifiSteps st={st} connected={connected} />}
              {s.method === 'tailscale' && <TailscaleSteps st={st} connected={connected} />}

              <div className="airspace-scoreboard">
                <span className="airspace-stat">
                  <b>{st.clients}</b> phone{st.clients === 1 ? '' : 's'} connected
                </span>
                <span className="airspace-stat soft">
                  last seen <b>{st.lastSeenAt ? `${agoShort(st.lastSeenAt, props.now)} ago` : 'never'}</b>
                </span>
              </div>
            </>
          )}
        </div>

        <div className="modal-body modal-actions">
          <span className="airspace-hint">
            {on && local && st ? (
              <>
                Want a look first?{' '}
                <a
                  href="#"
                  className="rg-link"
                  onClick={(e) => {
                    e.preventDefault()
                    void window.fleet.openExternal(`${local.url}/#k=${st.token}`)
                  }}
                >
                  Open the phone view on this PC
                </a>{' '}
                and narrow the window.
              </>
            ) : (
              'Switch the phone link on to see the ways to connect.'
            )}
          </span>
          {on && (
            <button className="btn danger" onClick={() => void unpair()}>
              Unpair all phones
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── the guides ─────────────────────────────────────────────────────────────

function Step(props: { n: number; done?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <li className={`rg-step${props.done ? ' done' : ''}`}>
      <span className="rg-num">{props.done ? '✓' : props.n}</span>
      <div className="rg-body">{props.children}</div>
    </li>
  )
}

function HomeScreenStep({ n, connected }: { n: number; connected: boolean }): React.JSX.Element {
  return (
    <Step n={n} done={connected}>
      <b>Make it an app.</b> iPhone: Share → <b>Add to Home Screen</b>. Android: ⋮ →{' '}
      <b>Add to Home screen</b>. From then on it opens straight to your board.
      {connected && <div className="rg-ok">A phone is connected. You&apos;re done.</div>}
    </Step>
  )
}

function TunnelSteps(props: {
  st: RemoteStatus
  set: (next: Partial<RemoteSettings>) => Promise<RemoteStatus | null>
  busy: boolean
  connected: boolean
}): React.JSX.Element {
  const { st } = props
  const saved = st.settings.tunnelUrl
  const [draft, setDraft] = useState(saved ?? '')
  const [err, setErr] = useState('')
  useEffect(() => setDraft(saved ?? ''), [saved])
  const url = st.urls.find((u) => u.label === 'VS Code tunnel')

  async function save(): Promise<void> {
    setErr('')
    const res = await props.set({ tunnelUrl: draft })
    if (draft.trim() && !res?.settings.tunnelUrl) {
      setErr('That isn\'t the https:// address from the Ports view. Copy the "Forwarded Address" column.')
    }
  }

  return (
    <ol className="rg-steps">
      <Step n={1} done={!!saved}>
        <b>Open VS Code</b>, any window. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>, type{' '}
        <code>Ports: Focus on Ports View</code> and press Enter.
      </Step>
      <Step n={2} done={!!saved}>
        Click <b>Forward a Port</b>, type <code>{st.settings.port}</code> and press Enter. Sign in with
        GitHub if it asks. Leave visibility on <b>Private</b>, so only your GitHub account can open it.
      </Step>
      <Step n={3} done={!!saved}>
        Copy the <b>Forwarded Address</b> (it looks like{' '}
        <code>https://abc123-{st.settings.port}.aue.devtunnels.ms</code>) and paste it here:
        <div className="rg-input">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            placeholder={`https://…-${st.settings.port}.….devtunnels.ms`}
            spellCheck={false}
          />
          <button className="btn primary" disabled={props.busy || draft.trim() === (saved ?? '')} onClick={() => void save()}>
            Save
          </button>
        </div>
        {err && <div className="remote-warn">{err}</div>}
      </Step>
      <Step n={4} done={props.connected}>
        <b>Scan this with your phone camera</b> and open the link. Sign in with the <b>same GitHub
        account</b>, then tap <b>Continue</b> on the &ldquo;developer tunnel&rdquo; notice.
        {url ? <PairQr url={url} token={st.token} /> : <div className="rg-wait">The code appears once step 3 is saved.</div>}
      </Step>
      <HomeScreenStep n={5} connected={props.connected} />
      <li className="rg-note">
        The tunnel runs while VS Code is open. If you remove the forwarded port and add it again, VS
        Code gives it a new address, so paste the new one in step 3. In this mode nothing on your
        network can reach Kamino at all: only the tunnel can, and only after you sign in.
      </li>
    </ol>
  )
}

function WifiSteps({ st, connected }: { st: RemoteStatus; connected: boolean }): React.JSX.Element {
  const urls = st.urls.filter((u) => u.label === 'Wi-Fi' || u.label === 'Tailscale')
  const [idx, setIdx] = useState(0)
  const url = urls[Math.min(idx, Math.max(0, urls.length - 1))]
  return (
    <ol className="rg-steps">
      <li className="remote-callout">
        <b>Home network only.</b> Traffic is plain HTTP, so anyone on the same Wi-Fi could read it.
        Never use this on office, café or hotel Wi-Fi.
      </li>
      <Step n={1} done={st.lanAddresses.length > 0}>
        <b>Put your phone on the same Wi-Fi as this PC</b> (turn off mobile data if it won&apos;t connect).
        {st.lanAddresses.length === 0 && <div className="remote-warn">This PC isn&apos;t on a network right now.</div>}
      </Step>
      <Step n={2} done={connected}>
        <b>Scan this with your phone camera</b> and open the link.
        {urls.length > 1 && (
          <div className="remote-url-pick">
            {urls.map((u, i) => (
              <button key={u.url} className={`view-btn${i === idx ? ' active' : ''}`} onClick={() => setIdx(i)}>
                {u.url.replace(/^http:\/\//, '')}
              </button>
            ))}
          </div>
        )}
        {url ? <PairQr url={url} token={st.token} /> : null}
      </Step>
      <Step n={3} done={connected}>
        <b>Page won&apos;t load?</b> Windows is blocking it. When Windows asks whether Kamino may use the
        network, tick <b>Private networks</b> and Allow. If you missed that prompt: Windows Security →
        Firewall &amp; network protection → Allow an app through firewall → Kamino.
      </Step>
      <HomeScreenStep n={4} connected={connected} />
    </ol>
  )
}

function TailscaleSteps({ st, connected }: { st: RemoteStatus; connected: boolean }): React.JSX.Element {
  const url = st.urls.find((u) => u.label === 'Tailscale')
  const [copied, setCopied] = useState(false)
  return (
    <ol className="rg-steps">
      <Step n={1} done={!st.tailscaleMissing}>
        <b>Install Tailscale on this PC</b>:{' '}
        <a href="#" className="rg-link" onClick={(e) => { e.preventDefault(); void window.fleet.openExternal('https://tailscale.com/download') }}>
          tailscale.com/download
        </a>
        . On a work laptop you&apos;ll need IT to approve it.
        <div className="rg-row">
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(IT_REQUEST)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? 'Copied' : 'Copy a request for IT'}
          </button>
        </div>
      </Step>
      <Step n={2} done={!st.tailscaleMissing}>
        <b>Install Tailscale on your phone</b> and sign in with the <b>same account</b>.
      </Step>
      <Step n={3} done={!st.tailscaleMissing}>
        {st.tailscaleMissing ? (
          <>Kamino is watching for this PC&apos;s Tailscale address. It shows up here within about 20 seconds.</>
        ) : (
          <>Kamino found this PC on Tailscale: <code>{url?.url.replace(/^http:\/\//, '')}</code></>
        )}
      </Step>
      <Step n={4} done={connected}>
        <b>Scan this with your phone camera</b> and open the link.
        {url ? <PairQr url={url} token={st.token} /> : <div className="rg-wait">The code appears once step 3 is done.</div>}
      </Step>
      <HomeScreenStep n={5} connected={connected} />
    </ol>
  )
}

function PairQr({ url, token }: { url: RemoteUrl; token: string }): React.JSX.Element {
  const pairUrl = `${url.url}/#k=${token}`
  const [qr, setQr] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    QRCode.toDataURL(pairUrl, { margin: 1, width: 232, errorCorrectionLevel: 'M' }).then(setQr, () => setQr(''))
  }, [pairUrl])
  return (
    <div className="remote-pair">
      <div className="remote-qr">{qr ? <img src={qr} alt="Pairing QR code" /> : null}</div>
      <div className="remote-pair-side">
        <div className="remote-url">
          <code>{url.url}</code>
        </div>
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard.writeText(pairUrl)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? 'Copied' : 'Copy pairing link'}
        </button>
        <span className="rg-small">
          Can&apos;t scan? Send yourself the pairing link and open it on the phone. It contains the
          pairing code, so only send it to yourself.
        </span>
      </div>
    </div>
  )
}
