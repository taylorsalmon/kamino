/** Headless smoke test: run the status engine for 6s and print what it sees. */
import { InstanceStore } from '../src/main/instance-store'

const store = new InstanceStore()
store.start()

setTimeout(() => {
  const snap = store.snapshot()
  for (const i of snap.instances) {
    console.log(
      `[${i.state.toUpperCase()}] ${i.name} (${i.kind}) pid=${i.pid}\n` +
        `  repo: ${i.repo} @ ${i.gitBranch || '?'}\n` +
        `  title: ${i.now.title || '—'}\n` +
        `  activity: ${i.now.activity}\n` +
        `  lastPrompt: ${(i.recent.lastPrompt || '—').slice(0, 90)}\n` +
        `  prs: ${i.recent.prs.map((p) => '#' + p.number).join(' ') || '—'}  turns: ${i.recent.turns}  queued: ${i.now.queued.length}\n` +
        `  away: ${(i.recent.awaySummary || '—').slice(0, 90)}\n`
    )
  }
  store.stop()
  process.exit(0)
}, 6000)
