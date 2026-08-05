/**
 * Worktree housekeeping.
 *
 * `claude --worktree <name>` puts the new tree at <repo>/.claude/worktrees/<name>
 * — inside the repo. Git does not ignore a nested worktree, so the parent repo
 * starts reporting `.claude/` as untracked, and a clone working there with
 * standing orders will happily `git add -A` an entire second checkout into its
 * commit.
 *
 * The fix goes in .git/info/exclude rather than .gitignore: it is per-clone and
 * never committed, so Kamino can protect the repo without touching a tracked
 * file or showing up in anyone's diff.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const PATTERN = '.claude/worktrees/'
const HEADER = '# added by Kamino: never stage a nested worktree'

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim())
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
    if (current.split(/\r?\n/).some((l) => l.trim() === PATTERN)) return

    fs.mkdirSync(path.dirname(excludePath), { recursive: true })
    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
    fs.appendFileSync(excludePath, `${prefix}${HEADER}\n${PATTERN}\n`, 'utf-8')
  } catch {
    /* not a git repo, no git on PATH, read-only .git — all survivable */
  }
}
