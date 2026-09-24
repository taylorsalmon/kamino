import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RemoteAlert, RemoteInstance, RemotePty } from '../../shared/types'
import { forgetToken, setToken, useFleet, type Link } from './api'
import { Board } from './Board'
import { CloneView } from './CloneView'
import { Commission } from './Commission'

/**
 * The phone board. Three screens — board, one clone, commission — driven by
 * history state so the phone's own back gesture works like it should.
 */

type Screen = { kind: 'board' } | { kind: 'clone'; key: string } | { kind: 'commission' }

export function PhoneApp(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>({ kind: 'board' })
  const [banner, setBanner] = useState<RemoteAlert | null>(null)
  const [now, setNow] = useState(Date.now())
  const bannerTimer = useRef<number | undefined>(undefined)

  const onAlert = useCallback((a: RemoteAlert) => {
    setBanner(a)
    if (a.kind === 'ask') navigator.vibrate?.([80, 60, 80])
    window.clearTimeout(bannerTimer.current)
    bannerTimer.current = window.setTimeout(() => setBanner(null), a.kind === 'ask' ? 12_000 : 6_000)
  }, [])

  const { state, link, reconnect } = useFleet(onAlert)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // back gesture / button pops a screen instead of leaving the app
  useEffect(() => {
    history.replaceState({ kind: 'board' }, '')
    const onPop = (e: PopStateEvent): void => setScreen((e.state as Screen) ?? { kind: 'board' })
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const go = useCallback((s: Screen) => {
    history.pushState(s, '')
    setScreen(s)
  }, [])
  const back = useCallback(() => {
    if (history.state && (history.state as Screen).kind !== 'board') history.back()
    else setScreen({ kind: 'board' })
  }, [])

  const waiting = state?.instances.filter((i) => i.state === 'needs-you').length ?? 0
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Kamino` : 'Kamino'
  }, [waiting])

  // a clone opened by ptyId while it was still growing follows its session
  // once it binds, so the screen doesn't vanish mid-look
  const current = useMemo(() => {
    if (screen.kind !== 'clone' || !state) return null
    const inst =
      state.instances.find((i) => i.sessionId === screen.key) ??
      state.instances.find((i) => i.ptyId === screen.key && i.state !== 'dead')
    const pty = state.ptys.find((p) => p.ptyId === (inst?.ptyId ?? screen.key))
    return inst || pty ? { inst, pty } : null
  }, [screen, state])

  if (link === 'unpaired') return <Unpaired />

  return (
    <div className="app">
      {banner && (
        <button
          className={`banner ${banner.kind}`}
          onClick={() => {
            setBanner(null)
            go({ kind: 'clone', key: banner.sessionId })
          }}
        >
          <span className="banner-title">{banner.title}</span>
          <span className="banner-body">{banner.body}</span>
        </button>
      )}

      {screen.kind === 'board' && (
        <Board
          state={state}
          link={link}
          now={now}
          onOpen={(key) => go({ kind: 'clone', key })}
          onCommission={() => go({ kind: 'commission' })}
          onReconnect={reconnect}
        />
      )}

      {screen.kind === 'clone' &&
        (current ? (
          <CloneView
            key={current.inst?.sessionId ?? current.pty?.ptyId}
            inst={current.inst as RemoteInstance | undefined}
            pty={current.pty as RemotePty | undefined}
            pr={state?.pr ?? {}}
            termTheme={state?.termTheme ?? 'dark'}
            now={now}
            link={link}
            onBack={back}
          />
        ) : (
          <Gone onBack={back} loading={!state} />
        ))}

      {screen.kind === 'commission' && (
        <Commission
          onClose={back}
          onLaunched={(ptyId) => {
            // replace the sheet with the new clone, so back returns to the board
            history.replaceState({ kind: 'clone', key: ptyId }, '')
            setScreen({ kind: 'clone', key: ptyId })
          }}
        />
      )}
    </div>
  )
}

export function LinkLamp({ link }: { link: Link }): React.JSX.Element {
  const word = link === 'live' ? 'LIVE' : link === 'connecting' ? 'LINKING' : 'OFFLINE'
  return (
    <span className="link-lamp" data-link={link}>
      <i />
      {word}
    </span>
  )
}

function Gone({ onBack, loading }: { onBack: () => void; loading: boolean }): React.JSX.Element {
  return (
    <div className="screen">
      <header className="bar">
        <button className="icon-btn" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <span className="bar-title">{loading ? 'Linking…' : 'Clone gone'}</span>
      </header>
      <div className="empty">{loading ? 'Reaching Kamino…' : 'That clone has left the board.'}</div>
    </div>
  )
}

/** No pairing, or the desktop unpaired every phone. */
function Unpaired(): React.JSX.Element {
  const [code, setCode] = useState('')
  return (
    <div className="unpaired">
      <img src="./remote/icon-180.png" alt="" className="unpaired-mark" />
      <h1>Pair with Kamino</h1>
      <ol>
        <li>
          On your PC, open Kamino → <b>⋯</b> → <b>Phone link</b> and switch it on.
        </li>
        <li>Scan the QR code with this phone&apos;s camera.</li>
        <li>
          Then Share → <b>Add to Home Screen</b>.
        </li>
      </ol>
      <details>
        <summary>Paste a link instead</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const m = /k=([^&\s]+)/.exec(code)
            const t = m ? decodeURIComponent(m[1]) : code.trim()
            if (!t) return
            setToken(t)
            location.reload()
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="http://…/#k=…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button className="btn primary" type="submit">
            Pair
          </button>
        </form>
      </details>
      <button
        className="btn ghost"
        onClick={() => {
          forgetToken()
          history.replaceState(null, '', location.pathname)
          location.reload()
        }}
      >
        Forget old pairing
      </button>
    </div>
  )
}
