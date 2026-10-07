# Tessel

A Windows desktop app for working with **terminals and AI coding agents side by
side**: split one window into as many panes as you need, run Claude Code,
Codex, OpenCode and 20+ other agent CLIs in them, as a terminal or as a native
chat, and let them work together as a team while you follow everything from a
sidebar, a task board and a usage meter.

Built with **Electron + Vue 3 + xterm.js + node-pty**. Interface in **English
and French** (Settings → Appearance → Language).

_Formerly **Shell Panels**._

## Download

**To use Tessel, download the installer** from the
[Releases page](https://github.com/mindkind1337/tessel/releases/latest):
`Tessel-Setup-<version>.exe`, then run it. Nothing else is needed (no Node.js,
no `npm`), and the app updates itself afterwards.

The **Code → Download ZIP** button gives the source code instead: it is for
working on Tessel itself (see [Build from source](#build-from-source)).

## Features

### Panes and workspaces

- **Real shells in one window**: PowerShell, PowerShell 7, Command Prompt, Git
  Bash and WSL are found automatically.
- **Split, drag and arrange**: split right or down, drag dividers, even grid
  presets (2×2, 3×2, …), drag a pane by its header to any side of another pane
  or of the whole workspace, maximize one pane.
- **Workspaces and projects**: the left sidebar groups workspaces by project
  folder. Switching never stops a running shell or agent, and everything
  (layout, panes, conversations, tasks, terminal output) is restored on the
  next launch.
- **Git branches in the sidebar**: a project's other worktrees are listed under
  one folded "N other branches" line; an agent can work in its own copy (its
  own worktree and branch) so two agents never overwrite each other.
- **Add a project**: browse a folder, clone from a URL, create one, or import
  every repository in a folder, on this computer or on an SSH host. A new
  project opens on a **launcher** instead of a shell: pick an agent, a
  terminal, a web page, or resume one of the project's recent sessions.
- **Clean up worktrees**: one dialog lists every worktree with its git
  evidence (clean or dirty, merged or not, last activity); safe ones are ticked.
- **Drop-down terminal** (``Ctrl+` ``): a terminal over any view that keeps
  running while hidden.
- **Crash recovery**: if the window's page crashes, it reloads with the same
  layout and the same running terminals.
- **Broadcast**: type once into every pane you pick.
- **Built-in browser**: a real browser in a pane or in the side panel (drag a
  page between them), with a design mode to pick an element and send feedback
  about it to an agent. **Import cookies** from Chrome, Edge, Brave, Firefox…
  (your default browser first) to stay signed in to your sites.
- **Files, editor and Source Control**: a compact file explorer like VS Code's
  (compact folders, indent guides, only visible rows drawn), an editor pane,
  and a Source Control panel (changes by folder, stage per file, commit,
  commits graph with times, create a pull request, send failing checks or
  review comments to an agent).
- **Side panel**: Dashboard of agents, agent session history, task history
  (time, tokens and estimated cost per task), files, Source Control and web
  pages; each tab says when it is loading.

### Remote hosts over SSH (like VS Code Remote-SSH)

- Hosts from `~/.ssh/config` or Settings → SSH Hosts; one shared connection per
  host for terminals, files and git, the password asked once.
- **Agents run on the host**: Claude Code and Codex start on the server, in
  the project's folder, with **all of Tessel's tools** (team, task board,
  browser, terminals) through a small helper Tessel puts in your home folder
  there (no root needed). A missing agent shows a card in its pane to install it.
- Their conversations, history, model, cost and skills are read on the host;
  file links open the host's files.
- **Stable on slow or dropped links**: your clicks go first, every remote call
  has a time limit, a slow host says so, and when the connection comes back
  the project's panes reopen and agents resume their conversations.

### Agents

- **20+ agent CLIs** detected on your computer (Claude Code, Codex, OpenCode,
  Gemini CLI, GitHub Copilot CLI, Kimi, Cline, Cursor, Grok, Qwen Code, Amp,
  Aider and more). Missing ones can be installed from Tessel.
- **Unique names**: every agent gets its own name (Ada, Bohr, Curie…) shown in
  its pane, the sidebar, the task board and team messages. Rename it any time.
- **Model and effort per pane**: pick them when you start an agent or later
  from the pane menu. The header shows the model and effort the agent really
  runs with, read from its own conversation, in your language.
- **Live state for every agent**: working, waiting for you, approval needed,
  usage limit, interrupted, idle. It comes from the agents' own hooks, with the
  screen as a fallback, and shows as a dot on the agent's logo in its pane and
  in the sidebar.
- **Sub-agents**: the ones an agent starts (Claude Code, Codex, OpenCode,
  Cline…) show under it, with their type, model and state.
- **Yolo mode**: run agents without permission prompts, everywhere or only in
  chosen folders; it is kept when an agent or Tessel restarts.
- **Resume and history**: agent panes come back with their conversation after
  a restart; you can browse and reopen past sessions of every agent.
- **Agent updates**: Tessel checks for new versions of your agents, updates
  them in the background, and restarts each pane on the new version when it is
  idle, with its conversation resumed. A new version's models appear by
  themselves.
- **MCP servers and tools**: see every MCP server for Claude Code and Codex,
  test the connection, copy a server to another agent, and install from a
  catalog of popular servers and developer tools.
- **Browser tools for agents**: an agent can open pages, click, fill, read and
  take screenshots in Tessel's browser; you see a badge on the page and can
  stop it. After you import cookies, agents use a separate session without
  your logins (Settings → Browser).
- **Terminal tools for agents**: an agent runs commands in a terminal of its
  own next to its pane (on the project's SSH host when it is there). Each
  command asks first, with rules like VS Code's (allow a command for the
  session, the project or always; risky ones always ask). Reading or typing in
  your own terminals needs your approval, shows a badge with Stop, and is
  logged. Passwords never go through the agent.

### Native chat

Claude Code, Codex and OpenCode can run as a **chat** instead of a terminal,
on the same conversation:

- A message list with Markdown, code, diffs and tool runs; a composer with
  `/` commands and skills, image attachments (paste, drop or **+**), voice
  typing, and model, effort and permission pickers.
- Messages typed while the agent works go straight into its running turn, as
  in a terminal.
- Question and approval cards you answer in place.
- A context ring, a **Compact** button when the context is almost full, and an
  automatic compact-and-resend when a conversation gets too long.
- Earlier history (images and files included), older pages on demand, and
  sub-agents in the header.
- **Switch a pane between chat and terminal** at any time: same conversation,
  same pane, same permission mode. While the agent works, the switch waits for
  the end of its turn.
- **Chat view over a terminal agent**: Claude Code, Codex, Cursor and others
  running in a terminal can also be shown as a chat (images, model and effort,
  modes, `/` commands) without restarting them. Approval cards show what the
  agent asks (the command, file or address) and its own choices.

### Teams and the task board

- **Teams**: put agents in a team; they message each other with Tessel's team
  tools, and a lead can start workers in new panes, hand out tasks and review
  their work. A small number beside each agent shows its team.
- **Task board**: a kanban beside the panes (`Ctrl+Shift+K`). You and the
  agents add and move cards, so you can see who does what. Tasks are saved
  with the workspace, with the tokens, time and estimated cost of each one.

### Usage and search

- **Usage meter**: the quotas of Claude, Codex and other providers (5-hour and
  weekly windows, plan, reset times), refreshed every 2 minutes and live from
  running chats; the icon turns yellow at 60 % and red at 80 %.
- **Session search** (opt-in): find a conversation by what was said in it,
  across agents, from a local private index.

### Everyday comfort

- Command palette (`Ctrl+Shift+P`), find in terminal, zoom, copy on select,
  notifications when an agent needs you, themed menus and lists everywhere.
- Low CPU and GPU use: hidden terminals stop drawing while agents work.

## Keyboard shortcuts

Press **F1** in the app for the full list.

| Shortcut                        | Action                            |
| ------------------------------- | --------------------------------- |
| `Ctrl+Shift+P`                  | Command palette                   |
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
| `Ctrl+Shift+X`                  | Toggle the file explorer          |
| ``Ctrl+` ``                     | Drop-down terminal                |
| `Ctrl+,`                        | Settings                          |
| `F1`                            | Keyboard shortcuts                |

## Updates

The installed app checks this repo's GitHub releases shortly after it starts,
then every few hours. A newer version downloads in the background, then an
**Update x.y.z** button appears in the toolbar (also under Settings →
Updates). **Restart and update** saves everything, installs silently and
reopens the app; each pane comes back where it was and agents resume their
conversations. Nothing installs until you click. Programs running in the
terminals do stop.

## Build from source

For developing Tessel. Requires Node.js 22+ on Windows.

```sh
npm install
npm run dev          # the development version (hot reload)
npm run dev:hidden   # the same, in the background with no console window
npm test             # the unit tests
```

If Electron's download was skipped during `npm install`, `npm run dev` fetches
it by itself before starting.

To build your own installer:

```sh
npm install
npm run dist     # writes dist/Tessel-Setup-<version>.exe
```

The installer is not code-signed, so Windows SmartScreen may warn the first
time; choose **More info → Run anyway**. `npm run dist:dir` builds an unpacked
copy in `dist/win-unpacked/` without the installer.

Saved workspaces, settings and tasks live in `%APPDATA%\tessel` for the
installed app and `%APPDATA%\tessel-dev` for the dev build, so one of each can
be open at the same time. The dev build shows a yellow icon and "(dev)".

**Coming from Shell Panels?** Tessel installs next to it and, on its first
start, copies your workspaces, settings, tasks and saved terminal output from
`%APPDATA%\shell-panels`. Then uninstall Shell Panels from Windows Settings →
Apps.

### Publishing a release

1. Bump `version` in `package.json`.
2. `npm run dist` (from a clean checkout with its own `npm ci`).
3. Create a GitHub release tagged `vX.Y.Z` and upload **all three** files from
   `dist/`: `Tessel-Setup-X.Y.Z.exe`, its `.blockmap`, and `latest.yml` (the
   app reads `latest.yml` to find the new version).

## How it works

- **Terminal host**: terminals run in a separate process (`src/main/ptyHost.js`)
  so they survive an app restart or crash; the app re-attaches and replays
  their output.
- **Main process** (`src/main/`): windows, the agent state store fed by the
  agents' hooks, the native chat engine (`src/main/chat/`), usage readers,
  session search (in its own utility process), updates, and a small IPC API
  guarded so only the app's own page can call it.
- **Preload** (`src/preload/index.js`) bridges that API to the renderer over
  `contextBridge`; the renderer has no direct Node access.
- **Renderer** (Vue 3): a split tree of panes (terminal, chat, browser,
  editor), the sidebar, the task board and the menus.

## Notes

- **ConPTY by default, WinPTY as a fallback.** ConPTY is needed for full-screen
  TUIs such as Claude Code to redraw correctly; set `TESSEL_USE_WINPTY=1` to
  force WinPTY.
- **`ELECTRON_RUN_AS_NODE`.** If this variable is set globally, Electron starts
  as plain Node and no window appears; `launch.mjs` removes it before starting.
- **No native compiler needed.** node-pty ships prebuilt binaries.
- **Vite 8 with `legacy-peer-deps`.** `electron-vite` 5 still declares Vite 7
  as its peer, so `.npmrc` sets `legacy-peer-deps=true`. If a fresh install
  fails to launch with `Error: Electron uninstall`, run
  `node node_modules/electron/install.js`.
