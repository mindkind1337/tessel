import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'

// An event from the main process: cb(payload); -> unsubscribe.
function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

// Channels every pane listens to (its output, its exit, its model): one IPC
// listener each, shared, instead of one per pane (Node warns past 10).
const shared = {}
function onShared(channel, cb) {
  let subs = shared[channel]
  if (!subs) {
    subs = shared[channel] = new Set()
    ipcRenderer.on(channel, (_e, payload) => {
      for (const fn of [...subs]) fn(payload)
    })
  }
  subs.add(cb)
  return () => subs.delete(cb)
}

// Bridge a minimal, typed-ish API to the renderer. No node access leaks.
const api = {
  // True in the dev build (not the installed app); the toolbar shows it.
  isDev: process.argv.includes('--tessel-dev'),
  listShells: () => ipcRenderer.invoke('shells:list'),
  listAgents: (custom) => ipcRenderer.invoke('agents:list', custom),
  refreshAgents: (custom) => ipcRenderer.invoke('agents:refresh', custom),
  checkTools: (bins) => ipcRenderer.invoke('tools:check', bins),
  toolStatus: () => ipcRenderer.invoke('tools:status'),
  // What Tessel needs and whether it is here: { ok, rows: [...] }.
  tesselNeeds: () => ipcRenderer.invoke('tools:needs'),
  refreshPath: () => ipcRenderer.invoke('tools:refreshPath'),
  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),
  attachPty: (id) => ipcRenderer.invoke('pty:attach', id),
  reconcilePtys: (ids) => ipcRenderer.invoke('pty:reconcile', ids),
  loadScrollback: () => ipcRenderer.invoke('scrollback:load'),
  writePty: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killPty: (id) => ipcRenderer.send('pty:kill', { id }),
  // Reset Terminal: clear leftover input modes in the host's copy of the screen.
  resetPtyModes: (id) => ipcRenderer.send('pty:resetModes', { id }),
  // Is a program running in this terminal (under its shell)? -> { running,
  // names } or { unknown: true } (Settings > General, closing a pane).
  ptyRunningWork: (id) => ipcRenderer.invoke('pty:runningWork', id),
  // Settings > Appearance, UI Zoom: Chromium's zoom level (0 = 100 %).
  setUiZoomLevel: (level) => {
    try {
      webFrame.setZoomLevel(Number(level) || 0)
    } catch {
      /* not in a window */
    }
  },
  // Stop terminals and wait until their processes really ended.
  stopPtysAndWait: (ids, timeoutMs) => ipcRenderer.invoke('pty:stopAndWait', { ids, timeoutMs }),

  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),
  // Add a project (src/main/addProject.js): a URL, a name, paths; never argv.
  addProject: {
    defaults: () => ipcRenderer.invoke('addProject:defaults'),
    clone: (url, destination) => ipcRenderer.invoke('addProject:clone', { url, destination }),
    cloneAbort: () => ipcRenderer.invoke('addProject:cloneAbort'),
    onCloneProgress: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('addProject:cloneProgress', handler)
      return () => ipcRenderer.removeListener('addProject:cloneProgress', handler)
    },
    create: (parentPath, name) => ipcRenderer.invoke('addProject:create', { parentPath, name }),
    scan: (path, scanId) => ipcRenderer.invoke('addProject:scan', { path, scanId }),
    scanStop: (scanId) => ipcRenderer.invoke('addProject:scanStop', { scanId }),
    onScanProgress: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('addProject:scanProgress', handler)
      return () => ipcRenderer.removeListener('addProject:scanProgress', handler)
    }
  },
  projectNotes: (opts) => ipcRenderer.invoke('notes:ensure', opts),
  openProjectNotes: (opts) => ipcRenderer.invoke('notes:open', opts),
  readProjectNotes: (dir) => ipcRenderer.invoke('notes:read', dir),
  loadNotes: (opts) => ipcRenderer.invoke('notes:load', opts),
  saveNotes: (opts) => ipcRenderer.invoke('notes:save', opts),
  activity: {
    load: () => ipcRenderer.invoke('activity:load'),
    save: (events) => ipcRenderer.invoke('activity:save', events)
  },
  homeDir: () => ipcRenderer.invoke('app:homeDir'),
  systemLocale: () => ipcRenderer.invoke('app:systemLocale'),
  log: (level, message) => ipcRenderer.send('log:write', { level, message }),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  // Updates only the native Windows controls overlay; the renderer chooses
  // from validated named palettes instead of passing arbitrary CSS colors.
  setWindowTheme: (theme) => ipcRenderer.send('window:theme', theme),
  diagnostics: () => ipcRenderer.invoke('logs:diagnostics'),
  claudeHoldDefaultModel: () => ipcRenderer.invoke('claude:holdDefaultModel'),
  claudeSessionExists: (id, scope) => ipcRenderer.invoke('sessions:claudeExists', id, scope),
  findCodexSession: (query) => ipcRenderer.invoke('sessions:findCodex', query),
  findAgentSession: (query) => ipcRenderer.invoke('sessions:find', query),
  sessionTitle: (query) => ipcRenderer.invoke('sessions:title', query),
  agentChildren: (query) => ipcRenderer.invoke('agents:children', query),
  geminiSessionExists: (id) => ipcRenderer.invoke('sessions:geminiExists', id),
  qwenSessionExists: (id) => ipcRenderer.invoke('sessions:qwenExists', id),
  agentResumeTarget: (query) => ipcRenderer.invoke('sessions:resumeTarget', query),
  reportedSessions: () => ipcRenderer.invoke('sessions:reported'),
  prepareAgentStatus: (provider, optIn) => ipcRenderer.invoke('agents:prepareStatus', provider, optIn),
  agentStates: () => ipcRenderer.invoke('agents:states'),
  reportAgentScreen: (observation) => ipcRenderer.send('agents:screen', observation),
  onAgentState: (cb) => {
    const handler = (_e, states) => cb(states)
    ipcRenderer.on('agents:state', handler)
    return () => ipcRenderer.removeListener('agents:state', handler)
  },
  // Agent-state detection rules: { state: 'builtin' | 'override' | 'invalid',
  // reason, file, size, override }. open: creates the file when missing.
  agentRules: {
    get: () => ipcRenderer.invoke('agentRules:get'),
    open: () => ipcRenderer.invoke('agentRules:open'),
    onChanged: (cb) => subscribe('agentRules:changed', cb)
  },
  installLogStart: (q) => ipcRenderer.invoke('install:logStart', q),
  // Agent CLI updates: { checkedAt, agents: { id: { installed, latest, update, steps } } }.
  agentUpdates: {
    status: () => ipcRenderer.invoke('agentUpdates:status'),
    check: (q) => ipcRenderer.invoke('agentUpdates:check', q),
    onChanged: (cb) => {
      const handler = (_e, r) => cb(r)
      ipcRenderer.on('agentUpdates:changed', handler)
      return () => ipcRenderer.removeListener('agentUpdates:changed', handler)
    },
    // Update one agent in the background (no pane): resolves when it ended.
    run: (q) => ipcRenderer.invoke('agentUpdates:run', q),
    // { entries: [...newest first], last: { agentId: entry } }
    history: () => ipcRenderer.invoke('agentUpdates:history'),
    onHistory: (cb) => {
      const handler = (_e, r) => cb(r)
      ipcRenderer.on('agentUpdates:history', handler)
      return () => ipcRenderer.removeListener('agentUpdates:history', handler)
    },
    onProgress: (cb) => {
      const handler = (_e, r) => cb(r)
      ipcRenderer.on('agentUpdates:progress', handler)
      return () => ipcRenderer.removeListener('agentUpdates:progress', handler)
    }
  },
  getPastedImage: (q) => ipcRenderer.invoke('images:get', q),
  // File references in a terminal: { cwd, paths } -> { path: absolute | null };
  // { file, line, col } opens it (VS Code at the line, else its default app).
  resolveFiles: (q) => ipcRenderer.invoke('files:resolve', q),
  openFile: (q) => ipcRenderer.invoke('files:open', q),
  viewFile: (file) => ipcRenderer.invoke('files:view', file),
  // Paths named in the native chat: [paths] -> { path: 'file' | 'dir' | null }
  // (at most 64); open(path) a folder or a media / document file with the
  // system (the main process re-checks it).
  chatFiles: {
    stat: (paths) => ipcRenderer.invoke('chatFiles:stat', { paths }),
    open: (path) => ipcRenderer.invoke('chatFiles:open', { path }),
    reveal: (path) => ipcRenderer.invoke('chatFiles:reveal', { path })
  },
  explorer: {
    list: (q) => ipcRenderer.invoke('explorer:list', q),
    status: (q) => ipcRenderer.invoke('explorer:status', q),
    sparse: (q) => ipcRenderer.invoke('explorer:sparse', q),
    searchNames: (q) => ipcRenderer.invoke('explorer:searchNames', q),
    searchContent: (q) => ipcRenderer.invoke('explorer:searchContent', q),
    create: (q) => ipcRenderer.invoke('explorer:create', q),
    rename: (q) => ipcRenderer.invoke('explorer:rename', q),
    trash: (q) => ipcRenderer.invoke('explorer:trash', q),
    reveal: (q) => ipcRenderer.invoke('explorer:reveal', q),
    watch: (root) => ipcRenderer.invoke('explorer:watch', root),
    unwatch: () => ipcRenderer.invoke('explorer:unwatch'),
    onChanged: (fn) => {
      const h = (_e, root) => fn(root)
      ipcRenderer.on('explorer:changed', h)
      return () => ipcRenderer.removeListener('explorer:changed', h)
    }
  },
  // Tessel's code editor (src/main/editorFiles.js).
  editor: {
    read: (file) => ipcRenderer.invoke('editor:read', file),
    stat: (file) => ipcRenderer.invoke('editor:stat', file),
    write: (q) => ipcRenderer.invoke('editor:write', q),
    head: (file) => ipcRenderer.invoke('editor:head', file),
    watch: (paths) => ipcRenderer.invoke('editor:watch', paths),
    onChanged: (fn) => {
      const h = (_e, change) => fn(change)
      ipcRenderer.on('editor:changed', h)
      return () => ipcRenderer.removeListener('editor:changed', h)
    },
    // How many open files have unsaved changes (the window asks before closing).
    setDirtyCount: (n) => ipcRenderer.send('editor:dirty', n),
    onConfirmClose: (fn) => {
      const h = () => fn()
      ipcRenderer.on('editor:confirmClose', h)
      return () => ipcRenderer.removeListener('editor:confirmClose', h)
    },
    // The page got the close question (main then waits for its answer).
    ackClose: () => ipcRenderer.send('editor:closeAck'),
    closeWindow: () => ipcRenderer.send('editor:closeWindow')
  },
  viewImage: (file) => ipcRenderer.invoke('files:viewImage', file),
  openPdf: (file) => ipcRenderer.invoke('files:openPdf', file),
  // A project's files for Jump to file: root -> { ok, files, truncated }.
  listFiles: (root) => ipcRenderer.invoke('files:list', root),
  openImageExternally: (file) => ipcRenderer.invoke('images:openExternal', file),
  openInstallLog: (file) => ipcRenderer.invoke('install:openLog', file),
  showInstallLog: (file) => ipcRenderer.invoke('install:showLog', file),
  onInstallResult: (cb) => {
    const handler = (_e, r) => cb(r)
    ipcRenderer.on('install:result', handler)
    return () => ipcRenderer.removeListener('install:result', handler)
  },
  agentModel: (query) => ipcRenderer.invoke('agents:model', query),
  // The models each agent's CLI listed (kept), and asking it again:
  // { agent, command } -> { ok, models, fetchedAt } | { ok: false, reason, detail }
  agentModelLists: () => ipcRenderer.invoke('agents:modelLists'),
  probeAgentModels: (query) => ipcRenderer.invoke('agents:probeModels', query),
  // { paneId, sessionId, text } -> { ok } | { ok: false, error }
  agentInbox: (query) => ipcRenderer.invoke('agents:inbox', query),
  onAgentModelChanged: (cb) => onShared('agents:modelChanged', cb),
  listSessions: (query) => ipcRenderer.invoke('sessions:list', query),
  // One past conversation (Agent Session History): its first prompt, latest
  // turns and transcript file; that file shown in the file manager; the
  // conversation deleted (Recycle Bin). { agent, id, accountId }
  sessionDetails: (query) => ipcRenderer.invoke('sessions:details', query),
  revealSessionLog: (query) => ipcRenderer.invoke('sessions:revealLog', query),
  deleteSession: (query) => ipcRenderer.invoke('sessions:delete', query),
  prepareAgyContinue: (query) => ipcRenderer.invoke('sessions:agyContinue', query),
  voiceTyping: (opts) => ipcRenderer.invoke('app:voiceTyping', opts),
  inputLanguages: () => ipcRenderer.invoke('app:inputLanguages'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  keepAwake: (on) => ipcRenderer.invoke('power:keepAwake', on === true),
  gitInfo: (cwd) => ipcRenderer.invoke('git:info', cwd),
  // The worktrees of an open project's repository (read-only).
  gitWorktrees: (cwd) => ipcRenderer.invoke('git:worktrees', cwd),
  // A remote project's .tessel data folder on this computer (remote agents).
  remoteProjectDataDir: (hostId, remotePath) => ipcRenderer.invoke('remote:projectDataDir', hostId, remotePath),
  // Their git evidence, for Clean up worktrees.
  worktreeCleanupScan: (cwd) => ipcRenderer.invoke('git:worktreeCleanupScan', cwd),
  createWorktree: (cwd, label, options) =>
    ipcRenderer.invoke('git:createWorktree', { cwd, label, options }),
  // Last locally observed subscription quotas, with timestamps and stale flags.
  getUsage: () => ipcRenderer.invoke('usage:get'),
  // Authenticated quota reads happen only on an explicit menu action.
  providerUsage: {
    capabilities: () => ipcRenderer.invoke('providerUsage:capabilities'),
    resetHistory: (query) => ipcRenderer.invoke('providerUsage:resetHistory', query),
    creditHistory: (query) => ipcRenderer.invoke('providerUsage:creditHistory', query),
    read: (query) => ipcRenderer.invoke('providerUsage:read', query),
    redeemReset: (query) => ipcRenderer.invoke('providerUsage:redeemReset', query),
    // { hidden, intervalMs } (0 = off); readings then arrive on onUpdate.
    autoRefresh: (query) => ipcRenderer.invoke('providerUsage:autoRefresh', query),
    onUpdate: (cb) => subscribe('providerUsage:update', cb)
  },
  // Settings > AI provider accounts: Cursor and Grok sign-ins, and the saved
  // usage credentials of Gemini, OpenCode Go and MiniMax. Values go in; only
  // "saved" flags come back.
  providerSettings: {
    status: () => ipcRenderer.invoke('providerSettings:status'),
    saveSecret: (name, value) => ipcRenderer.invoke('providerSettings:saveSecret', { name, value }),
    clearSecret: (name) => ipcRenderer.invoke('providerSettings:clearSecret', { name }),
    update: (patch) => ipcRenderer.invoke('providerSettings:update', { patch })
  },
  github: {
    status: (q) => ipcRenderer.invoke('github:status', q),
    list: (q) => ipcRenderer.invoke('github:list', q),
    detail: (q) => ipcRenderer.invoke('github:detail', q),
    createIssue: (q) => ipcRenderer.invoke('github:createIssue', q),
    createPr: (q) => ipcRenderer.invoke('github:createPr', q),
    checks: (q) => ipcRenderer.invoke('github:checks', q),
    failingLogs: (q) => ipcRenderer.invoke('github:failingLogs', q),
    reviewThreads: (q) => ipcRenderer.invoke('github:reviewThreads', q),
    action: (q) => ipcRenderer.invoke('github:action', q),
    startPoint: (q) => ipcRenderer.invoke('github:startPoint', q)
  },
  linear: {
    status: () => ipcRenderer.invoke('linear:status'),
    connect: (q) => ipcRenderer.invoke('linear:connect', q),
    disconnect: () => ipcRenderer.invoke('linear:disconnect'),
    issues: (q) => ipcRenderer.invoke('linear:issues', q),
    teams: (q) => ipcRenderer.invoke('linear:teams', q),
    states: (q) => ipcRenderer.invoke('linear:states', q),
    setState: (q) => ipcRenderer.invoke('linear:setState', q)
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    select: (provider, id) => ipcRenderer.invoke('accounts:select', { provider, id }),
    remove: (provider, id) => ipcRenderer.invoke('accounts:remove', { provider, id }),
    startLogin: (provider, id = null) => ipcRenderer.invoke('accounts:startLogin', { provider, id }),
    loginStatus: (id) => ipcRenderer.invoke('accounts:loginStatus', id),
    cancelLogin: (id) => ipcRenderer.invoke('accounts:cancelLogin', id),
    launchEnv: (provider, accountId) => ipcRenderer.invoke('accounts:launchEnv', { provider, accountId })
  },
  // Claude Code's usage report (tokens and estimated cost by day, model,
  // project, conversation), from its own files on this computer.
  claudeUsageReport: (query = {}) => ipcRenderer.invoke('usage:claudeReport', query),
  statsUsage: { summary: () => ipcRenderer.invoke('statsUsage:summary') },
  // Tokens, time and estimated cost per task card / per pane's current session
  // (src/main/jobCost.js): forCards(ids) / forPanes(ids) -> { [id]: { status,
  // inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, durationMs,
  // usd, known, model, provider, estimated: true, ... } }; onChanged(cb) ->
  // unsubscribe (debounced, when their files change).
  jobCost: {
    forCards: (cardIds) => ipcRenderer.invoke('jobCost:forCards', cardIds),
    forPanes: (paneIds) => ipcRenderer.invoke('jobCost:forPanes', paneIds),
    onChanged: (cb) => subscribe('jobCost:changed', cb)
  },
  writeClipboardImage: (bytes) => ipcRenderer.invoke('statsUsage:copyImage', bytes),
  // Codex's usage report (tokens and requests), from its own session files.
  codexUsageReport: (query = {}) => ipcRenderer.invoke('usage:codexReport', query),
  // OpenCode's usage report (tokens and recorded cost), from its own databases.
  opencodeUsageReport: (query = {}) => ipcRenderer.invoke('usage:opencodeReport', query),
  // Review and merge a task branch: { root, path, branch, target, ... }.
  // A team lead's inbox folder: { dir, token, guide }.
  lead: {
    ensure: (args) => ipcRenderer.invoke('lead:ensure', args),
    take: (args) => ipcRenderer.invoke('lead:take', args),
    remove: (args) => ipcRenderer.invoke('lead:remove', args)
  },
  // Durable team messages (src/main/teamChannel.js): { dir, teamId, ... }.
  channel: {
    ensure: (args) => ipcRenderer.invoke('channel:ensure', args),
    poll: (args) => ipcRenderer.invoke('channel:poll', args),
    ack: (args) => ipcRenderer.invoke('channel:ack', args),
    hold: (args) => ipcRenderer.invoke('channel:hold', args),
    release: (args) => ipcRenderer.invoke('channel:release', args),
    acks: (args) => ipcRenderer.invoke('channel:acks', args)
  },
  // Set up the team tools (MCP server + Claude hooks) for agent CLIs.
  installTeamTools: () => ipcRenderer.invoke('team:install'),
  // How each agent gets team messages: its hooks, approval, last signal.
  teamHooksStatus: () => ipcRenderer.invoke('team:hooksStatus'),
  teamRemoveHooks: () => ipcRenderer.invoke('team:removeHooks'),
  // Whether the installed Codex can run without its shared daemon.
  codexNoDaemon: () => ipcRenderer.invoke('agents:codex-no-daemon'),
  // { shells: { paneId: shellPid } } -> { ok, agents: { paneId: agentId | null } }
  detectAgents: (args) => ipcRenderer.invoke('agents:detect', args),
  // Live ports: { probes: [{ id, pids, path }] } -> { ok, ports: { [id]: [port] } };
  // kill: { probes, pid, port } -> { ok, reason }.
  scanPorts: (args) => ipcRenderer.invoke('ports:scan', args),
  killPort: (args) => ipcRenderer.invoke('ports:kill', args),
  // Status bar Resource Manager: { ptys: [{ id, pid }] } -> memory / CPU snapshot.
  resourceSnapshot: (args) => ipcRenderer.invoke('resources:snapshot', args),
  // Background team information (never typed into terminals).
  team: {
    notice: (args) => ipcRenderer.invoke('team:notice', args),
    current: (args) => ipcRenderer.invoke('team:current', args),
    retire: (args) => ipcRenderer.invoke('team:retire', args),
    tasks: (args) => ipcRenderer.invoke('team:tasks', args),
    // Cards deleted on the board: out of every published copy in a project.
    forgetTasks: (args) => ipcRenderer.invoke('team:forget-tasks', args),
    roster: (args) => ipcRenderer.invoke('team:roster', args),
    requests: (args) => ipcRenderer.invoke('team:requests', args),
    requestsDone: (args) => ipcRenderer.invoke('team:requests-done', args),
    // A round abandoned before applying them: read again next round.
    requestsRelease: (args) => ipcRenderer.invoke('team:requests-release', args),
    boardPanes: (args) => ipcRenderer.invoke('team:board-panes', args),
    messageStatus: (args) => ipcRenderer.invoke('team:message-status', args),
    toolsAlive: (args) => ipcRenderer.invoke('team:tools-alive', args),
    // Orchestration (src/shared/orchestration.js).
    answer: (args) => ipcRenderer.invoke('team:answer', args),
    workers: (args) => ipcRenderer.invoke('team:workers', args)
  },
  review: {
    info: (args) => ipcRenderer.invoke('review:info', args),
    diff: (args) => ipcRenderer.invoke('review:diff', args),
    merge: (args) => ipcRenderer.invoke('review:merge', args),
    remove: (args) => ipcRenderer.invoke('review:remove', args),
    // Commit what the agent left uncommitted (args + message); push the branch.
    commit: (args) => ipcRenderer.invoke('review:commit', args),
    push: (args) => ipcRenderer.invoke('review:push', args)
  },
  // Source control of any folder in a repository (the Changes tab).
  scm: {
    status: (q) => ipcRenderer.invoke('scm:status', q),
    stage: (q) => ipcRenderer.invoke('scm:stage', q),
    unstage: (q) => ipcRenderer.invoke('scm:unstage', q),
    discard: (q) => ipcRenderer.invoke('scm:discard', q),
    commit: (q) => ipcRenderer.invoke('scm:commit', q),
    push: (q) => ipcRenderer.invoke('scm:push', q),
    pull: (q) => ipcRenderer.invoke('scm:pull', q),
    fetch: (q) => ipcRenderer.invoke('scm:fetch', q),
    sync: (q) => ipcRenderer.invoke('scm:sync', q),
    fileVersions: (q) => ipcRenderer.invoke('scm:fileVersions', q),
    branchCompare: (q) => ipcRenderer.invoke('scm:branchCompare', q),
    history: (q) => ipcRenderer.invoke('scm:history', q),
    commitFiles: (q) => ipcRenderer.invoke('scm:commitFiles', q),
    generate: (q) => ipcRenderer.invoke('scm:generate', q),
    cancelGenerate: (q) => ipcRenderer.invoke('scm:cancelGenerate', q)
  },
  mcpList: (cwd) => ipcRenderer.invoke('mcp:list', cwd),
  mcpAdd: (spec) => ipcRenderer.invoke('mcp:add', spec),
  mcpRemove: (spec) => ipcRenderer.invoke('mcp:remove', spec),
  mcpTest: (ref) => ipcRenderer.invoke('mcp:test', ref),
  mcpCopy: (spec) => ipcRenderer.invoke('mcp:copy', spec),
  notify: (payload) => ipcRenderer.send('app:notify', payload),
  // The language the interface shows ('en', 'fr'): the main process uses it
  // for its dialogs, notifications and messages (src/main/i18n.js).
  setUiLanguage: (locale) => ipcRenderer.send('app:setUiLanguage', String(locale || '')),
  // Real filesystem path of a dropped File (File.path was removed in Electron 32).
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },

  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  clipboardHasImage: () => ipcRenderer.invoke('clipboard:hasImage'),
  saveClipboardImage: () => ipcRenderer.invoke('clipboard:saveImage'),
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),

  // Workspace layout persistence.
  loadLayout: () => ipcRenderer.invoke('layout:load'),
  saveLayout: (data) => ipcRenderer.send('layout:save', data),

  // Task-board persistence. load() resolves to the saved task array ([] when
  // none); save(tasks) resolves to { ok: true } or { ok: false, error }.
  taskBoard: {
    load: (opts) => ipcRenderer.invoke('taskboard:load', opts),
    save: (tasks) => ipcRenderer.invoke('taskboard:save', tasks)
  },

  // The built-in browser's pages (src/main/browserGuest.js), by the id of
  // their <webview>'s contents: Design Mode (pick an element, a screenshot),
  // devtools, and what a page asked for (a new window, a download, a
  // permission, a browser shortcut pressed in it).
  browser: {
    pick: (id) => ipcRenderer.invoke('browser:pick', id),
    cancelPick: (id) => ipcRenderer.invoke('browser:cancelPick', id),
    screenshot: (id) => ipcRenderer.invoke('browser:screenshot', id),
    openDevTools: (id) => ipcRenderer.invoke('browser:openDevTools', id),
    copyImage: (file) => ipcRenderer.invoke('browser:copyImage', file),
    // Cookies, storage, cache of the browser's pages only. -> { ok }
    clearData: () => ipcRenderer.invoke('browser:clearData'),
    // The Design Mode message as a file for the agent (text, at most 512 KB).
    // -> { ok: true, path } | { ok: false, code: 'invalid' | 'too-big' | 'failed' }
    saveFeedback: (text) => ipcRenderer.invoke('browser:saveFeedback', text),
    onPopup: (cb) => subscribe('browser:popup', cb),
    onShortcut: (cb) => subscribe('browser:shortcut', cb),
    // The mouse's back/forward buttons with no page focused: for the active pane.
    onAppCommand: (cb) => subscribe('browser:appCommand', cb),
    onPermissionDenied: (cb) => subscribe('browser:permissionDenied', cb),
    onDownloadBlocked: (cb) => subscribe('browser:downloadBlocked', cb),
    // Agents driving pages (src/main/agentBrowser.js): the setting, the
    // badge's Stop, and when an agent starts or stops driving a page.
    agentSettings: (opts) => ipcRenderer.invoke('browser:agentSettings', opts),
    agentStop: (id) => ipcRenderer.invoke('browser:agentStop', id),
    onAgentControl: (cb) => subscribe('browser:agentControl', cb)
  },

  // Chat agents (src/main/chat/sessions.js): Claude without a terminal. The
  // window opens, messages, answers approvals and follows each chat's events.
  chat: {
    open: (opts) => ipcRenderer.invoke('chat:open', opts),
    send: (opts) => ipcRenderer.invoke('chat:send', opts),
    // A held message's card: edit, delete, send now.
    queuedEdit: (opts) => ipcRenderer.invoke('chat:queuedEdit', opts),
    queuedDelete: (opts) => ipcRenderer.invoke('chat:queuedDelete', opts),
    queuedSend: (opts) => ipcRenderer.invoke('chat:queuedSend', opts),
    sendTeam: (opts) => ipcRenderer.invoke('chat:sendTeam', opts),
    interrupt: (opts) => ipcRenderer.invoke('chat:interrupt', opts),
    approve: (opts) => ipcRenderer.invoke('chat:approve', opts),
    answer: (opts) => ipcRenderer.invoke('chat:answer', opts),
    approvalInput: (opts) => ipcRenderer.invoke('chat:approvalInput', opts),
    setOption: (opts) => ipcRenderer.invoke('chat:setOption', opts),
    compact: (opts) => ipcRenderer.invoke('chat:compact', opts),
    close: (opts) => ipcRenderer.invoke('chat:close', opts),
    history: (opts) => ipcRenderer.invoke('chat:history', opts),
    historyOlder: (opts) => ipcRenderer.invoke('chat:historyOlder', opts),
    skills: (opts) => ipcRenderer.invoke('chat:skills', opts),
    // Attached images: clipboard bytes, or a dropped/picked file (checked and
    // copied by the main process) -> { ok, image: { id, name, width, height } }.
    imageSave: (opts) => ipcRenderer.invoke('chat:imageSave', opts),
    imageImport: (opts) => ipcRenderer.invoke('chat:imageImport', opts),
    imageDiscard: (opts) => ipcRenderer.invoke('chat:imageDiscard', opts),
    // A terminal agent's chat view: its images' files (Tessel's copies) for
    // the agent's input -> { ok, paths }.
    imagePaths: (opts) => ipcRenderer.invoke('chat:imagePaths', opts),
    onEvent: (cb) => subscribe('chat:event', cb)
  },
  // Search in what was said in the agents' conversations (src/main/sessionSearch).
  sessionSearch: {
    status: () => ipcRenderer.invoke('sessionSearch:status'),
    enable: () => ipcRenderer.invoke('sessionSearch:enable'),
    disable: () => ipcRenderer.invoke('sessionSearch:disable'),
    clear: () => ipcRenderer.invoke('sessionSearch:clear'),
    setHistoryDays: (days) => ipcRenderer.invoke('sessionSearch:setHistoryDays', days),
    search: (query) => ipcRenderer.invoke('sessionSearch:search', query)
  },
  // Read-only conversation views of terminal agents (src/main/chat/transcriptView.js).
  transcriptView: {
    open: (opts) => ipcRenderer.invoke('transcriptView:open', opts),
    close: (opts) => ipcRenderer.invoke('transcriptView:close', opts),
    earlier: (opts) => ipcRenderer.invoke('transcriptView:earlier', opts),
    images: (opts) => ipcRenderer.invoke('transcriptView:images', opts),
    skills: (opts) => ipcRenderer.invoke('transcriptView:skills', opts),
    onEvent: (cb) => subscribe('transcriptView:event', cb)
  },

  // Scheduled automations (src/main/automations.js): the list and run
  // history, changes, and the runs the scheduler asks the window to start
  // (onDispatch), reported back with markResult.
  automations: {
    list: () => ipcRenderer.invoke('automations:list'),
    create: (input) => ipcRenderer.invoke('automations:create', input),
    update: (id, input) => ipcRenderer.invoke('automations:update', id, input),
    setEnabled: (id, enabled, confirmed, sig) => ipcRenderer.invoke('automations:setEnabled', id, enabled, confirmed, sig),
    remove: (id) => ipcRenderer.invoke('automations:remove', id),
    runNow: (id, confirmed, sig) => ipcRenderer.invoke('automations:runNow', id, confirmed, sig),
    // A run's status now (the window asks before it opens the run's pane).
    status: (runId) => ipcRenderer.invoke('automations:status', runId),
    setSettings: (patch) => ipcRenderer.invoke('automations:setSettings', patch),
    markResult: (result) => ipcRenderer.invoke('automations:markResult', result),
    reconcile: (paneIds) => ipcRenderer.invoke('automations:reconcile', paneIds),
    windowReady: () => ipcRenderer.invoke('automations:windowReady'),
    onChanged: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('automations:changed', handler)
      return () => ipcRenderer.removeListener('automations:changed', handler)
    },
    onDispatch: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('automations:dispatch', handler)
      return () => ipcRenderer.removeListener('automations:dispatch', handler)
    }
  },

  // The tessel command (src/main/cliServer.js, cliInstall.js): registering it
  // (Settings > General), and the requests the window answers (onRequest,
  // answered with reply; ready once the workspaces are back).
  cli: {
    installStatus: () => ipcRenderer.invoke('cli:installStatus'),
    install: () => ipcRenderer.invoke('cli:install'),
    uninstall: () => ipcRenderer.invoke('cli:uninstall'),
    reveal: () => ipcRenderer.invoke('cli:reveal'),
    ready: () => ipcRenderer.invoke('cli:ready'),
    reply: (msg) => ipcRenderer.invoke('cli:reply', msg),
    onRequest: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('cli:request', handler)
      return () => ipcRenderer.removeListener('cli:request', handler)
    }
  },

  // Updates (see src/main/updater.js).
  // Remote hosts over SSH (src/main/remoteHosts.js): ids and form fields only.
  remoteHosts: {
    list: () => ipcRenderer.invoke('remoteHosts:list'),
    importConfig: (reAdopt = false) => ipcRenderer.invoke('remoteHosts:importConfig', { reAdopt }),
    add: (target) => ipcRenderer.invoke('remoteHosts:add', { target }),
    update: (id, updates) => ipcRenderer.invoke('remoteHosts:update', { id, updates }),
    remove: (id) => ipcRenderer.invoke('remoteHosts:remove', { id }),
    test: (id) => ipcRenderer.invoke('remoteHosts:test', { id }),
    disconnect: (id) => ipcRenderer.invoke('remoteHosts:disconnect', { id }),
    onState: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('remoteHosts:state', handler)
      return () => ipcRenderer.removeListener('remoteHosts:state', handler)
    }
  },
  // Files, Changes and the editor of remote projects (src/main/remoteFs.js):
  // their files go through the usual explorer / editor / scm calls with
  // ssh://… paths (only below the saved remote projects, which the main
  // process reads from the layout); here cancel, the session's activity
  // (connecting, busy) for the remote badge, and Add a project on a host.
  remoteFs: {
    cancel: (hostId) => ipcRenderer.invoke('remoteFs:cancel', hostId),
    state: () => ipcRenderer.invoke('remoteFs:state'),
    // Add a project on a host: sign in, list a folder (names and kinds),
    // clone or create one new project folder there.
    connect: (hostId) => ipcRenderer.invoke('remoteFs:connect', hostId),
    browse: (hostId, path) => ipcRenderer.invoke('remoteFs:browse', { hostId, path }),
    clone: (hostId, url, parent) => ipcRenderer.invoke('remoteFs:clone', { hostId, url, parent }),
    create: (hostId, parent, name) => ipcRenderer.invoke('remoteFs:create', { hostId, parent, name }),
    onActivity: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('remoteFs:activity', handler)
      return () => ipcRenderer.removeListener('remoteFs:activity', handler)
    }
  },
  // ssh's questions for a remote host pane: password, passphrase, challenge,
  // host key (src/main/sshAskpass.js, through OpenSSH's askpass). The answer
  // goes in this one call, bound to the pane and its one-time request id
  // ('yes' / 'no' for a host key); value null cancels.
  sshCredentials: {
    submit: (paneId, promptId, value) => ipcRenderer.invoke('ssh:submitCredential', { paneId, promptId, value }),
    onRequest: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('ssh:credential-request', handler)
      return () => ipcRenderer.removeListener('ssh:credential-request', handler)
    },
    onResolved: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('ssh:credential-resolved', handler)
      return () => ipcRenderer.removeListener('ssh:credential-resolved', handler)
    }
  },
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    justInstalled: () => ipcRenderer.invoke('update:justInstalled'),
    onStatus: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('update:status', handler)
      return () => ipcRenderer.removeListener('update:status', handler)
    }
  },

  // Is the window on screen (shown, not minimized)? And its changes.
  windowShown: () => ipcRenderer.invoke('window:shown'),
  onWindowShown: (cb) => {
    const handler = (_e, shown) => cb(shown)
    ipcRenderer.on('window:shown', handler)
    return () => ipcRenderer.removeListener('window:shown', handler)
  },

  // Subscriptions return an unsubscribe function.
  onData: (cb) => onShared('pty:data', cb),
  onExit: (cb) => onShared('pty:exit', cb),
  onFocusPane: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('app:focusPane', handler)
    return () => ipcRenderer.removeListener('app:focusPane', handler)
  }
}

contextBridge.exposeInMainWorld('shellApi', api)
