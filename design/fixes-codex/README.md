# Tessel

_Formerly **Shell Panels**._

A Windows desktop app for running **multiple shells in one window**, split into
resizable panels, with optional **multi-write (broadcast)** so you can type once
and drive every pane at the same time.

Built with **Electron + Vue 3 + xterm.js + node-pty**.

## Features

- **Multiple real shells in one window** — PowerShell, PowerShell 7, Command
  Prompt, Git Bash and WSL are auto-detected (whichever are installed).
- **Split into panels** — split any pane Right (side-by-side) or Down (stacked),
  nested arbitrarily. Each pane is a full PTY-backed terminal.
- **Even grid presets** — the **Grid…** menu lays everything out as a clean,
  evenly-spaced grid (2×2, 3×2, 3×3, …) in one click.
- **Drag-to-resize** — drag the divider between any two panes; terminals reflow
  automatically (and on window resize).
- **Multi-write / broadcast** — toggle Broadcast and your keystrokes go to every
  pane whose "write" box is checked. Type a command once, run it everywhere.
- **Robust lifecycle** — close a pane (the surviving sibling expands), processes
  that exit show a notice, and closing the last pane spawns a fresh one. All
  PTYs are killed when the window closes.
- **Workspace persistence** — the split layout, divider sizes, the shell chosen
  for each pane, pane titles and broadcast flags are saved automatically and
  restored on the next launch. The _layout_ is restored (each pane reopens with
  a fresh shell of the same type) — a PTY is a live process and can't be frozen
  and thawed, the same constraint tmux-resurrect works under.
- **AI coding agents in panes** — the **Agent** menu launches a coding-agent CLI
  (Claude Code, Codex, Gemini) in a new pane. Installed agents are auto-detected
  on `PATH`; missing ones are listed but greyed out. An agent pane carries its
  own identity (accent colour, ◆ marker) and a live **Working / Idle** badge so a
  grid of agents tells you at a glance which are busy and which are waiting on
  you. Agent panes persist and re-launch with the workspace.
- **One "New" menu** — the toolbar's New button (or the **+** on any pane)
  opens a picker for every terminal and agent, with where to open it: to the
  right, below, or in a new workspace. It also sets the default shell.
- **Project folders** — give a workspace a folder and its new panes and agents
  start there.
- **"Needs you" alerts** — when an agent finishes a stretch of work while you
  are looking elsewhere, you get a notification and an amber marker on the
  pane and its workspace.
- **Find, zoom, restart, drag and drop** — `Ctrl+Shift+F` finds text, `Ctrl+=`
  and `Ctrl+-` zoom, exited panes offer Restart, and dropping files on a pane
  types their paths.
- **Settings** — the gear button (or `Ctrl+,`) sets the font, text size,
  cursor, scrollback, default shell, copy-on-select, agent alerts, whether to
  confirm before closing an agent, and whether to reopen workspaces at launch.
- **Drag panes to rearrange** — drag a pane by its header onto another pane:
  an edge places it on that side, the middle swaps the two, and a workspace in
  the sidebar moves it there. `Esc` cancels.
- **Tools** — the Tools button lists AI agents (Claude Code, Codex, Gemini,
  OpenCode, Qwen Code, GitHub Copilot CLI, Amp, Aider) and developer tools
  (Git, GitHub CLI, Node.js, Python, uv, ripgrep, PowerShell 7, VS Code,
  Docker, Bun, jq), shows what's installed, and installs the rest in a pane
  (npm or winget). You can also add any other agent command as your own.
