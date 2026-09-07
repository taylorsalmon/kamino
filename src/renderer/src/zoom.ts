/**
 * Ctrl+wheel → zoom the whole board. xterm consumes wheel events over a pane
 * (scrollback), so this listens on the window at capture — ahead of every
 * pane — and swallows the ctrl-held ones before anything scrolls. A trackpad
 * pinch on Windows arrives as the same ctrl+wheel in many small deltas, so
 * deltas accumulate: one pinch is a few steps, not forty.
 *
 * The chords (Ctrl+= / - / 0) never reach the renderer at all — the main
 * process takes them on the way in (main/zoom.ts) so xterm can't eat them.
 */

/** deltaY per zoom step in pixel mode; a mouse notch is 100 */
const NOTCH = 50

export function wireZoomWheel(): void {
  let acc = 0
  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      // line/page deltaMode = discrete notches: one event, one step
      if (e.deltaMode !== 0) {
        acc = 0
        window.fleet.zoomStep(e.deltaY < 0 ? 'in' : 'out')
        return
      }
      if (Math.sign(acc) !== Math.sign(e.deltaY)) acc = 0
      acc += e.deltaY
      if (Math.abs(acc) < NOTCH) return
      window.fleet.zoomStep(acc < 0 ? 'in' : 'out')
      acc = 0
    },
    { capture: true, passive: false }
  )
}
