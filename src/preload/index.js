import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'

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
  claudeSessionExists: (id, scope) => ipcRenderer.invoke('sessions:claudeExists', id, scope),
  findCodexSession: (query) => ipcRenderer.invoke('sessions:findCodex', query),
  findAgentSession: (query) => ipcRenderer.invoke('sessions:find', query),
  sessionTitle: (query) => ipcRenderer.invoke('sessions:title', query),
  agentChildren: (query) => ipcRenderer.invoke('agents:children', query),
  geminiSessionExists: (id) => ipcRenderer.invoke('sessions:geminiExists', id),
  qwenSessionExists: (id) => ipcRenderer.invoke('sessions:qwenExists', id),
  reportedSessions: () => ipcRenderer.invoke('sessions:reported'),
  prepareAgentStatus: (provider) => ipcRenderer.invoke('agents:prepareStatus', provider),
  agentStates: () => ipcRenderer.invoke('agents:states'),
  reportAgentScreen: (observation) => ipcRenderer.send('agents:screen', observation),
  onAgentState: (cb) => {
    const handler = (_e, states) => cb(states)
    ipcRenderer.on('agents:state', handler)
    return () => ipcRenderer.removeListener('agents:state', handler)
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
  explorer: {
    list: (q) => ipcRenderer.invoke('explorer:list', q),
    status: (q) => ipcRenderer.invoke('explorer:status', q),
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
  onAgentModelChanged: (cb) => {
    const handler = (_e, agentId) => cb(agentId)
    ipcRenderer.on('agents:modelChanged', handler)
    return () => ipcRenderer.removeListener('agents:modelChanged', handler)
  },
  listSessions: (query) => ipcRenderer.invoke('sessions:list', query),
  voiceTyping: (opts) => ipcRenderer.invoke('app:voiceTyping', opts),
  inputLanguages: () => ipcRenderer.invoke('app:inputLanguages'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  keepAwake: (on) => ipcRenderer.invoke('power:keepAwake', on === true),
  gitInfo: (cwd) => ipcRenderer.invoke('git:info', cwd),
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
    redeemReset: (query) => ipcRenderer.invoke('providerUsage:redeemReset', query)
  },
  github: {
    status: (q) => ipcRenderer.invoke('github:status', q),
    list: (q) => ipcRenderer.invoke('github:list', q),
    detail: (q) => ipcRenderer.invoke('github:detail', q),
    createIssue: (q) => ipcRenderer.invoke('github:createIssue', q),
    createPr: (q) => ipcRenderer.invoke('github:createPr', q),
    checks: (q) => ipcRenderer.invoke('github:checks', q),
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
  writeClipboardImage: (bytes) => ipcRenderer.invoke('statsUsage:copyImage', bytes),
  // Codex's usage report (tokens and requests), from its own session files.
  codexUsageReport: (query = {}) => ipcRenderer.invoke('usage:codexReport', query),
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
    roster: (args) => ipcRenderer.invoke('team:roster', args),
    requests: (args) => ipcRenderer.invoke('team:requests', args),
    requestsDone: (args) => ipcRenderer.invoke('team:requests-done', args),
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

  // Subscriptions return an unsubscribe function.
  onData: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('pty:data', handler)
    return () => ipcRenderer.removeListener('pty:data', handler)
  },
  onExit: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('pty:exit', handler)
    return () => ipcRenderer.removeListener('pty:exit', handler)
  },
  onFocusPane: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('app:focusPane', handler)
    return () => ipcRenderer.removeListener('app:focusPane', handler)
  }
}

contextBridge.exposeInMainWorld('shellApi', api)
