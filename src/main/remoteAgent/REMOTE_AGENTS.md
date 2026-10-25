# Agents on an SSH host (remote agents)

Goal: an agent (Claude Code, Codex) started in a Tessel SSH pane works like a
local one: team tools (tessel-team MCP), status from hooks, board, messages.
Same idea as VS Code Remote-SSH: Tessel puts a small helper on the server and
talks back through the SSH connection it already holds.

v1 scope: ssh2 panes only (the shared connection in the terminal host,
`ssh/sshHostBridge.js`). Panes that need the system ssh.exe (ProxyJump…) stay
as today. Usage/quota of remote accounts: later (which account an agent there
is signed in with, and account folders: below).

## Key choice: the team tools run on the PC, not on the server

The remote agent does not run `server.cjs` on the server. It runs a tiny
dependency-free shim (`tessel-shim.cjs`, Node >= 18 on the server) that pipes
its stdio through a Unix socket on the server. That socket is forwarded by
sshd to Tessel (ssh2 `openssh_forwardInStreamLocal`). Tessel's terminal host
then runs the normal local `server.cjs` (MCP or `--hook`) with the pane's
normal local environment. So `server.cjs`, the team channel, the board, the
agent-status store and the browser tools need no change: for them it is a
local pane. A remote project keeps its `.tessel` data on the PC, in
`<userData>/remote-projects/<hostId>/<sha1(remotePath)>/` (TESSEL_PROJECT_DIR).

```
server                                   PC (terminal host)          PC (main)
claude --stdio--> node tessel-shim.cjs mcp
                    | unix socket ~/.tessel-server/run/<instance>.sock
                    '==== ssh2 streamlocal forward ====> remoteAgentTunnel
                                                         check pane+token
                                                         spawn node server.cjs  (env from main)
```

## Contract (all parts must follow this exactly)

### On the server
- `~/.tessel-server/bin/tessel-shim.cjs` (mode 0700 dir, 0600/0700 file),
  `~/.tessel-server/bin/VERSION` (shim version string).
- `~/.tessel-server/run/` (mode 0700): the forwarded sockets,
  `<instance>.sock`, `<instance>` = `[a-z0-9-]{1,40}` (app flavour + hostId
  hash), stable across reconnects; Tessel removes a stale one before binding.

### Environment of a remote pane (from a file the pane's shell sources)
Never on a command line (other users of the server could read it in ps /
/proc). Before each shell of the pane starts (first open and every
reconnect), the terminal host writes `~/.tessel-server/run/<pane>.env`
(0600, in the 0700 run folder) through an exec channel's stdin:
`export TESSEL_PANE_ID='..' TESSEL_REMOTE_SOCK='..' TESSEL_REMOTE_TOKEN='..' [TESSEL_AGENT_PROVIDER='..']`.
The pane command starts with `[ -r F ] && . F; rm -f F;` (a missing file
would end a POSIX sh), then `cd -- '<path>' && exec "$SHELL" -l` or
`exec "$SHELL" -l`. A file left by a shell that never started is removed
when the pane exits (if the host is still connected). The variables:
- `TESSEL_PANE_ID` – the pane id.
- `TESSEL_REMOTE_SOCK` – absolute path of the socket.
- `TESSEL_REMOTE_TOKEN` – 64 hex chars, random per pane launch.
- `TESSEL_AGENT_PROVIDER` – `claude` / `codex` when Tessel launched an agent.
Never the team secret: it stays on the PC.

### Wire protocol on the socket (v1)
1. Client sends one line: `{"v":1,"pane":"<id>","token":"<hex>","kind":"mcp"|"hook","args":["..."]}\n`
   (max 8 KiB; `args` max 16 strings of 256 chars, for hook: the arguments
   after `--hook`, e.g. `["claude","Stop"]`).
2. Server answers one line: `{"ok":true}` or `{"ok":false,"error":"<code>"}`
   then closes. Codes: `bad-hello`, `bad-token`, `unknown-pane`, `busy`, `failed`.
3. `kind:"mcp"`: then a raw two-way byte stream (client stdin -> server.cjs
   stdin, server.cjs stdout -> client stdout). Either side closing ends it.
