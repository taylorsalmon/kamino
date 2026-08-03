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

- PR CI/review status overlay (`gh pr view`) on cards
- Turn token/cost per instance from transcript `usage` records
- App icon (packaged exe uses the stock Electron icon — `signAndEditExecutable: false` skips rcedit because winCodeSign may be blocked on the corporate network)
