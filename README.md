# Kamino

In Star Wars, Kamino is the storm-wracked ocean world where the clone army is grown, trained, and commanded from a single facility. This Kamino grows Claude Code agents instead — and since every instance is literally a clone of the same model, the name fit too well to pass up.

**What it actually is: agent orchestration for Claude Code.** When you run multiple coding agents at once, the hard part isn't starting them — it's remembering what each one is doing. Which one is mid-task? Which one asked you a question twenty minutes ago and has been sitting blocked ever since? What did the one in that other terminal actually ship? Past two or three instances, that state stops fitting in your head.

Kamino is the answer: one window that discovers **every** Claude Code instance on the machine (its own embedded terminals, other terminal windows, headless background sessions), and for each one shows live what it's working on — current activity line, evolving task title, repo + branch, PRs opened, queued prompts — and flags the moment one needs your input (Windows toast included). Been away? One click asks Haiku for a NOW / DONE / NEEDS brief of any instance. It's mission control for an agent workforce, so your working memory doesn't have to be.

(Why "Kamino"? Your instances are literally clones of the same model, so the Star Wars clone-facility metaphor stuck. Vocabulary: commission = launch, in bay = embedded, field-deployed = outside terminal, covert ops = background, decommission = kill, **Order 66** = kill every clone on the board.)

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

## What it does

- **Roster cards** — every live Claude Code instance on the machine (embedded, external terminals, background/daemon), sorted needs-you-first. Each card: pulsing state rail, evolving task title, live activity line (`▸ Running: npm test`), repo/branch, PRs opened, queued prompts.
- **Embedded terminals** — `+ New instance` launches Claude Code inside the app (folder picker from your recent projects, optional first prompt, permission mode). Scrollback survives switching cards. **Resume session** relaunches any recent session (`claude --resume`) — also the migration path for instances currently running in Windows Terminal tabs.
- **Needs-you detection + toasts** — global Claude Code hooks (Notification/Stop/UserPromptSubmit) POST to a localhost receiver (port 47831). When an instance blocks on a permission or question you get a Windows toast; clicking it focuses that instance.
- **Catch me up** — per-instance button that distills the transcript tail and asks Haiku (via your own `claude -p` auth) for a NOW / DONE / NEEDS brief. Cached until the session changes.
- **Quick actions** — open PRs, open folder / VS Code, copy branch or resume command, kill a wedged instance.
- **Standing orders** — a checkbox on the launch dialog (on by default, remembered) that makes shipping part of finishing: the clone commits, pushes and opens/updates a PR when it completes work, without being asked, logging anything unfinished as follow-ups. It rides in via `--append-system-prompt`, not a first prompt, so it can't rot out of the context window as the session grows and it costs no turn. Skipped on main/master and in repos with no remote. Note that in `default` permission mode the clone will still ask once for approval of the git commands — launch with `acceptEdits` or `auto` for a hands-off run.
- **Reincarnation** — click Clawd on any card and pick how to deal with a filling context window. **Transfer knowledge** runs the whole handoff itself: the clone writes a brief for its successor (goal / done / in flight / next / decisions / gotchas / files), Kamino commissions a fresh clone in the same folder and pastes the brief in as its first orders, optionally decommissioning the old one. **Compact now** just sends `/compact` for the in-place, lossy alternative. Both explain what they'll do before you commit. Why transfer beats waiting for auto-compact: the brief is written while there's still headroom, you get to read it, and the successor starts on a clean window with a fresh system prompt — so it re-grounds in the repo instead of trusting a summary.
- **Context rot bar** — every card/pane shows how full the clone's context window is, as an animated decay meter: green sliver while fresh, amber creep past 60% (`ROT 71%`), pulsing red past 85% (auto-compact — the forced summary that loses detail — is imminent), skull scar once a session has compacted. Hover explains it with the raw numbers. Window sizes aren't recorded anywhere by the CLI, so Kamino proves them from evidence: a startup scan of recent transcript tails (compact `preTokens` + per-model token high-water marks) seeds a per-model map in `model-windows.json` (userData), and live ratchets/compactions keep teaching it. Models with no long-session history default to 200k until proven.

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

## Architecture

```
src/main/
  claude-data.ts       the only module that knows ~/.claude file shapes
  transcript-tailer.ts byte-offset incremental .jsonl tailing
  instance-store.ts    merges registry + transcripts + hooks → Instance model
  pty-manager.ts       embedded claude.exe PTYs (ConPTY)
  hook-server.ts       localhost:47831 receiver for Claude Code hooks
  hook-installer.ts    idempotent ~/.claude/settings.json hook patch
  recap.ts             "catch me up" via claude -p (haiku)
  handoff.ts           reincarnation: brief → successor → seed, and /compact
src/renderer/          React UI (roster cards, terminal workspace, dialogs)
```

## Backlog

- Turn cost (dollars) per instance — `output_tokens` is already parsed in `claude-data.ts`, so this needs a per-model rate table and a running sum in the store
- Tray icon with a needs-you badge + a global hotkey that summons the window focused on the neediest clone
- Fleet-wide PR board — `PrStatusMap` already holds checks/review state for every PR, but it's only shown per card
- Quick-switcher (fuzzy match on name/repo/branch/title) — with more than nine clones, panes past Ctrl+9 have no keyboard path
- Security follow-ups from the audit: `open:vscode` builds a `cmd.exe /c` line from a renderer string, `hook-installer.ts` writes `~/.claude/settings.json` non-atomically, and the hook receiver on 47831 is unauthenticated
