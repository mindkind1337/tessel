import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Bridge a minimal, typed-ish API to the renderer. No node access leaks.
const api = {
  // True in the dev build (not the installed app); the toolbar shows it.
  isDev: process.argv.includes('--tessel-dev'),
  listShells: () => ipcRenderer.invoke('shells:list'),
  listAgents: (custom) => ipcRenderer.invoke('agents:list', custom),
  refreshAgents: (custom) => ipcRenderer.invoke('agents:refresh', custom),
  checkTools: (bins) => ipcRenderer.invoke('tools:check', bins),
  toolStatus: () => ipcRenderer.invoke('tools:status'),
  refreshPath: () => ipcRenderer.invoke('tools:refreshPath'),
  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),
  attachPty: (id) => ipcRenderer.invoke('pty:attach', id),
  reconcilePtys: (ids) => ipcRenderer.invoke('pty:reconcile', ids),
  loadScrollback: () => ipcRenderer.invoke('scrollback:load'),
  writePty: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killPty: (id) => ipcRenderer.send('pty:kill', { id }),

  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts),
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
  claudeSessionExists: (id) => ipcRenderer.invoke('sessions:claudeExists', id),
  findCodexSession: (query) => ipcRenderer.invoke('sessions:findCodex', query),
  listSessions: (query) => ipcRenderer.invoke('sessions:list', query),
  voiceTyping: (opts) => ipcRenderer.invoke('app:voiceTyping', opts),
  inputLanguages: () => ipcRenderer.invoke('app:inputLanguages'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  gitInfo: (cwd) => ipcRenderer.invoke('git:info', cwd),
  createWorktree: (cwd, label) => ipcRenderer.invoke('git:createWorktree', { cwd, label }),
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
  // Background team information (never typed into terminals).
  team: {
    notice: (args) => ipcRenderer.invoke('team:notice', args),
    current: (args) => ipcRenderer.invoke('team:current', args),
    retire: (args) => ipcRenderer.invoke('team:retire', args)
  },
  review: {
    info: (args) => ipcRenderer.invoke('review:info', args),
    diff: (args) => ipcRenderer.invoke('review:diff', args),
    merge: (args) => ipcRenderer.invoke('review:merge', args),
    remove: (args) => ipcRenderer.invoke('review:remove', args)
  },
  mcpList: (cwd) => ipcRenderer.invoke('mcp:list', cwd),
  mcpAdd: (spec) => ipcRenderer.invoke('mcp:add', spec),
  mcpRemove: (spec) => ipcRenderer.invoke('mcp:remove', spec),
  mcpTest: (ref) => ipcRenderer.invoke('mcp:test', ref),
  mcpCopy: (spec) => ipcRenderer.invoke('mcp:copy', spec),
  notify: (payload) => ipcRenderer.send('app:notify', payload),
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
    load: () => ipcRenderer.invoke('taskboard:load'),
    save: (tasks) => ipcRenderer.invoke('taskboard:save', tasks)
  },

  // Updates (see src/main/updater.js).
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