4. `kind:"hook"`: client sends the hook's stdin bytes (max 1 MiB) then ends
   its write side; server runs `server.cjs --hook <args>` with it, then sends
   one line `{"exit":<n>,"stdout":"<base64>","stderr":"<base64>"}` and closes.
   Hook run time max 30 s (exit 124 when killed).
   Hook args: `args[0]` is `claude` or `codex` (else `bad-hello`); the tunnel
   runs `server.cjs --hook` (claude) or `server.cjs --hook --codex` (codex)
   and drops the event name (server.cjs reads it from stdin).
Token compared with `crypto.timingSafeEqual`. Max 32 open connections per host.
Hello read timeout 10 s. Hook: `{"ok":true}` right after a valid hello, then
stdin; stdin over 1 MiB or spawn failure -> exit line with exit 1. MCP: ok
only once node has spawned (else `failed`). `TESSEL_REMOTE_SOCK` is built by
the terminal host from the remote `$HOME` (prep exec channel); the pane's
shell opens after the bind (waits ~10 s at most, then opens anyway).
Main passes `msg.ssh.remoteAgent = { token, instance, provider, env, node,
script }` in the create message; none -> the pane behaves as today.
Caps (answer `busy`): at most 16 MCP connections + hooks past their hello
over all hosts; per pane at most 4 MCP connections and 4 hooks at once, and
hooks limited by a token bucket of 10 per second. An MCP connection with no
byte in either direction for 30 min is closed (its server.cjs killed).
server.cjs runs with cwd = the pane env's `TESSEL_PROJECT_DIR` (when absolute).

### Shim modes (`node tessel-shim.cjs <mode>`)
- `mcp` – connect, hello, pipe stdio. No socket/env, or Tessel unreachable (an agent
  started outside Tessel, e.g. VS Code) → a silent empty MCP server (no tools).
- `hook <args...>` – connect, send stdin, print stdout/stderr, exit with code.
  Unreachable Tessel → exit 0 silently (a hook must never block the agent).
