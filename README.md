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
  folder; drag projects to put them in your order (or Alt+Up / Alt+Down on
  one). Switching never stops a running shell or agent, and everything
  (layout, panes, conversations, tasks, terminal output) is restored on the
  next launch.
- **Sleep**: a pane put to sleep stops its terminal to free memory and keeps
  its place; opening it wakes it (an agent resumes its conversation, a
  terminal starts again in the same folder under what it showed). Put a pane,
  or every agent and terminal of a workspace, to sleep from its menu in the
  sidebar; idle agents can sleep by themselves (Settings → Agents). **Start
  terminals asleep** (Settings → General) brings every agent and terminal back
  asleep at launch, so only the panes you open run.
- **Hide the task under agents** (the sidebar's options menu): the agent rows
  show only their names, without the board card's title under each.
- **Groups of projects**: put projects of the same kind in a group of your own
  (**Group** in a project's menu): a folding row with the projects under it, to
  make room in the sidebar. Groups are saved with your settings.
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
- **Saved passwords**: import logins from your browsers into an encrypted,
  on-this-computer vault (never sent through Live Share), then fill them on a
  private page. All profiles of every Chromium browser are found — Chrome (and
  Beta/Dev/Canary), Edge, Brave, Vivaldi, Opera, Opera GX, Chromium, Yandex,
  Arc — including Opera GX's `Default` layout, and Firefox and its relatives
  (Developer Edition, Zen, LibreWolf, Waterfox, Floorp) by reading their
  `logins.json`/`key4.db`. Two cases cannot be read directly and are reported
  with the fix: Chrome/Edge 127+ entries under **App-Bound Encryption** and
  Firefox profiles with a **Primary Password** — for both, and for Safari, the
  dialog explains how to export a CSV and import that instead. **Import from
  all browsers** reads every profile in one go and shows one result line per
  profile (new, updated, already saved, skipped, what needs a CSV export); one
  failing profile does not stop the others, and a login already saved is left
  as it is, its agent access included. The saved list is one compact row per
  login, sorted by site, with an instant search over sites and usernames
  ("12 of 73"), how many accounts agents may use, and a per-account agents
  switch, Fill and Remove (asks first).
- **Files, editor and Source Control**: a compact file explorer like VS Code's
  (compact folders, indent guides, only visible rows drawn), an editor pane,
  and a Source Control panel (changes by folder, stage per file, commit,
  commits graph with times, create a pull request, send failing checks or
  review comments to an agent). The GitHub dialog (issues and pull requests)
  also works for a project folder that is not a Git clone, such as an
  installed app: it asks once which repository to show (`owner/name` or its
  URL), checks it with gh, remembers it for that folder, and a **Change
  repository** link in its header picks another.
- **Files the editor shows in their own view** (read-only, on this computer
  and on SSH hosts, up to 30 MB):
  - **PDF** in an editor tab (pages drawn as they come into view, zoom);
  - **Excel and OpenDocument sheets** (`.xlsx`, `.xlsm`, `.ods`): sheets as tabs,
    tables with column letters;
  - **Word and OpenDocument text** (`.docx`, `.odt`): headings, lists, tables,
    links; **PowerPoint and OpenDocument slides** (`.pptx`, `.odp`): the text of
    each slide;
  - **audio and video** in Chromium's player;
  - Markdown, Mermaid diagrams, CSV/TSV tables, JSON and images, as before.
- **HTML preview like a real website**: the project's folder is served on this
  computer (for an SSH project, its files are read on the host), so a page's
  CSS, images and fonts load by their paths. As with VS Code's Workspace Trust,
  one question per folder decides whether its scripts run; without trust the
  page shows without them. A link to another site is held back until you click.
  Trust is specific to the served folder, including case-sensitive SSH paths;
  changing the served root checks trust again. Static HTML and Markdown previews
  do not automatically contact Windows network shares; a document opened on a
  share can load images from that same share. Raw HTML inside Markdown cannot
  load external media or use inline styles to fetch resources.
- **Side panel**: Dashboard of agents, agent session history, task history
  (time, tokens and estimated cost per task), files, Source Control and web
  pages; each tab says when it is loading. In the Dashboard, right-click an
  agent's card to go to its pane, put it to sleep (or wake it), or close it.

### Remote hosts over SSH (like VS Code Remote-SSH)

- Hosts from `~/.ssh/config` or Settings → SSH Hosts; one shared connection per
  host for terminals, files and git, the password asked once.
- **Agents run on the host**: Claude Code, Codex and Antigravity start on the
  server, in the project's folder, with **all of Tessel's tools** (team, task
  board, browser, terminals, connectors) through a small helper Tessel puts in
  your home folder there (no root needed; Antigravity gets the tools, not yet
  its live status). An agent started while the connection was down gets its
  tools as soon as it is back, without a restart. A missing agent shows a card
  in its pane to install it.
- **No "trust this folder?" question in your remote projects**: with Settings →
  Agents → "Trust the folder when Tessel starts an agent" on, Tessel marks the
  folder of a project you added on the host as trusted in Claude Code's own
  config there (its subfolders follow, as Claude Code does), for the account the
  pane runs on, just before it starts. Only that one entry changes; a config
  file Tessel cannot read is left alone, the home folder, anything above it and
  a folder that is a link to another place are never trusted, and it happens
  only on a connection that is already signed in. Codex still asks.
- Their conversations, history, model, cost and skills are read on the host;
  file links open the host's files.
- **tessel-host on the server** (like VS Code's server; experimental, off by
  default: per host, Advanced → *Tessel daemon on the server*): at the next
  connection to that host, Tessel looks for its own small daemon there and puts
  it under `~/.tessel-server/host` when missing (Linux x86_64 and arm64, no
  root, over the signed-in connection, checked against its checksum before
  and after the copy). The Files panel then gets its folder listings and its
  change notices from the daemon's file watcher, and its git letters from the
  daemon's status cache, kept current from file system events, instead of a
  `find` every few seconds and a `git status` over the whole tree after every
  change. A host where the daemon cannot run (another kind of machine, a home
  folder that refuses to run programs) keeps the shell-based path as before,
  and a build without the programs (`resources/host`, a plain checkout) too.
- **Sessions that survive a dropped connection**, on by default (per host,
  Advanced → *Keep sessions alive on the server* turns it off): the host's
  terminals run inside a `tmux` session on the server, with no status bar, and
  a lost connection re-attaches to the same session instead of starting a new
  shell, so an agent running there keeps going. The mouse wheel scrolls that
  session's history (the arrow keys stay the shell's history; a full-screen
  program such as Claude Code's full-screen view, `less` or `vim` gets
  PageUp/PageDown per notch), and a selection made in it reaches the
  clipboard. The server's own `tmux` is
  used; when it has none, Tessel puts its own statically built `tmux` in
  `~/.tessel-server/bin` there (Linux x86_64 and arm64, no root needed, checked
  against its checksum on the host, run once to prove the home folder may run
  it) before the terminal opens, or in the background for the next terminal
  when the first one opens on a host not connected yet. A host where that is
  impossible (another kind of machine, a home folder that refuses to run
  programs) says so in the pane and runs as before, as does every host when
  Tessel was built without the bundled binaries (`resources/tmux`, a plain
  checkout). Closing the pane ends its
  session. Hosts reached through a jump host or a proxy command use the system
  `ssh` and are not covered.
- **Stable on slow or dropped links**: your clicks go first, every remote call
  has a time limit, a slow host says so, and when the connection comes back
  the project's panes reopen and agents resume their conversations. A stall of
  up to 3 minutes on the link does not drop the session.
  When a connection ends, the terminal host log (`pty-host.log`) gets one line
  with what ended it, the local port (to match the server's own log), its age, the
  time since a byte last moved, the keepalive in force and how late the process's
  timers were, then a probe of whether the server answers.
- **Light on a production server**: Tessel's own commands on the host run at the
  lowest priority (`renice`, `ionice`), and git reads never take its locks. Above
  2,000 changes the line counts are skipped, and after a slow `git status` the
  automatic reads wait three times as long (up to 5 minutes).

### Agents

- **20+ agent CLIs** detected on your computer (Claude Code, Codex, OpenCode,
  Gemini CLI, GitHub Copilot CLI, Kimi, Cline, Cursor, Grok, Qwen Code, Amp,
  Aider and more). Missing ones can be installed from Tessel.
- **Unique names**: every agent gets its own name (Ada, Bohr, Curie…) shown in
  its pane, the sidebar, the task board and team messages. Rename it any time.
- **Model and effort per pane**: pick them when you start an agent or later
  from the pane menu. The header shows the model and effort the agent really
  runs with, read from its own conversation, in your language.
- **Shift+Enter** adds a line to your message to an agent instead of sending it.
- **Requests wait while you write**: when an agent asks for your OK while you are writing, the
  request waits behind an **Agent request** button in the toolbar instead of opening over your
  text, until you click it. If a card opened by itself and you keep typing, or you click beside
  it, it goes to that button too, and your keys go to what you were writing.
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
  catalog of popular servers and developer tools. A remote server has a Sign in
  on each agent's line, and a Sign in all on its card that starts each agent's
  own sign-in in turn (Codex and OpenCode in a pane; the card says what to type
  for Claude Code, Gemini CLI and Qwen Code). Each agent keeps its own token, so
  Tessel's test cannot see whether an agent has already signed in: the badge
  says "Signs in from the agent" rather than "needs sign-in".
- **Tessel account** (Settings → Tessel account): an optional account. You log in
  on a web page in your own browser, with Google, GitHub or an email address and a
  password, so no password passes through the app, and the browser then asks to open
  Tessel, which shows who is signed in. You confirm your address by
  email, can reset a forgotten password by email, get a link to change it, sign out
  or delete the account; security changes are confirmed by email. Tessel works the
  same without an account. It keeps your email address, name, password as a hash
  and Google or GitHub ID on Tessel's server, never your mail, calendar or files.
  The owner's account also sees an Administration button there, which opens
  Tessel's admin panel (admin.tesselcode.com) in the browser.
- **Your settings everywhere** (Settings → Tessel account): once you turn it on, how
  Tessel looks, your projects and their layout, SSH hosts and task cards follow you to
  every computer you sign in on. They are encrypted on your computer before they leave
  it, with a key made from a sync phrase you choose, or one Tessel suggests (at least 12
  characters; it refuses the most common patterns, which proves little, so several
  unrelated words or the suggested one are best). Tessel's server keeps the last 5 versions of a copy it cannot
  read. What it can see is when a version was sent, how often that happens, and a rough
  size: each copy is padded to one of a few large sizes. The name of the computer that
  sent it and the time it says are inside the encryption. The phrase is asked once per
  computer, and again after you sign out; it never leaves the computer. If you lose it,
  nobody can recover it, and starting over erases the copies on the server.

  In a copy, encrypted: how Tessel looks and how its panels are arranged, your projects
  with their folders, your panes with the names you gave them and each agent's
  conversation id, your SSH hosts' names and addresses, and your task cards' words.
  Never in a copy: sign-ins, saved passwords, agents' environment variables, the command
  a pane runs (each computer uses its own for that agent, so a key in a custom command
  stays on its computer), what a browser pane shows (its address and title), what
  decides what agents may do (agent commands and rules, Yolo, trusted guests and
  folders), teams, the broadcast switch, side browsers, a host's proxy command, jump host
  and key file, and the activity history and task history. Any other setting stays what
  each computer has: only a fixed list of appearance and panel settings travels.

  Your setup uploads a few minutes after it changes, and at quit if that is quick. If
  most of it just vanished (a file is gone, most of your projects are not there any
  more), nothing goes up: you are asked, and can send it, or look at the copy. Earlier
  copies lists the versions the server keeps, and you can go back to one.

  A newer copy from another computer is never applied by itself: you see which computer,
  when, and what it holds next to what this computer has, then use it, which applies at
  the next start of Tessel and restarts only if you ask, or keep this computer's, which
  replaces it. A copy older than the one this computer last saw says so; a computer new
  to the account has nothing to compare with, and shows you when it was made. A copy
  that is out of shape in any way is refused whole. Nothing starts by itself on the
  computer that gets a copy: an agent or a terminal waits until you click Wake it and a
  chat until you write to it, and that first start asks before acting, whatever a Yolo
  setting or your own arguments for that agent say, so you choose Yolo from its menu if you
  want it. Only a terminal that was
  already running here carries on as it is. An agent whose folder or program is not on
  this computer comes back as a plain terminal in your home folder, and that stays
  between you and this computer: the other computers keep their agent. Agents ask before
  trusting a folder that came with a copy, and a folder on a network share is refused
  without ever being looked at. SSH hosts keep this computer's name, proxy command, jump
  host, key file and `~/.ssh/config` alias, and hosts only on this computer stay. If a copy
  adds a host, changes where one you have connects, or moves a project or a pane to
  another host, you see it all in one question, and none of it happens unless you agree.
  Task cards from a copy tell agents that their words came from a copy.

  Being offline or signed out changes nothing and shows no alert. What needs you stays on
  screen until it is dealt with: the copy is gone from the server, it was replaced under
  another phrase, a file cannot be read so uploads stopped. What the server says never
  turns anything off here or drops your key: you choose. You can sync now or turn it off,
  and choose to erase the copies on the server too; deleting your account erases them as
  well.

  What this cannot do: a server can hold back newer copies, which no computer can notice.
  Someone with a stolen session cannot read a copy, but can erase the kept versions with
  one request, or push them out with five writes; your setup on each computer survives,
  what they wrote is refused or asked about, and a lasting alert shows.
- **Connections** (Settings → Connections): connect your accounts to your agents:
  Gmail, Google Calendar and Drive (nothing to set up with a Tessel account; without
  one, or if you prefer, with your own free Google Cloud OAuth client; Google warns
  that Tessel's app is not verified yet), Outlook and OneDrive for personal Microsoft accounts,
  Dropbox, Todoist, Airtable, ClickUp and monday.com. Gmail and Outlook can read
  mail and write drafts, and offer agents no tool to send mail. There is one
  Connect button per service, for all your agents at once. It adds the server to every agent that
  lacks it and starts the sign-in in your own browser; Google and Microsoft sign
  in once for all agents, hosted services have one Sign in per agent. The page
  shows whether a Google or Microsoft sign-in still works. A server from a
  project's own settings is never started or copied from here.
- **Browser tools for agents**: an agent can open pages, click, fill, read and
  take screenshots in Tessel's browser; you see a badge on the page and can
  stop it. After you import cookies, agents use a separate session without
  your logins (Settings → Browser).
- **Terminal tools for agents**: an agent runs commands in a terminal of its
  own next to its pane, or below it when there is no room beside it (on the
  project's SSH host when it is there). Its web pages and the panes it opens for
  you are placed the same way. Each
  command asks first, with rules like VS Code's (allow a command for the
  session, the project or always; risky ones always ask). Reading or typing in
  your own terminals needs your approval, shows a badge with Stop, and is
  logged. Passwords never go through the agent. Each terminal keeps the list of
  what agents ran in it (**Agent commands**): kind, agent, time, and the command,
  folded when long, with Copy.
- **Agents on an SSH host can reach your PC, with your approval**: with
  `run_in_terminal` and `host: "local"`, a PowerShell opens on your computer. You
  are asked first, then for every command, even for an agent in Yolo. The
  `tessel_logs` tool reads Tessel's own logs, filtered and read only, with a
  single approval. Agents already running get these after a restart.
- **Importing a settings file is safe by default**: unless you tick the security part,
  a file from elsewhere cannot choose what a pane starts with. Commands this computer
  does not know, a Yolo pin, a conversation id that is not one, folders on a network
  share and a host's proxy or jump host are all left out. A layout nested absurdly
  deep is refused. An export no longer holds how panes were launched.
- **Antigravity CLI on an SSH host picks its conversation back up**: when its pane restarts,
  as on your computer. Tessel finds which conversation the pane is in from the host's own
  files, and resumes it if it is still there. It starts fresh until you have sent it a first
  message.
- **An agent says why, and Tessel knows who wrote to it**: `run_in_terminal` and
  `open_terminal` need a reason, shown under **Why** on the card with the project
  it comes from, and kept in the terminal's **Agent commands** list and the log.
  In a project shared with Live Share, Tessel notes who pressed Enter last in each
  agent's pane, because the person writing to an agent may be on another computer.
  When that was a guest, `host: "local"` means **their** computer, not yours; the
  agent reaches yours only with `ownerComputer: true`, on a card that names the
  guest and is asked every time. `host: "guest"` asks for a guest's computer
  whoever wrote last.
- **Commands on a Live Share guest's computer**: the guest sees a card with the whole
  command, who asks, the project and the reason, starting on **Deny**; nothing runs
  without that click, each time, with no rule, Yolo or "always" that could skip it.
  So that what the card shows is what runs, a command holds only plain ASCII and common
  accented letters: no curly quotes, no-break spaces, invisible marks, other alphabets or
  letters that pass for another. The card numbers each line, names anything that is not
  plain ASCII, and **Allow** waits until the end of a long command has been on screen. It
  runs in a fresh Windows PowerShell, for 60 s by default and 5 minutes at most, and
  what it prints goes back to the agent. A panel on the guest's screen shows the
  command, its output and **Stop**. **Do not ask again in this session** ends the
  questions, and **Settings > Agents** turns them off. Only guests with the right to
  type can be asked, the person sharing is told each time, and both sides need this
  version.
- **Tessel's own connectors (`tessel_apps`)**: Gmail, Google Calendar and Google Drive for
  every agent on your computer, and for Claude Code, Codex and Antigravity on your SSH hosts, connected in
  **Settings > Connections**. The same panel lists Outlook mail, Outlook Calendar, OneDrive,
  GitHub, Dropbox, Notion, Linear, Jira, Confluence, Sentry, Vercel and Stripe; the server tells
  it which can be connected, and one whose app is not registered yet says **Not available yet**
  and has no Connect button. You sign in through tesselcode.com on
  the service's own page, after a page that names the Tessel account asking, so it takes a Tessel
  account and nothing to set up. An account can be an address, a login or a workspace. The refresh
  token stays encrypted on your computer and access
  tokens only in memory; Tessel does not give them to agents (a program running as you could
  still read them). Calls go from your computer straight to the service. Each agent asks, naming the
  account, before it first reads a service and before it first changes something there, again
  after a restart of its pane; while the project is shared in Live Share, it asks each time.
  Deleting or changing an event, inviting someone, writing to a calendar other than your main
  one, creating an issue, a comment or a Notion page, and every request from an agent on an SSH
  host are asked each time, with what will happen. Mail can be read and drafted, never sent.
  Outlook mails an event's guests by itself, so agents make no Outlook event with guests and leave
  one that has guests, or a whole repeating series, alone. Dropbox, Sentry, Vercel and Stripe are
  read only, and no tool is there to send mail, deploy, move money or delete a repository. Creating
  an issue or a comment on GitHub, Linear or Jira does notify the people watching, by email too, and
  automation may run: its card says so, shows the whole text with every mention, link and image found
  in it, and what does not fit on the card (4000 characters) is refused. When what a card shows does
  not fit on screen, Allow waits until all of it has been on screen. What an agent reads from a
  service, a service's refusal included, is marked as someone else's words, and its size is limited.
  Stripe's payment secrets and sign-in-free invoice links never reach an agent. Disconnecting deletes the tokens and asks the
  service to end its access; Microsoft, Atlassian, Sentry and Stripe give apps no way to do that,
  so Tessel says where to end it yourself. Signing out of your Tessel account ends the
  connections, and so does someone else signing in: connections stay with the account that made
  them. Two accounts of a service with the same address stay two connections. What you connect here
  replaces the same service in Claude Code's connectors, and in Codex's where Tessel knows its id,
  in Tessel's panes here and on hosts, so agents use Tessel's. Codex keeps its own connector for
  Dropbox, Notion, Linear, Sentry and Stripe. All their other tools stay. Agents already running get the tools after
  a restart. Connecting Google also removes the older `google-workspace` server from the agents that
  have Tessel's tools, once: one you add back from the MCP dialog stays until you connect Google again.
- **A code sent by email, typed and submitted for you**: when you asked an agent to sign in to a
  site in the built-in browser and it asks for a code it sent by email, the agent asks and you
  allow it on a card, every time. The card names the page with its path, the field, the button,
  the sender, the subject, how long ago the mail came and the account, and shows the mail's own
  words around the code with the numbers hidden. It warns when the sender is not that site, when
  the page is not on the host that site signs people in on, when it is on another port, when the
  mail is addressed to someone else or answers go to another domain, and when the mail or the page
  speaks of a payment, an order, a new device, closing something, turning off a protection, a
  change of password or email, or access for something else. No warning does not mean it is a
  sign-in: read what the mail says. Tessel reads the code from the Gmail you connected, types it,
  submits the form and empties the field, all in one step with every browser tool waiting for at
  most 30 seconds, and its answer to the agent says only whether the form was sent and whether the
  field was emptied. Tessel does not hand it the code, but the agent controls the browser, so if
  the site shows the code on a page or writes it to the page's console, the agent can read it. If
  Tessel cannot confirm the field is empty, it says so and keeps that page out of snapshots and
  screenshots until it navigates away, closes or the field is empty, for at most 10 minutes. It
  never types over a browser command still running on that page. Tessel refuses a field that is not made for a
  code, and everything while the project is shared in Live Share. After you deny, that site and
  that mail get no new card for 15 minutes, and after two denies in 15 minutes nothing does.
- **Updating a development copy**: a Tessel started with `npm run dev` checks GitHub
  every 30 minutes (`git fetch` of the branch it follows) and, when there are newer
  builds, shows a yellow `↑ b1700` next to the version. It lists them and, for a copy with
  no change of its own, brings them in with a fast-forward; with changes of your own
  it touches nothing and gives you the command. It says whether to restart
  (main process changed). `npm run dev` installs the packages the code needs by itself
  when they are missing or out of date, without changing `package-lock.json`. An installed Tessel
  keeps its own updater: it downloads each release and asks you to restart.
- **Agents updated while a pane runs them**: when Tessel (or you) updates an agent's
  program, panes still running the old one restart by themselves with their conversation
  when idle, and each of them shows a note with a **Restart** button until then (an old
  program next to new files can fail in odd ways).
- **Allow every account shown to agents at once** (the switch in the saved passwords
  list's header): follows the search, asks first with the number of accounts, and
  turning it off needs no question. Agent access stays off for every account until you
  allow it.
- **Export and import of your settings** (Settings → General → Backup): one file
  with your settings, projects and their layout, SSH hosts, the task board, Live
  Share's settings and the activity history; you choose the parts. Sign-ins (Claude,
  Codex…), saved passwords, cookies, keys and agents' environment variables are never
  in it: you sign in again. What decides what agents may do (agent commands and rules,
  Yolo, including a pane's own, the browser and account tools, workers, SSH proxy
  commands and host keys, trusted guests and folders) is a separate part, restored only
  if you tick it: otherwise those settings stay as they are on this computer. An import is checked, then put in place when Tessel starts again
  (the replaced files are kept in `import-backups`), so it can bring back a deleted
  data folder or move your setup to another computer. Nothing starts by itself at that
  start: its agents and terminals wait until you click Wake it, and an agent's first start
  asks before acting.
- **A development Tessel no longer restarts by itself** when the code of its background
  part changes (`src/main`, `src/preload`, `launch.mjs`): that cut sessions every time an
  agent merged into the folder. The window still reloads by itself for the
  interface. When the background code changed since Tessel started, a yellow
  **↻ restart** button next to the version lists the files and says to restart when
  it suits you; your terminals and agents keep running. `TESSEL_WATCH=1 npm run dev`
  brings the automatic restart back. **Restart now**, in that window (and after an
  update), starts the new Tessel in the background and closes this one without
  stopping the terminal host: terminals, SSH sessions and agents keep running and the
  new window reattaches to them; editor files are asked about first.
- **Messages between projects**: an agent can write to an agent of any other
  project, on this computer or on any SSH host (`project_agents`, `project_send`,
  `project_inbox`); Tessel relays the message, with no terminal or SSH session to
  open, and tells the other agent when it is free. The first message between two
  agents asks you, a message gives the reader no permission, and there is an
  hourly limit per pair (Settings → Agents). In a project shared in Live Share,
  every message asks you. Agents get these tools after a restart.
- **Sign-in from a terminal**: when an agent prints a sign-in page (Claude, Codex,
  Grok, Gemini, Antigravity…), a banner offers **Open in Tessel**, **Open in my
  browser** and **Copy the link**, with the whole address even if the program cut
  it over several rows.

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
- **Message alerts**: when an agent has unread messages and is idle, Tessel types
  a short line in its box and presses Enter. On Codex, Enter waits until the line
  shows there. If the line stays unsent, Tessel presses Enter again, even with you
  in the pane or after a restart, as long as the box holds nothing else: what you
  type is never sent for you.
- **Two sets of tools**: agents see Tessel's tools as `tessel_team` (the team, the board and
  messages between agents) and `tessel_apps` (the browser, terminals, accounts, logs and the
  connectors you connected). Your agents' settings move to these names by themselves; a running
  agent gets them when it restarts.
- **Conversations**: a tab in the side panel, after Agents, shows what the
  agents of a team say to each other and to you, with who sent each message
  and the model it ran on.

### Live Share

Others join your Tessel from their own Tessel and see a project of yours live,
like VS Code Live Share:

- **Share** (people icon in the toolbar): pick the project to share and send
  the invite code. Each guest waits until you click **Allow**; both of you see
  the same six-digit code, so you can check who it is.
- Guests see that project's panes, splits and sizes, and its terminals and
  agents live, but not their history. Switching to another project does not
  show it to them.
- Guests **only watch** until you let them, one by one: **Type** in your
  terminals and agents (they can then run any command on your PC as you),
  **Open** terminals and agents (they run on your computer), **Close** panes
  (an agent or a busy terminal still asks you first). Remove anyone or **Stop
  sharing** at any time.
- Guests **Join** from the same window by pasting the code. A code works for
  an hour; **New code** makes another.
- It goes through a free Cloudflare tunnel (no account; Tessel downloads
  `cloudflared` the first time you share, checked against its published
  SHA-256), and everything is end-to-end encrypted, so the tunnel only
  carries ciphertext.
- With the **Usage** right, a guest also sees your plans, how much of each is
  used and when they reset; never your accounts or email addresses.

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
- **Try it in your browser**: [tesselcode.com](https://tesselcode.com) runs Tessel's
  real interface in the page, built from this code and rebuilt with every change,
  with scripted agents in place of real ones. Click anything: nothing runs, and
  nothing leaves the page.

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

**Version and build**: the header shows the release version followed by a build
number, like `1.17.2.1692`. The version only changes with a release; the build
(the repository's number of commits, the commit on hover) goes up with every push
to GitHub, so you can tell which code is running.

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

The website is in `site/` and its demo in `web-demo/`, on an address of its own
(`demo.tesselcode.com`): `npm run build:site` builds the demo into `site/demo/public/`
and checks it (no local path, user name, token or oversized file). A push to `main` that touches them or the interface puts the site
online (`.github/workflows/site.yml`).

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
