/**
 * wrap-up check — "can I close the lid?" Sweeps every folder the fleet is
 * working in and reports anything that would be stranded on this machine:
 * uncommitted changes, unpushed commits, and branches with no open PR.
 * Read-only: never stages, commits, or pushes anything itself.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { WrapupRepo } from '../shared/types'

const GIT_TIMEOUT_MS = 10_000
const GH_TIMEOUT_MS = 15_000

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

export async function checkRepo(cwd: string, clones: string[]): Promise<WrapupRepo> {
  const base: WrapupRepo = {
    cwd,
    repo: path.basename(cwd),
    clones,
    branch: '',
    dirty: 0,
    ahead: 0,
    noUpstream: false,
    defaultBranch: false,
    pr: null
  }

  const inRepo = await run('git', ['rev-parse', '--is-inside-work-tree'], cwd, GIT_TIMEOUT_MS)
  if (!inRepo.ok) return { ...base, error: 'not a git repo' }

  const [branch, status] = await Promise.all([
    run('git', ['branch', '--show-current'], cwd, GIT_TIMEOUT_MS),
    run('git', ['status', '--porcelain'], cwd, GIT_TIMEOUT_MS)
  ])
  if (!status.ok) return { ...base, error: status.err.slice(0, 120) || 'git status failed' }
  base.branch = branch.out || '(detached)'
  base.dirty = status.out ? status.out.split('\n').length : 0
  base.defaultBranch = ['main', 'master'].includes(base.branch)

  const ahead = await run('git', ['rev-list', '--count', '@{upstream}..HEAD'], cwd, GIT_TIMEOUT_MS)
  if (ahead.ok) base.ahead = Number(ahead.out) || 0
  else base.noUpstream = true // no upstream configured (or never pushed)

  // a work branch should have an open PR; main/master doesn't need one
  if (!base.defaultBranch && base.branch !== '(detached)') {
    const pr = await run(
      'gh',
      ['pr', 'list', '--head', base.branch, '--state', 'open', '--json', 'number,url,title', '--limit', '1'],
      cwd,
      GH_TIMEOUT_MS
    )
    if (pr.ok) {
      try {
        const arr = JSON.parse(pr.out)
        if (Array.isArray(arr) && arr[0]) {
          base.pr = { number: arr[0].number, url: arr[0].url, title: arr[0].title ?? '' }
        }
      } catch {
        base.prError = 'unreadable gh output'
      }
    } else {
      base.prError = pr.err.split(/\r?\n/)[0]?.slice(0, 120) || 'gh unavailable'
    }
  }
  return base
}
