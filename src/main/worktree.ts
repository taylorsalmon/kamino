/**
 * Worktree housekeeping.
 *
 * `claude --worktree <name>` puts the new tree at <repo>/.claude/worktrees/<name>
 * — inside the repo. Git does not ignore a nested worktree, so the parent repo
 * starts reporting `.claude/` as untracked, and a clone working there with
 * standing orders will happily `git add -A` an entire second checkout into its
 * commit.
 *
 * CLIs without a worktree flag of their own (Codex, custom) get the same deal
 * from Kamino: createWorktree makes <repo>/.kamino/worktrees/<name> on branch
 * worktree-<name>, mirroring Claude's layout so every card reads the same.
 *
 * The exclude goes in .git/info/exclude rather than .gitignore: it is per-clone
 * and never committed, so Kamino can protect the repo without touching a tracked
 * file or showing up in anyone's diff.
 */
import { execFile } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

const PATTERNS = ['.claude/worktrees/', '.kamino/worktrees/']
const HEADER = '# added by Kamino: never stage a nested worktree'

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout.trim())
    )
  })
}

/**
 * Make sure this repo will not stage its own worktrees. Idempotent, and silent
 * on failure — a missing exclude file is a housekeeping problem, never a reason
 * to refuse a launch.
 */
export async function ensureWorktreeIgnored(cwd: string): Promise<void> {
  try {
    // --git-common-dir resolves to the MAIN repo's .git even when cwd is
    // itself a linked worktree, which is where the shared exclude file lives
    const common = await git(cwd, ['rev-parse', '--git-common-dir'])
    if (!common) return
    const gitDir = path.isAbsolute(common) ? common : path.join(cwd, common)
    const excludePath = path.join(gitDir, 'info', 'exclude')

    let current = ''
    try {
      current = fs.readFileSync(excludePath, 'utf-8')
    } catch {
      /* no exclude file yet — we create it below */
    }
    const have = new Set(current.split(/\r?\n/).map((l) => l.trim()))
    const missing = PATTERNS.filter((p) => !have.has(p))
    if (missing.length === 0) return

    fs.mkdirSync(path.dirname(excludePath), { recursive: true })
    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
    const header = current.includes(HEADER) ? '' : `${HEADER}\n`
    fs.appendFileSync(excludePath, `${prefix}${header}${missing.join('\n')}\n`, 'utf-8')
  } catch {
    /* not a git repo, no git on PATH, read-only .git — all survivable */
  }
}

/** Something a human can read back off a branch list, unique enough per repo. */
function autoName(): string {
  return `clone-${crypto.randomBytes(2).toString('hex')}`
}

/**
 * Kamino's own worktree for a CLI that has none: <repo>/.kamino/worktrees/<name>
 * on branch worktree-<name>, branched from the current HEAD. Returns the new
 * working folder. Throws with git's own words when the folder is not a repo or
 * the branch already exists — a launch that would silently share a checkout is
 * worse than one that fails.
 */
export async function createWorktree(cwd: string, name?: string): Promise<string> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top) throw new Error('Not a git repository — a worktree needs one.')
  const clean = (name ?? '').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  const wt = clean || autoName()
  const dir = path.join(top, '.kamino', 'worktrees', wt)
  if (fs.existsSync(dir)) throw new Error(`Worktree "${wt}" already exists at ${dir}`)
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  await git(top, ['worktree', 'add', '-b', `worktree-${wt}`, dir])
  return dir
}
