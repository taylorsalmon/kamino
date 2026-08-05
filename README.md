<div align="center">

# KAMINO

**Grow the clones. Command the fleet.**

*Agent orchestration for Claude Code — one window, every instance on the machine, live.*

</div>

---

In Star Wars, Kamino is the storm-wracked ocean world where the clone army is grown, trained, and commanded from a single facility. This Kamino grows Claude Code agents instead — and since every instance is literally a clone of the same model, the name fit too well to pass up.

When you run multiple coding agents at once, the hard part isn't starting them — it's remembering what each one is doing. Which one is mid-task? Which one asked you a question twenty minutes ago and has been sitting blocked ever since? What did the one in that other terminal actually ship? Past two or three instances, that state stops fitting in your head.

Kamino is the answer: one window that discovers **every** Claude Code instance on the machine (its own embedded terminals, other terminal windows, headless background sessions), and for each one shows live what it's working on — current activity line, evolving task title, repo + branch, PRs opened, queued prompts — and flags the moment one needs your input (Windows toast included). It's mission control for an agent workforce, so your working memory doesn't have to be.

| You say | Kamino says |
|---|---|
| launch an instance | **commission** a clone |
| embedded in the app | **in bay** |
| running in another terminal | **field-deployed** |
| headless / background | **covert ops** |
| kill an instance | **decommission** |
| kill every clone on the board | **Order 66** |

## Run it

Installed app (the normal way — survives terminal closes, auto-starts at login):

```
npm install
npm run package        # → release/Claude Fleet Setup <version>.exe
```

Run the setup exe (per-user, no admin). It installs to `%LOCALAPPDATA%\Programs\kamino`, registers auto-start at login (`HKCU\...\Run\au.com.lkg.kamino`), and enforces a single instance (port 47831 owner). To update: bump `version` in package.json, re-run `npm run package`, run the new setup exe over the top.

Dev mode (only while hacking on Fleet itself — dies with its terminal):

```
npm run dev
```

If Electron's binary fails to download during install (corporate network), run `node node_modules/electron/install.js`, and if the zip extraction is blocked, extract `%LOCALAPPDATA%\electron\Cache\<hash>\electron-*.zip` into `node_modules/electron/dist` and write `electron.exe` into `node_modules/electron/path.txt`.

## The board

- **Roster cards** — every live Claude Code instance on the machine (in bay, field-deployed, covert ops), sorted needs-you-first. Each card: pulsing state rail, evolving task title, live activity line (`▸ Running: npm test`), repo/branch, PRs opened, queued prompts.
- **The wall** — embedded terminals live side by side in a resizable grid. Drag the `⠿` grip to swap two panes, drag pane edges to resize, cycle density (Roomy → Fit → Max), or flip to Focus mode for one big terminal. Drop a file anywhere on a terminal and its quoted path is pasted at the cursor.
- **Commissioning** — `+ New instance` launches Claude Code inside the app: folder picker from your recent projects, optional first prompt, permission mode (including `auto` / bypassPermissions for hands-off runs). **Resume session** relaunches any recent session (`claude --resume`) — also the migration path for instances currently running in Windows Terminal tabs.
- **Needs-you detection** — global Claude Code hooks (Notification/Stop/UserPromptSubmit) POST to a localhost receiver (port 47831). When a clone blocks on a permission or question you get a Windows toast; clicking it focuses that instance.
- **One-click answers** — a blocked pane shows the actual question in an overlay banner with buttons: numbered options for multiple-choice, **yes** for permission/plan prompts, **proceed** ("Proceed with your best judgment.") for open questions. Keystrokes go straight into the PTY — no focusing, no typing.
- **Catch me up** — per-instance button that distills the transcript tail and asks Haiku (via your own `claude -p` auth) for a NOW / DONE / NEEDS brief. Cached until the session changes.
- **Quick actions** — open PRs, open folder / VS Code, copy branch or resume command, decommission a wedged clone.

## Fleet commands

Shortcuts work everywhere — even while a terminal owns the keyboard. <kbd>F1</kbd> shows this in-app.

