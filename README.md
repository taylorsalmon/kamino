# Claude Fleet

Desktop manager for Claude Code instances. One window that hosts your Claude terminals **and** shows, at a glance, what every instance is actually doing right now — working, waiting on you, idle, or finished — plus what it produced (PRs, branches) and a one-click AI recap when you've been away.

## Run it

```
npm install
npm run dev
```

If Electron's binary fails to download during install (corporate network), run `node node_modules/electron/install.js`, and if the zip extraction is blocked, extract `%LOCALAPPDATA%\electron\Cache\<hash>\electron-*.zip` into `node_modules/electron/dist` and write `electron.exe` into `node_modules/electron/path.txt`.

## What it does

- **Roster cards** — every live Claude Code instance on the machine (embedded, external terminals, background/daemon), sorted needs-you-first. Each card: pulsing state rail, evolving task title, live activity line (`▸ Running: npm test`), repo/branch, PRs opened, queued prompts.
- **Embedded terminals** — `+ New instance` launches Claude Code inside the app (folder picker from your recent projects, optional first prompt, permission mode). Scrollback survives switching cards. **Resume session** relaunches any recent session (`claude --resume`) — also the migration path for instances currently running in Windows Terminal tabs.
- **Needs-you detection + toasts** — global Claude Code hooks (Notification/Stop/UserPromptSubmit) POST to a localhost receiver (port 47831). When an instance blocks on a permission or question you get a Windows toast; clicking it focuses that instance.
- **Catch me up** — per-instance button that distills the transcript tail and asks Haiku (via your own `claude -p` auth) for a NOW / DONE / NEEDS brief. Cached until the session changes.
- **Quick actions** — open PRs, open folder / VS Code, copy branch or resume command, kill a wedged instance.

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
src/renderer/          React UI (roster cards, terminal workspace, dialogs)
```

## Backlog

- Wall view: zoomed-out grid of all instances with live activity lines
- PR CI/review status overlay (`gh pr view`) on cards
- Package as installable app (electron-builder) + auto-start
- Turn token/cost per instance from transcript `usage` records