- `install` – idempotent: Claude `~/.claude.json` `mcpServers["tessel-team"]` =
  `{type:"stdio",command:"node",args:["<abs shim>","mcp"]}`; Claude
  `~/.claude/settings.json` hooks (same events as `teamInstall.js` installs
  locally) running `'<node>' '<abs shim>' hook claude <Event>` (`--node <abs>`
  given: that node everywhere; else `node`); Codex
  `~/.codex/config.toml` `[mcp_servers.tessel-team]` with `env_vars =
  ["TESSEL_PANE_ID","TESSEL_REMOTE_SOCK","TESSEL_REMOTE_TOKEN","TESSEL_AGENT_PROVIDER"]`
  and `~/.codex/hooks.json`. Only touches files that exist or whose agent is
  installed; writes atomically (tmp + rename), keeps a `.tessel-bak` once,
  never removes the user's other entries. Prints one JSON line with what it did.
  Since 1.3.0 also the account folders below (marker checked): Claude's
  `<folder>/.claude.json` (Tessel's server, plus the user's MCP servers of this
  same host's `~/.claude.json`) and `<folder>/settings.json` hooks; Codex's
  `<folder>/config.toml` and `hooks.json` (a missing one becomes a link to the
  default folder's first). The MCP servers: copied once and recorded in
  `<folder>/.tessel-mcp.json` (0600: their names and a digest of what was
  copied); while the account's copy is as Tessel left it, it follows the
  default one (a rotated key in its env or headers, a changed command) and
  goes when that one goes; one the user changed or removed in the account is
  left as they made it, never copied again, never doubled. Their env/header
  values (keys included) are the user's own config on that host already:
  they never leave it.
- `version` – prints VERSION.

### Account folders (remoteAccounts.js, remoteAccounts.sh)
- `~/.tessel-server/accounts/<claude|codex>/<id>/` (mode 0700, `<id>` =
  `[0-9a-z]{1,40}`), with `.tessel-account` = `tessel-account <agent> <id>`.
  Only a folder with that marker is Tessel's: listed, repaired, set up by
  `install`, removed. Never another folder, never the agent's own.
- A pane on one runs its agent with `CLAUDE_CONFIG_DIR='<folder>'` /
  `CODEX_HOME='<folder>'` before its command. You sign in there with the
  agent's own login; no sign-in is ever copied from the PC.
- Claude: `projects`, `plugins`, `skills`... are links into `~/.claude` (one
  conversation goes on across accounts; `__t_tfile` finds it there); its
  `.claude.json` and `.credentials.json` are its own. Codex: settings, hooks,
  AGENTS.md, skills are links into `~/.codex`; its sign-in and `sessions` are
  its own (`__t_tfile` and the shim's `sessions` look there too).
- `__t_accts` prints identity fields only (email, organization, plan, login),
  each taken by its key name; a token is only ever tested for presence (and
  whether a settings.json or the login shell sets an API key, a token, a key
  helper or a gateway that Claude Code would use instead of the sign-in).
  `__t_accts login` runs the login shell (6 s at most, its whole process tree
  ended past that) to read its CLAUDE_CONFIG_DIR / CODEX_HOME and exports:
  main asks it once per connection and on an explicit refresh, then passes
  the folders back (`__t_accts dirs <claude|-> <codex|->`).
- Removal (`__t_acctrm`): the window names the panes still on that login and
  main stops them after the yes; on the host the sign-in file goes first,
  Codex's sessions, archived sessions and either agent's history.jsonl go to
  the agent's own folder, then the folder is moved to
  `accounts/.trash-<agent>-<id>-<pid>` (a running agent can no longer write
  into it) and deleted. A folder there without its marker that still holds
  a sign-in (an agent wrote it again) is listed as `orphan` and removed only
  as such (`__t_acctrm <agent> <id> orphan`).
- Where Claude Code keeps an account with `CLAUDE_CONFIG_DIR`: its login in
  `<folder>/.credentials.json` (the macOS Keychain, one entry per folder, on
  a Mac), its profile (`oauthAccount`: email, organization) in
  `<folder>/.claude.json`, or `<folder>/.config.json` when that older file
  is there. `oauthAccount` holds nested objects: read with a brace-matching
  reader, never a flat pattern.
- A folder's sign-in files are never links (only its settings and
  conversations are): one that is a link (made outside Tessel) is listed
  `linked`, and `__t_acctmk` refuses it (rc 98), so no agent runs on another
  folder's login or writes that one's renewed token.
- The host's default account per agent (Settings `hostAccountDefaults`): a
  new pane, a team worker, the launcher and a restart without an account of
  its own start on it, through `launchEnv(..., { signedIn: true })`
  (`__t_acctmk <agent> <id> signed`: rc 92 when the folder holds no sign-in);
  gone or signed out, the pane starts on the host's own sign-in and says so.
- The folder a pane's agent really runs on (`__t_acctpane <pane> <agent>
  [<pane> <agent>...]`, Linux): one pass over the user's own processes
  (`[ -O /proc/<pid> ]`; as root, another user's could pass for a pane) for
  all the panes of a host asked together (the window waits 1.5 s for the
  others, 6 s at most). An environment is read as whole NUL-separated
  entries (one awk with RS NUL; BusyBox: `tr` first), the first
  `TESSEL_PANE_ID` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME` entry as getenv
  sees it, nothing else of it printed. Every agent process of a pane is
  compared: on different folders (an older session's agent still running)
  it answers `mixed` and none is taken. A folder counts as Tessel's only
  under the home the same run prints (`@h`). Asked 8 s after a launch and
  on Check again, never per poll. A pane whose agent runs elsewhere than
  its layout says is changed only when that is sure and the saved account
  is not signed in there; otherwise the pane asks (Update / Keep).
- "Copy account details" (`__t_acctdiag`): presence flags only (yes / no),
  never a value, an email or a token (a key in the process's environment is
  tested with `grep -q '^NAME=.'`, never read into the shell).

## Parts
1. Shim (`src/main/remoteAgent/tessel-shim.cjs` + tests) – Gauss.
2. Tunnel in the terminal host (`src/main/remoteAgent/remoteAgentTunnel.js`,
   hooks into `ssh/sshManager.js` / `ssh/sshHostBridge.js` + tests) – Hopper.
3. Wiring in main (`index.js` createSshPane: token, env export, local project
   dir, upload + `install` through the Files session, agent status for ssh2
   panes) – lead, after 1 and 2.
4. Test bench: sshd in WSL Ubuntu on 127.0.0.1:2222, then a final test on a
   real server with the user.

## Shim 1.4.0: the MCP stdio survives a closed tunnel

`tessel-shim.cjs mcp` no longer exits when the forwarded connection ends (30 min
idle, SSH drop, Tessel restart): it keeps the agent's stdio, and the next call
opens a new connection (hello, replay of the client's `initialize` under an id
the client never sees). A call running when the link dropped, or one the new link
refuses, is answered with a tool result `isError` saying what happened and what to
do. The tunnel logs `remote agent tools opened/closed` with the reason.