- **MCP servers** — the MCP button shows every server for Claude Code and Codex,
  tests the real connection (and lists the server's tools), copies a server to
  the other agent, helps you sign in, and has a searchable catalog of popular
  servers (Playwright, Context7, GitHub, Sentry, Notion, Linear and more).
- **Agents working together** — open an agent as a _separate copy_ (its own git
  worktree and branch) so two agents can't overwrite each other, send selected
  text from one pane to another, or ask one agent to review another's changes
  (right-click a pane).
- **Workspaces** — a left sidebar holds any number of workspaces, each with its
  own split layout. Switching never stops or resizes a running shell or agent,
  a green dot marks workspaces where an agent is working, and all workspaces are
  restored on the next launch.
- **Agent Task Board** — a built-in **kanban** side panel for tracking what each
  agent is working on. Toggle it with **`Ctrl+Shift+K`**. Add tasks, and move
  them across columns (e.g. _To Do → Doing → Done_) as the work progresses. The
  board lives alongside the panes so you can see the plan and the running agents
  at the same time, and its tasks are saved with the workspace so they survive a
  restart.

## Task Board

The **Task Board** turns the multi-agent grid into a small command centre:
plan the work in a kanban next to the terminals, then watch the agent panes
chew through it.

- **Toggle** the panel with **`Ctrl+Shift+K`** (it slides in beside the panes).
- **Add** a task by typing into the new-task box and pressing **Enter**.
- **Move** tasks across columns as they progress from queued to in-flight to
  done.
- **Persisted** — tasks are saved with the workspace (the same mechanism that
  restores your split layout) and restored on the next launch.

A puppeteer-core smoke test, `test-taskboard.cjs`, covers the core flow
end-to-end: it boots the renderer, toggles the board with `Ctrl+Shift+K`, adds
a task, and reloads to confirm the task persisted. Run it against the dev
server:

```sh
npm run dev          # in one terminal
node test-taskboard.cjs   # in another
```

## Install (Windows)

Build the installer, then run it:

```sh
npm install
npm run dist     # writes dist/Tessel-Setup-<version>.exe
```

The installer lets you choose the install folder and adds Start menu and
desktop shortcuts. It is not code-signed, so Windows SmartScreen may warn the
first time; choose **More info → Run anyway**. `npm run dist:dir` builds an
unpacked copy in `dist/win-unpacked/` without the installer, which is quicker
for testing.

Saved workspaces, settings and tasks live in `%APPDATA%\tessel` for the
installed app and `%APPDATA%\tessel-dev` for the dev build, so one of each can
be open at the same time. The dev build shows a yellow logo and "(dev)".

**Coming from Shell Panels?** Tessel is a separate app (new app id), so it
installs next to Shell Panels instead of replacing it. On its first start it
copies your workspaces, settings, tasks and saved terminal output from
`%APPDATA%\shell-panels`. Once you have moved over, uninstall Shell Panels
from Windows Settings → Apps.

## Updates

The installed app checks the GitHub releases of this repo 15 seconds after it
starts, then every 4 hours (`src/main/updater.js`, using `electron-updater`).
A newer version downloads in the background, then an **Update x.y.z** button
appears in the toolbar (also under Settings → Updates). **Restart and update**
saves the layout, task board and terminal output, stops the terminal host,
installs silently and reopens the app, and each pane comes back where it was
(Claude and Codex resume their conversations). Nothing installs until you click.
Programs running in the terminals do stop.

To publish a release:

1. Bump `version` in `package.json`.
2. `npm run dist`
3. Create a GitHub release tagged `vX.Y.Z` and upload **all three** files from
   `dist/`: `Tessel-Setup-X.Y.Z.exe`, its `.blockmap`, and `latest.yml`
   (the app reads `latest.yml` to find the new version).

Testing without publishing: create `dev-app-update.yml` (git-ignored) pointing
at a local feed (`provider: generic`, `url: http://127.0.0.1:8765/`), and start
a dev build with `TESSEL_UPDATE_TEST=1` (and `TESSEL_USER_DATA` /
`TESSEL_PTYHOST_CHANNEL` so it doesn't touch your real app).

## Run it

```sh
npm install
npm run dev      # development (hot reload)
# or
npm run build && npm start   # build, then run the production bundle
```

A window titled **Tessel** opens with one PowerShell pane.

## Keyboard shortcuts

Press **F1** in the app for this list.

| Shortcut                        | Action                            |
| ------------------------------- | --------------------------------- |
| `Ctrl+Shift+T`                  | New terminal (default shell)      |
| `Ctrl+Shift+Space`              | Open a terminal or agent (picker) |
| `Ctrl+Shift+E` / `Ctrl+Shift+O` | Split right / split down          |
| `Ctrl+Shift+W`                  | Close pane                        |
| `Ctrl+Shift+R`                  | Restart pane                      |
| `Alt+Arrow`                     | Move focus between panes          |
| `Ctrl+Shift+F`                  | Find in terminal                  |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0`  | Bigger / smaller / reset text     |
| `Ctrl+Shift+N`                  | New workspace                     |
| `Ctrl+PageUp` / `Ctrl+PageDown` | Previous / next workspace         |
| `Ctrl+Shift+B`                  | Toggle Broadcast                  |
| `Ctrl+Shift+K`                  | Toggle Task Board                 |
| `Ctrl+,`                        | Settings                          |
| `F1`                            | Keyboard shortcuts                |

## How it works

- **Main process** (`src/main/index.js`) owns the PTYs (one `node-pty` process
  per pane) and exposes a small IPC API: `pty:create / write / resize / kill`,
  plus `pty:data / pty:exit` events and `shells:list`.
- **Preload** (`src/preload/index.js`) bridges that API to the renderer over
  `contextBridge` — the renderer has no direct Node access.
- **Renderer** (Vue) renders a recursive binary split-tree (`SplitNode.vue`);
  each leaf is a `TerminalPane.vue` (an xterm.js terminal). Input is routed
  through `App.vue`, which sends it to one pane or broadcasts it to all.
- Output is buffered per-pane (`ptyStore.js`) so a terminal's history is
  replayed if a split re-parents it in the component tree — the underlying PTY
  is never killed by a layout change, only by an explicit close.

## Notes / decisions

- **ConPTY by default, WinPTY as a fallback.** ConPTY is the modern Windows
  console backend and is required for full-screen TUIs (e.g. Claude Code) to
  redraw correctly on resize the way they do in Windows Terminal, so it is the
  default. ConPTY's teardown is handled carefully — `terminatePty()` sends
  `Ctrl+C` + `exit` and falls back to a `taskkill` tree after a short delay so a
  pane never wedges the app. Set `TESSEL_USE_WINPTY=1` to force the older
  WinPTY backend if needed. See `src/main/index.js`.
- **`ELECTRON_RUN_AS_NODE`.** If this env var is set globally, Electron boots as
  plain Node and no window appears. `launch.mjs` strips it before launching, so
  `npm run dev` / `npm start` always open the GUI.
- **No native compiler needed.** node-pty ships a prebuilt N-API binary that
  loads under both Node and Electron, so no Visual Studio build tools are
  required to install.
- **Vite 8 with `legacy-peer-deps`.** The build runs Vite 8 deliberately: Vite 8
  dropped its direct `esbuild` dependency, which clears the esbuild dev-server
  advisories that Vite ≤7 still carries. `electron-vite` 5, however, caps its
  Vite peer range at `^7` (no release declares Vite 8 support yet), and npm 10
  treats that as a hard `ERESOLVE` error — so `.npmrc` sets
  `legacy-peer-deps=true` to let `npm install` resolve it. The combination is
  verified to work (build, the full test suite, and the app booting under
  Electron 42 all pass). Remove that flag once `electron-vite` ships Vite 8
  support. If a fresh `npm install` ever leaves the app failing to launch with
  `Error: Electron uninstall`, Electron's binary download was skipped — run
  `node node_modules/electron/install.js` to fetch it.
