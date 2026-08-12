/**
 * pr-create — raise a PR for the branch a clone is working on, behind the
 * always-there PR button. Idempotent by design: if the branch already has an
 * open PR we return that one instead of creating a duplicate, so clicking the
 * button always lands on "the PR for this work" no matter how many times it's
 * pressed or from which surface.
 *
 * Goes through the gh CLI (same auth story as pr-status — we never touch
 * tokens): push the branch if the remote doesn't have it yet, then
 * `gh pr create --fill` so title and body come from the commits. Never invents
 * work: a branch with nothing on it is an error, not an empty PR.
 */
import { execFile } from 'node:child_process'
import type { PrCreateResult } from '../shared/types'

const GIT_TIMEOUT_MS = 30_000
const GH_TIMEOUT_MS = 30_000

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: stdout.trim(), err: (stderr || error?.message || '').trim() })
    })
  })
}

/** git/gh stderr leads with the useful line and trails into usage noise. */
function firstLine(msg: string): string {
  const line = msg.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('Command failed'))
  return (line ?? '').trim().slice(0, 160)
}

function fail(error: string): PrCreateResult {
  return { ok: false, error }
}

async function doRaise(cwd: string): Promise<PrCreateResult> {
  const branch = await run('git', ['branch', '--show-current'], cwd, GIT_TIMEOUT_MS)
  if (!branch.ok) return fail(firstLine(branch.err) || 'not a git repo')
  const head = branch.out
  if (!head) return fail('detached HEAD — check out a branch first')
  if (head === 'main' || head === 'master') {
    return fail(`on ${head} — a PR needs its own branch`)
  }

  // an open PR for this branch already? then the answer is that PR
  const existing = await run(
    'gh',
    ['pr', 'list', '--head', head, '--state', 'open', '--json', 'number,url', '--limit', '1'],
    cwd,
    GH_TIMEOUT_MS
  )
  // gh missing or unauthenticated — creating would fail the same way, so stop here
  if (!existing.ok) return fail(firstLine(existing.err) || 'gh unavailable')
  try {
    const arr = JSON.parse(existing.out)
    if (Array.isArray(arr) && arr[0]?.url) {
      return { ok: true, url: arr[0].url, number: arr[0].number, existed: true }
    }
  } catch {
    /* unreadable list output — fall through; worst case gh refuses the duplicate */
  }

  // the remote must have what we're PRing — first push sets the upstream,
  // after that a push of an up-to-date branch is a no-op
  const upstream = await run('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], cwd, GIT_TIMEOUT_MS)
  const push = upstream.ok
    ? await run('git', ['push'], cwd, GIT_TIMEOUT_MS)
    : await run('git', ['push', '-u', 'origin', head], cwd, GIT_TIMEOUT_MS)
  if (!push.ok) return fail(firstLine(push.err) || 'git push failed')

  const created = await run('gh', ['pr', 'create', '--fill', '--head', head], cwd, GH_TIMEOUT_MS)
  if (!created.ok) return fail(firstLine(created.err) || 'gh pr create failed')
  const url = `${created.out}\n${created.err}`.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0]
  if (!url) return fail('PR created but gh printed no URL — check GitHub')
  return { ok: true, url, number: Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0), existed: false }
}

/** One raise per folder at a time — the button lives on several surfaces and a
 *  double-click must not race two pushes. Callers share the in-flight result. */
const inflight = new Map<string, Promise<PrCreateResult>>()

export function raisePr(cwd: string): Promise<PrCreateResult> {
  const running = inflight.get(cwd)
  if (running) return running
  const p = doRaise(cwd).finally(() => inflight.delete(cwd))
  inflight.set(cwd, p)
  return p
}