| Keys | What |
|---|---|
| <kbd>Ctrl</kbd> + <kbd>`</kbd> | Jump to the next clone awaiting orders — answer, press again |
| <kbd>Ctrl</kbd> + <kbd>1…9</kbd> | Jump straight to that pane on the wall |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>G</kbd> | Flip Grid ⇄ Focus |
| <kbd>F2</kbd> | Flip Terminal ⇄ Intel for the selected clone |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd> | Commission a new clone |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd> | Cycle wall density — Roomy → Fit → Max |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd> | End-of-shift sweep |
| <kbd>F1</kbd> | Cheat sheet |

## Keeping clones from killing each other

- **Own worktree** — a launch-dialog checkbox that gives the clone its own git worktree (`claude --worktree`, tree at `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`). This is the real answer to running several clones on one repo: a folder has a single checked-out branch, so clones sharing one commit to the same branch and land in one PR however carefully they work. Separate trees mean separate branches, separate PRs, and no possibility of collision. Cards keep showing the parent repo's name (not the worktree directory's) with a green `⑄ name` chip, so three clones on one project stay legible. Kamino also adds `.claude/worktrees/` to the repo's `.git/info/exclude` first — git does not ignore a nested worktree, and otherwise a clone with standing orders would `git add -A` an entire second checkout into its commit.
- **Contested files** (in the Airspace panel) — which files more than one clone has edited in the last hour, worst first, with per-clone edit counts. Nothing is blocked over it; the CLI's own staleness check handles the mechanical case. This answers the question you can't otherwise answer: *are* my five clones in one folder actually treading on each other, and where? Three clones deep in one file is a planning problem, not a race — that's the signal to hand out narrower lanes ("you own `src/api/**`") or split one off into its own worktree. Tracked in every mode, since watching costs nothing, and it covers field-deployed and covert-ops clones too, not just in-bay ones.
- **Airspace control** (⋯ menu) — the fleet's traffic controller. When two clones share a folder, one running `git add -A` commits the other's half-finished work into its own branch, and `git checkout` / `reset --hard` / `stash` simply destroy it. A clone can't defend itself here: it has no way to tell a sibling's edits from your own stray changes, and the damage is irreversible. Kamino answers Claude Code's `PreToolUse` hook — it knows which live clone is mid-edit in which folder — and hands the offender a reason it can act on ("stage only the files you changed yourself"). Deliberately guards git only: the CLI's `Edit` tool already refuses a change whose file moved underneath it, so file locking would just buy false positives. Three modes, defaulting to **warn-only** (logs what it would have stopped, denies nothing) so you can see whether it happens in your fleet before enforcing.

## Clone lifecycle

- **Standing orders** — a checkbox on the launch dialog (on by default, remembered) that makes shipping part of finishing: the clone commits, pushes and opens/updates a PR when it completes work, without being asked, logging anything unfinished as follow-ups. It rides in via `--append-system-prompt`, not a first prompt, so it can't rot out of the context window as the session grows and it costs no turn. Skipped on main/master and in repos with no remote. Note that in `default` permission mode the clone will still ask once for approval of the git commands — launch with `acceptEdits` or `auto` for a hands-off run.
- **Clawd vitals** — every card and pane carries Clawd, a tiny pixel crab whose health *is* the context-rot meter. His pixels dim as the window fills past 50%, he pulses red past 85% (auto-compact — the forced summary that loses detail — is imminent), and a skull scar marks a session that has already compacted. Hover for the raw numbers. Window sizes aren't recorded anywhere by the CLI, so Kamino proves them from evidence: a startup scan of recent transcript tails (compact `preTokens` + per-model token high-water marks) seeds a per-model map in `model-windows.json` (userData), and live ratchets/compactions keep teaching it. Models with no long-session history default to 200k until proven.
- **Reincarnation** — click Clawd and pick how to deal with a filling context window. **Transfer knowledge** runs the whole handoff itself: the clone writes a brief for its successor (goal / done / in flight / next / decisions / gotchas / files), Kamino commissions a fresh clone in the same folder and pastes the brief in as its first orders, optionally decommissioning the old one. **Compact now** just sends `/compact` for the in-place, lossy alternative. Both explain what they'll do before you commit. Why transfer beats waiting for auto-compact: the brief is written while there's still headroom, you get to read it, and the successor starts on a clean window with a fresh system prompt — so it re-grounds in the repo instead of trusting a summary.
- **End-of-shift sweep** (<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd>) — before you walk away, sweep every repo the fleet touched for uncommitted work and unpushed branches. Anything red gets a one-click dispatch: the responsible clone is handed a wrap-up order (commit with clear messages, push, open/update the PR, log follow-ups). Sweep again to watch the list go green.

## How it works

Claude Code already writes everything needed under `~/.claude/`:

| Source | Used for |
|---|---|
| `sessions/<pid>.json` | live instance registry + idle/busy status |
| `projects/<slug>/<sessionId>.jsonl` | transcript tail → activity, titles, PRs, prompts, away-summaries |
| `daemon/roster.json` | background sessions |
| `history.jsonl` | recent projects for the launch picker |

All parsing of these (undocumented, version-dependent) files lives in `src/main/claude-data.ts` — if a CLI update changes a shape, fix it there. Verified against CLI 2.1.220.

Embedded instances are spawned directly (no shell wrapper) via `@lydell/node-pty`, so the PTY child pid equals the registry pid — that's the terminal↔card binding.

Airspace control puts Kamino in front of every shell command on the machine, so two rules are absolute: the decision path never touches disk or spawns a process (it answers from an in-memory ledger fed by the transcript stream), and anything unexpected — no decider, unparseable payload, Kamino closed — allows the call. The installed hook carries an explicit 3s timeout because the documented default is 600s, and without it a wedged Kamino could stall Bash calls in every Claude session on the machine. `npm test` covers the git classifier and the decision logic.

## Architecture

```
src/main/
  claude-data.ts       the only module that knows ~/.claude file shapes
  transcript-tailer.ts byte-offset incremental .jsonl tailing
  instance-store.ts    merges registry + transcripts + hooks → Instance model
  pty-manager.ts       embedded claude.exe PTYs (ConPTY)
  hook-server.ts       localhost:47831 receiver for Claude Code hooks, and the
                       PreToolUse decision endpoint (fails open, always)
  hook-installer.ts    idempotent ~/.claude/settings.json hook patch
  deconflict.ts        airspace control: who is mid-edit where, git classifier
  worktree.ts          keeps a repo from staging its own nested worktrees
  recap.ts             "catch me up" via claude -p (haiku)
  handoff.ts           reincarnation: brief → successor → seed, and /compact
src/renderer/          React UI (the wall, roster cards, dialogs)
```

## Backlog

- Turn cost (dollars) per instance — `output_tokens` is already parsed in `claude-data.ts`, so this needs a per-model rate table and a running sum in the store
- Tray icon with a needs-you badge + a global hotkey that summons the window focused on the neediest clone
- Fleet-wide PR board — `PrStatusMap` already holds checks/review state for every PR, but it's only shown per card
- Quick-switcher (fuzzy match on name/repo/branch/title) — with more than nine clones, panes past Ctrl+9 have no keyboard path
- Security follow-ups from the audit: `open:vscode` builds a `cmd.exe /c` line from a renderer string, `hook-installer.ts` writes `~/.claude/settings.json` non-atomically, and the hook receiver on 47831 is unauthenticated
