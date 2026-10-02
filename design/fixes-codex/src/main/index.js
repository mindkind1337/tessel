import { app, BrowserWindow, ipcMain, clipboard, dialog, Notification, shell } from 'electron'
import { join, isAbsolute } from 'path'
import os from 'os'
import fs from 'fs'
import { spawn, execFile, execFileSync } from 'child_process'
import { loadTasks, saveTasks } from './taskBoardPersistence'
import { trimEvents, isEvent } from '../shared/activity'
import { claudeSessionExists, findCodexSession, listSessions } from './agentSessions'
import { createLogger, describe } from './logger'
import { cleanEnv } from './cleanEnv'
import { createPtyClient } from './ptyClient'
import { pipeName } from './ptyProtocol'
import { createUpdater } from './updater'
import crypto from 'crypto'
import {
  gitInfo,
  createWorktree,
  listMcp,
  addMcp,
  removeMcp,
  testMcp,
  copyMcp,
  hklFromTip
} from './agentTools'
import { reviewInfo, reviewDiff, reviewMerge, reviewRemove } from './review'
import { takeTeamAcks } from './teamAcks'
import { addNotices, writeCurrentTeams, retireOldTeams } from './teamNotices'
import { writeServerScript, installClaudeHooks, installCodexServer, claudeServerPresent, SERVER_NAME } from './teamInstall'
import teamServerSource from './teamMcp/server.cjs?raw'
import { ensureInbox, takeInbox, removeInbox } from './leadInbox'
import {
  ensureTeamChannel,
  pollTeamChannel,
  ackTeamDelivery,
  holdTeamDelivery,
  releaseTeamDelivery
} from './teamChannel'

// ---------------------------------------------------------------------------
// PTY registry
// ---------------------------------------------------------------------------
/** @type {Map<string, import('node-pty').IPty>} */
// Data folders: the installed app keeps its workspaces, settings and tasks in
// %APPDATA%\tessel, the dev build in %APPDATA%\tessel-dev. Separate, so both
// can be open at once (each allows one copy of itself) without overwriting
// each other's layout or resuming the same agent conversations twice.
// TESSEL_USER_DATA overrides it (used for testing without touching your
// real workspaces).
const DATA_DIR = app.isPackaged ? 'tessel' : 'tessel-dev'
app.setPath('userData', process.env.TESSEL_USER_DATA || join(app.getPath('appData'), DATA_DIR))

// Chromium caches and per-run files are never copied between data folders.
const NOT_COPIED = [
  'update-installed.json',
  'logs',
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'lockfile'
]
function copyUserData(from, to, skip) {
  const copyDir = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const s = join(src, entry.name)
      const d = join(dest, entry.name)
      try {
        if (entry.isDirectory()) copyDir(s, d)
        else if (entry.isFile()) fs.copyFileSync(s, d)
      } catch {
        /* locked or unreadable: skip it */
      }
    }
  }
  try {
    copyDir(from, to)
    return true
  } catch {
    return false /* best-effort: start fresh */
  }
}

// First start with a new data folder: bring the data along.
// - Installed app: the app was called Shell Panels and kept its data in
//   %APPDATA%\shell-panels; copy it (not the old terminal host's token).
// - Dev build: until 1.2.1 it shared %APPDATA%\tessel with the installed app.
//   The dev build takes those workspaces (and the terminal host token, so it
//   re-attaches to the terminals still running), and the installed app's
//   copy loses its workspace list (kept in a backup), so the two don't reopen
//   the same panes and agent conversations.
function migrateUserData() {
  if (process.env.TESSEL_USER_DATA) return
  const to = app.getPath('userData')
  if (fs.existsSync(to)) return
  const appData = app.getPath('appData')
  if (app.isPackaged) {
    const from = join(appData, 'shell-panels')
    if (fs.existsSync(from)) copyUserData(from, to, new Set(['pty-host.token', ...NOT_COPIED]))
    return
  }
  const shared = join(appData, 'tessel')
  if (!fs.existsSync(shared)) return
  if (!copyUserData(shared, to, new Set(NOT_COPIED))) return
  const layout = join(shared, 'workspace-layout.json')
  try {
    const data = JSON.parse(fs.readFileSync(layout, 'utf8'))
    fs.copyFileSync(layout, join(shared, 'workspace-layout.before-dev-split.json'))
    data.workspaces = []
    delete data.tree
    fs.writeFileSync(layout, JSON.stringify(data, null, 2))
  } catch {
    /* no layout there: nothing to split */
  }
}
migrateUserData()

let mainWindow = null

// The dev build uses a yellow copy of the icon (window, taskbar, Start menu
// shortcut), so it can't be mistaken for the installed app.
function appIconPath() {
  const devIco = join(__dirname, '../../build/icon-dev.ico')
  if (!app.isPackaged && fs.existsSync(devIco)) return devIco
  const ico = join(__dirname, '../../build/icon.ico')
  return fs.existsSync(ico) ? ico : join(__dirname, '../../build/icon.png')
}

// Our own taskbar identity. Without it, Windows groups the dev build under
// electron.exe and shows Electron's icon; with it, the taskbar uses ours. The
// installed app uses the installer's id so its Start menu shortcut, taskbar
// button and notifications line up.
const APP_ID = app.isPackaged
  ? 'com.jeanclaudetrottier.tessel'
  : 'com.jeanclaudetrottier.tessel.devyellow'
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

// Logs: %APPDATA%\\tessel\\logs\\tessel.log (rotated, 1 MB x 4).
const log = createLogger({ dir: join(app.getPath('userData'), 'logs') })

// Kept for older call sites: everything it reports is an error.
function logCrashContext(message) {
  log.error('main', message)
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

// Discover shells that actually exist on this machine.
function discoverShells() {
  const candidates = []
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const pf = process.env.ProgramFiles || 'C:\\Program Files'

  const list = [
    {
      id: 'powershell',
      name: 'Windows PowerShell',
      file: join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo']
    },
    {
      id: 'pwsh',
      name: 'PowerShell 7',
      file: join(pf, 'PowerShell', '7', 'pwsh.exe'),
      args: ['-NoLogo']
    },
    { id: 'cmd', name: 'Command Prompt', file: join(sysRoot, 'System32', 'cmd.exe'), args: [] },
    {
      id: 'gitbash',
      name: 'Git Bash',
      file: join(pf, 'Git', 'bin', 'bash.exe'),
      args: ['--login', '-i']
    },
    { id: 'wsl', name: 'WSL', file: join(sysRoot, 'System32', 'wsl.exe'), args: [] }
  ]

  for (const s of list) {
    try {
      if (fs.existsSync(s.file)) candidates.push(s)
    } catch {
      /* ignore */
    }
  }
  // Fallback: always offer cmd even if the probe failed.
  if (!candidates.length) {
    candidates.push({ id: 'cmd', name: 'Command Prompt', file: 'cmd.exe', args: [] })
  }
  return candidates
}

let shellCache = null
function getShells() {
  if (!shellCache) shellCache = discoverShells()
  return shellCache
}

// ---------------------------------------------------------------------------
// AI agent presets
// ---------------------------------------------------------------------------
// An "agent" is a CLI launched inside a normal shell pane (e.g. Claude Code).
// We detect which agent CLIs are actually on PATH so the UI can offer only the
// ones that will run, while still listing the rest as unavailable.
// Known agent CLIs. `install` lists the steps the Install button runs in a new
// pane when the agent isn't found on PATH (joined for the pane's shell).
const AGENT_PRESETS = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    accent: '#d97757',
    install: ['npm install -g @anthropic-ai/claude-code']
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    accent: '#10a37f',
    install: ['npm install -g @openai/codex']
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    accent: '#4285f4',
    install: ['npm install -g @google/gemini-cli']
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    accent: '#e8e8e8',
    install: ['npm install -g opencode-ai']
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    command: 'qwen',
    accent: '#7c5cff',
    install: ['npm install -g @qwen-code/qwen-code']
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    command: 'copilot',
    accent: '#8957e5',
    install: ['npm install -g @github/copilot']
  },
  {
    id: 'amp',
    name: 'Amp',
    command: 'amp',
    accent: '#f34e3f',
    install: ['npm install -g @sourcegraph/amp']
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    accent: '#14b014',
    install: ['python -m pip install aider-install', 'aider-install']
  }
]

// PATH as it is *now* in the registry (machine + user), not as it was when
// Tessel started. Installing an agent, or fixing PATH, then works in new
// panes without restarting the app.
let freshPath = null
function readFreshPath() {
  if (process.platform !== 'win32') return process.env.PATH
  try {
    const script =
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000
      }
    )
    const value = out.toString().trim()
    return value || null
  } catch {
    return null
  }
}

function currentPath() {
  if (freshPath === null) freshPath = readFreshPath() || ''
  return freshPath || process.env.PATH || process.env.Path || ''
}

// process.env with PATH replaced by the fresh value (Windows env keys are
// case-insensitive, so replace whichever spelling is present).
// Environment for terminals and tools: without the variables of whatever
// agent session launched Tessel (see cleanEnv.js), with a fresh PATH.
function freshEnv() {
  const env = cleanEnv(process.env)
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path'
  env[key] = currentPath()
  return env
}

function commandExists(bin) {
  if (!bin || !/^[\w.@+-]+$/.test(bin)) return false
  try {
    const out = execFileSync('where.exe', [bin], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: freshEnv()
    })
    return out.toString().trim().length > 0
  } catch {
    return false
  }
}

function firstWord(command) {
  return (
    String(command || '')
      .trim()
      .split(/\s+/)[0] || ''
  )
}

let agentCache = null
function getAgents(custom = []) {
  if (!agentCache) {
    agentCache = AGENT_PRESETS.map((a) => ({
      id: a.id,
      name: a.name,
      command: a.command,
      accent: a.accent,
      install: a.install,
      available: commandExists(a.command)
    }))
  }
  const extra = (Array.isArray(custom) ? custom : [])
    .filter((c) => c && c.id && c.name && c.command)
    .map((c) => ({
      id: String(c.id),
      name: String(c.name),
      command: String(c.command),
      accent: typeof c.accent === 'string' ? c.accent : '#8a93a6',
      custom: true,
      install: null,
      available: commandExists(firstWord(c.command))
    }))
  return [...agentCache, ...extra]
}

function defaultShell() {
  const shells = getShells()
  return shells.find((s) => s.id === 'powershell') || shells[0]
}

function shouldUseConpty() {
  return process.env.TESSEL_USE_WINPTY !== '1'
}

function windowsBuildNumber() {
  const parts = os.release().split('.')
  return parts[2] ? Number(parts[2]) : undefined
}

// ---------------------------------------------------------------------------
// Workspace layout persistence
// ---------------------------------------------------------------------------
// The split-tree (structure, sizes, shell per pane, titles, broadcast flags) is
// saved to userData so the workspace reopens the way it was left. We persist the
// LAYOUT, not live process state: each pane is restored with a fresh PTY of the
// same shell (a PTY is a running process and cannot be serialized).
function layoutFile() {
  return join(app.getPath('userData'), 'workspace-layout.json')
}

ipcMain.handle('layout:load', () => {
  try {
    const p = layoutFile()
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    logCrashContext(`layout:load failed: ${err.message}`)
    return null
  }
})

ipcMain.on('layout:save', (_evt, data) => {
  try {
    fs.writeFileSync(layoutFile(), JSON.stringify(data, null, 2), 'utf8')
  } catch {
    /* best-effort: a failed save just means last layout is reused next launch */
  }
})

// ---------------------------------------------------------------------------
// Task-board persistence
// ---------------------------------------------------------------------------
// The kanban task board is stored in its own task-board.json (see
// taskBoardPersistence.js) so it never collides with workspace-layout.json.
ipcMain.handle('taskboard:load', () => {
  try {
    return loadTasks(app.getPath('userData'))
  } catch (err) {
    logCrashContext(`taskboard:load failed: ${err.message}`)
    return []
  }
})

ipcMain.handle('taskboard:save', (_evt, tasks) => {
  try {
    saveTasks(app.getPath('userData'), tasks)
    return { ok: true }
  } catch (err) {
    logCrashContext(`taskboard:save failed: ${err.message}`)
    return { ok: false, error: err.message }
  }
})

// Activity of the agents (see src/shared/activity.js): its own activity.json,
// written atomically (temp file + rename) and kept bounded.
const activityFile = () => join(app.getPath('userData'), 'activity.json')
ipcMain.handle('activity:load', () => {
  try {
    if (!fs.existsSync(activityFile())) return []
    const data = JSON.parse(fs.readFileSync(activityFile(), 'utf8'))
    return Array.isArray(data) ? trimEvents(data.filter(isEvent)) : []
  } catch (err) {
    log.warn('activity', `load failed: ${err.message}`)
    return []
  }
})
ipcMain.handle('activity:save', (_evt, events) => {
  try {
    if (!Array.isArray(events)) return { ok: false, error: 'not a list' }
    const tmp = activityFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(trimEvents(events.filter(isEvent))), 'utf8')
    fs.renameSync(tmp, activityFile())
    return { ok: true }
  } catch (err) {
    log.warn('activity', `save failed: ${err.message}`)
    return { ok: false, error: err.message }
  }
})

// The notes view in Tessel: load (created from the template if missing) and
// save. A save carries the modification time it was based on; if the file
// changed since (an agent wrote in it), nothing is written and the current
// text comes back, so nobody's work is overwritten.
ipcMain.handle('notes:load', (_evt, opts = {}) => {
  const res = ensureNotes(opts)
  if (!res.ok) return res
  try {
    return { ok: true, path: res.path, text: fs.readFileSync(res.path, 'utf8'), mtime: fs.statSync(res.path).mtimeMs }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
ipcMain.handle('notes:save', (_evt, opts = {}) => {
  const res = ensureNotes({ dir: opts.dir, content: '' })
  if (!res.ok) return res
  try {
    const mtime = fs.statSync(res.path).mtimeMs
    if (Number.isFinite(opts.baseMtime) && Math.abs(mtime - opts.baseMtime) > 1) {
      return { ok: false, conflict: true, text: fs.readFileSync(res.path, 'utf8'), mtime }
    }
    const tmp = res.path + '.tmp'
    fs.writeFileSync(tmp, String(opts.text ?? ''), 'utf8')
    fs.renameSync(tmp, res.path)
    return { ok: true, path: res.path, mtime: fs.statSync(res.path).mtimeMs }
  } catch (err) {
    log.warn('notes', `save failed: ${err.message}`)
    return { ok: false, error: err.message }
  }
})

// The shared notes of a project, read for the Activity view (journal lines).
ipcMain.handle('notes:read', (_evt, dir) => {
  try {
    const file = join(String(dir || ''), '.tessel', 'notes.md')
    if (!isAbsolute(file) || !fs.existsSync(file)) return ''
    return fs.readFileSync(file, 'utf8').slice(0, 512 * 1024)
  } catch {
    return ''
  }
})

// ---------------------------------------------------------------------------
// IPC: terminal lifecycle
// ---------------------------------------------------------------------------
ipcMain.handle('shells:list', () => getShells())

// Folder picker for a workspace's project folder. Resolves to a path or null.
ipcMain.handle('dialog:pickFolder', async (_evt, opts = {}) => {
  if (!mainWindow) return null
  const res = await dialog.showOpenDialog(mainWindow, {
    title: opts.title || 'Choose a project folder',
    defaultPath: opts.defaultPath && fs.existsSync(opts.defaultPath) ? opts.defaultPath : undefined,
    properties: ['openDirectory', 'createDirectory']
  })
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
})

// Shared notes of the agents of a project: <project>/.tessel/notes.md.
// Created once from the renderer's template; an existing file (agents write
// in it) is never overwritten. Resolves to { ok, path, created } or
// { ok: false, error }.
function ensureNotes(opts = {}) {
  try {
    const dir = String(opts.dir || '')
    if (!isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return { ok: false, error: 'The project folder does not exist.' }
    }
    const folder = join(dir, '.tessel')
    const file = join(folder, 'notes.md')
    if (fs.existsSync(file)) return { ok: true, path: file, created: false }
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(file, String(opts.content || ''), { flag: 'wx' })
    return { ok: true, path: file, created: true }
  } catch (err) {
    log.warn('notes', `notes file: ${err.message}`)
    return { ok: false, error: err.message }
  }
}
ipcMain.handle('notes:ensure', (_evt, opts) => ensureNotes(opts))

// Open the project notes for the user (created first if missing), in the app
// Windows associates with .md files, else Notepad.
ipcMain.handle('notes:open', async (_evt, opts) => {
  const res = ensureNotes(opts)
  if (!res.ok) return res
  const err = await shell.openPath(res.path)
  if (!err) return res
  // No app for .md files: Notepad. A failed start is reported through the
  // child's 'error' event, after spawn() returns, so wait for it.
  return new Promise((resolve) => {
    try {
      const child = spawn('notepad.exe', [res.path], { detached: true, stdio: 'ignore' })
      child.once('error', (e) => {
        log.warn('notes', `could not open ${res.path}: ${e.message}`)
        resolve({ ok: false, error: `Could not open the notes: ${e.message}` })
      })
      child.once('spawn', () => {
        child.unref()
        resolve(res)
      })
    } catch (e) {
      resolve({ ok: false, error: e.message })
    }
  })
})

ipcMain.handle('app:homeDir', () => os.homedir())
// The language Windows itself is displayed in (e.g. fr-FR), used to pick a
// sensible default voice language. Not app.getSystemLocale(): that is the
// regional format (dates/numbers), which is often English even on a French
// Windows.
let windowsUiLanguage = null
ipcMain.handle('app:systemLocale', () => {
  if (windowsUiLanguage !== null) return windowsUiLanguage
  windowsUiLanguage = ''
  if (process.platform === 'win32') {
    try {
      windowsUiLanguage = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Globalization.CultureInfo]::CurrentUICulture.Name'
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }
      )
        .toString()
        .trim()
    } catch {
      windowsUiLanguage = ''
    }
  }
  if (!windowsUiLanguage) windowsUiLanguage = app.getLocale()
  log.info('voice', `windows display language: ${windowsUiLanguage}`)
  return windowsUiLanguage
})

// --- Logs ----------------------------------------------------------------------
// The interface reports its errors here (rate-limited, so a loop can't flood
// the disk).
let rendererLogBudget = { windowStart: Date.now(), count: 0 }
ipcMain.on('log:write', (_evt, entry = {}) => {
  const now = Date.now()
  if (now - rendererLogBudget.windowStart > 60000)
    rendererLogBudget = { windowStart: now, count: 0 }
  if (++rendererLogBudget.count > 60) return
  const level = ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info'
  log.write(level, 'ui', String(entry.message || '').slice(0, 6000))
})

ipcMain.handle('logs:open', () => shell.openPath(log.dir))

// Text to paste into a bug report: versions, system, and the recent log.
ipcMain.handle('logs:diagnostics', () => {
  const lines = [
    'Tessel diagnostics',
    `version: ${app.getVersion()} (${app.isPackaged ? 'installed' : 'dev'})`,
    `electron ${process.versions.electron}, chrome ${process.versions.chrome}, node ${process.versions.node}`,
    `os: ${process.platform} ${os.release()} ${os.arch()}, ${Math.round(os.totalmem() / 1073741824)} GB RAM`,
    `terminals known to this window: ${ptyInfo.size}`,
    `log file: ${log.file}`,
    '',
    '--- recent log ---',
    log.tail(20000)
  ]
  return lines.join('\n')
})

// Agent session lookups, for resuming conversations when panes reopen.
ipcMain.handle('sessions:claudeExists', (_evt, id) => claudeSessionExists(id))
ipcMain.handle('sessions:findCodex', (_evt, q = {}) => findCodexSession(q))
ipcMain.handle('sessions:list', (_evt, q = {}) => listSessions(q))

// Windows input languages, for choosing the voice typing language.
// Returns [{ tag: 'fr-CA', name: 'Français (Canada)', tip: '0C0C:00001009' }].
ipcMain.handle('app:inputLanguages', () => {
  if (process.platform !== 'win32') return []
  return new Promise((resolve) => {
    const script =
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $list = Get-WinUserLanguageList; ConvertTo-Json -Compress -InputObject @(foreach ($l in $list) { [pscustomobject]@{ tag = $l.LanguageTag; name = $l.LocalizedName; tip = @($l.InputMethodTips)[0] } })'
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve([])
        try {
          const data = JSON.parse(String(stdout).trim() || '[]')
          resolve((Array.isArray(data) ? data : [data]).filter((l) => l && l.tag))
        } catch {
          resolve([])
        }
      }
    )
  })
})

// Voice typing: optionally switch this window's input language (Windows
// dictation listens in the active input language; it does not auto-detect),
// then press Win+H, which opens Windows' built-in dictation for the focused
// terminal. Speech is handled by Windows; nothing is recorded by this app.
ipcMain.handle('app:voiceTyping', (_evt, opts = {}) => {
  if (process.platform !== 'win32') return false
  const hkl = hklFromTip(opts && opts.tip)
  log.info('voice', `start dictation, language ${opts && opts.tip ? opts.tip : 'keyboard default'}`)
  const hwnd = mainWindow ? mainWindow.getNativeWindowHandle().readBigUInt64LE(0) : 0n
  const lines = [
    'Add-Type -Namespace SP -Name Win -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra); [DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, uint msg, System.IntPtr w, System.IntPtr l);\''
  ]
  if (hkl && hwnd) {
    // WM_INPUTLANGCHANGEREQUEST
    lines.push(`[void][SP.Win]::PostMessage([IntPtr]${hwnd}, 0x50, [IntPtr]0, [IntPtr]${hkl})`)
    lines.push('Start-Sleep -Milliseconds 250')
  }
  lines.push(
    '[SP.Win]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)',
    '[SP.Win]::keybd_event(0x48, 0, 0, [UIntPtr]::Zero)',
    '[SP.Win]::keybd_event(0x48, 0, 2, [UIntPtr]::Zero)',
    '[SP.Win]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)'
  )
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', lines.join('; ')],
      { windowsHide: true, timeout: 15000 },
      (err) => resolve(!err)
    )
  })
})

// Links (sign-in pages, docs) open in the user's normal browser. Only web and
// mail links are allowed.
function isSafeExternal(url) {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}
ipcMain.handle('app:openExternal', async (_evt, url) => {
  if (!isSafeExternal(url)) return false
  await shell.openExternal(url)
  return true
})

// Multi-agent helpers: git worktrees and MCP server management.
const safe = (fn) => async (_evt, arg) => {
  try {
    return await fn(arg)
  } catch (err) {
    log.error('tools', err)
    return { ok: false, error: err.message }
  }
}
ipcMain.handle(
  'git:info',
  safe((cwd) => gitInfo(cwd))
)
ipcMain.handle(
  'git:createWorktree',
  safe(({ cwd, label } = {}) => createWorktree(cwd, label))
)
ipcMain.handle('review:info', safe(reviewInfo))
ipcMain.handle('review:diff', safe(reviewDiff))
ipcMain.handle('review:merge', safe(reviewMerge))
ipcMain.handle('review:remove', safe(reviewRemove))
ipcMain.handle('lead:ensure', safe(ensureInbox))
ipcMain.handle('lead:take', safe(takeInbox))
ipcMain.handle('lead:remove', safe(removeInbox))
ipcMain.handle('channel:ensure', safe(ensureTeamChannel))
ipcMain.handle('channel:poll', safe(pollTeamChannel))
ipcMain.handle('channel:ack', safe(ackTeamDelivery))
ipcMain.handle('channel:hold', safe(holdTeamDelivery))
ipcMain.handle('channel:release', safe(releaseTeamDelivery))
ipcMain.handle('channel:acks', safe(takeTeamAcks))
ipcMain.handle('team:notice', safe(addNotices))
ipcMain.handle('team:current', safe(writeCurrentTeams))
ipcMain.handle('team:retire', safe(retireOldTeams))

// A Codex config.toml Tessel is about to write, checked by Codex itself in a
// throwaway CODEX_HOME. -> { ok, error }
function validateCodexConfig(text) {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-codex-check-'))
  fs.writeFileSync(join(home, 'config.toml'), text, 'utf8')
  const script = [
    "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    `$env:CODEX_HOME = '${home.replace(/'/g, "''")}'`,
    'codex mcp list --json | Out-Null',
    'exit $LASTEXITCODE'
  ].join('; ')
  return new Promise((resolveCheck) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 60000, env: cleanEnv(process.env) },
      (err, _out, stderr) => {
        try {
          fs.rmSync(home, { recursive: true, force: true })
        } catch {
          // a temp folder
        }
        const why = String(stderr || '').split(/\r?\n/).find((l) => l.trim() && !/WARNING/.test(l)) || ''
        resolveCheck(err ? { ok: false, error: why.trim() || 'codex mcp list failed' } : { ok: true })
      }
    )
  })
}

// Team tools for agents (background messages, never typed into terminals):
// the MCP server script, registered for Claude Code and Codex, plus Claude
// Code hooks. -> { ok, changed: [...], errors: [...] }
ipcMain.handle(
  'team:install',
  safe(async () => {
    const script = writeServerScript(app.getPath('userData'), teamServerSource)
    const changed = []
    const errors = []
    if (!claudeServerPresent(script)) {
      const res = await addMcp({
        agent: 'claude',
        name: SERVER_NAME,
        transport: 'stdio',
        commandLine: `node "${script}"`,
        scope: 'user'
      })
      if (res.ok) changed.push('Claude Code: MCP server tessel-team')
      else errors.push(`Claude Code: ${res.error}`)
    }
    try {
      const r = installClaudeHooks(script)
      if (r.error) errors.push(`Claude Code hooks: ${r.error}`)
      else if (r.changed) changed.push('Claude Code: hooks for team messages')
    } catch (err) {
      errors.push(`Claude Code hooks: ${err.message}`)
    }
    try {
      const r = await installCodexServer(script, validateCodexConfig)
      if (r.error) errors.push(`Codex: ${r.error}`)
      else if (r.changed) changed.push('Codex: MCP server tessel-team')
    } catch (err) {
      errors.push(`Codex: ${err.message}`)
    }
    if (changed.length) log.info('team', `team tools set up: ${changed.join('; ')}`)
    if (errors.length) log.error('team', `team tools: ${errors.join('; ')}`)
    return { ok: errors.length === 0, script, changed, errors }
  })
)
ipcMain.handle(
  'mcp:list',
  safe((cwd) => listMcp(cwd))
)
ipcMain.handle(
  'mcp:add',
  safe((spec) => addMcp(spec))
)
ipcMain.handle(
  'mcp:remove',
  safe((spec) => removeMcp(spec))
)
ipcMain.handle(
  'mcp:test',
  safe((ref) => testMcp(ref, freshEnv()))
)
ipcMain.handle(
  'mcp:copy',
  safe((spec) => copyMcp(spec))
)

// "An agent needs you": native notification + taskbar flash. Clicking the
// notification brings the window forward and tells the renderer which pane.
ipcMain.on('app:notify', (_evt, { title, body, paneId } = {}) => {
  if (!mainWindow) return
  if (!mainWindow.isFocused()) mainWindow.flashFrame(true)
  if (!Notification.isSupported()) return
  const n = new Notification({ title: title || 'Tessel', body: body || '', silent: false })
  n.on('click', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    send('app:focusPane', { paneId })
  })
  n.show()
  // Showing a notification can make Electron recreate its shortcut with its
  // own icon; put ours back right after.
  setTimeout(ensureDevShortcut, 3000)
})
ipcMain.handle('agents:list', (_evt, custom) => getAgents(custom))
// Which of these commands are on PATH (fresh PATH, so just-installed tools
// show up). Returns { bin: true|false }.
ipcMain.handle('tools:check', (_evt, bins) => {
  const out = {}
  for (const b of Array.isArray(bins) ? bins.slice(0, 50) : []) out[b] = commandExists(b)
  return out
})
// Full path of a command on the fresh PATH (null if missing).
function whichFresh(bin) {
  try {
    const out = execFileSync('where.exe', [bin], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: freshEnv()
    })
    return (
      out
        .toString()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean) || null
    )
  } catch {
    return null
  }
}

function runFile(file, args) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 20000, env: freshEnv() },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}\n${stderr || ''}` })
    )
  })
}

// Setup status for tools that need a one-time step, so Tools only offers the
// step when it's still needed: GitHub CLI sign-in and git's name/email.
ipcMain.handle('tools:status', async () => {
  const status = {}
  const gh = whichFresh('gh')
  if (gh) {
    const res = await runFile(gh, ['auth', 'status', '--hostname', 'github.com'])
    const m = /account\s+(\S+)/i.exec(res.out)
    status.gh = { signedIn: res.ok, account: res.ok && m ? m[1] : null }
  }
  const git = whichFresh('git')
  if (git) {
    const name = await runFile(git, ['config', '--global', 'user.name'])
    const email = await runFile(git, ['config', '--global', 'user.email'])
    const n = name.ok ? name.out.trim() : ''
    const e = email.ok ? email.out.trim() : ''
    status.git = { configured: !!(n && e), name: n || null, email: e || null }
  }
  return status
})

ipcMain.handle('tools:refreshPath', () => {
  freshPath = readFreshPath()
  agentCache = null
  return true
})

// Re-read PATH and re-detect agents (after installing one).
ipcMain.handle('agents:refresh', (_evt, custom) => {
  freshPath = readFreshPath()
  agentCache = null
  return getAgents(custom)
})

// Clipboard (kept in the main process so it works regardless of renderer
// focus/permission quirks).
ipcMain.handle('clipboard:read', () => clipboard.readText())
ipcMain.handle('clipboard:hasImage', () =>
  clipboard.availableFormats().some((f) => f.startsWith('image/'))
)
// Save the clipboard image as a PNG and return its path, so it can be pasted
// into an agent as a file (instant, instead of the agent reading the
// clipboard itself). Files older than a day are removed.
ipcMain.handle('clipboard:saveImage', () => {
  const img = clipboard.readImage()
  if (img.isEmpty()) return null
  const dir = join(os.tmpdir(), 'tessel-paste')
  fs.mkdirSync(dir, { recursive: true })
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000
  for (const f of fs.readdirSync(dir)) {
    try {
      if (fs.statSync(join(dir, f)).mtimeMs < dayAgo) fs.unlinkSync(join(dir, f))
    } catch {
      /* in use or gone */
    }
  }
  const file = join(dir, `image-${Date.now()}.png`)
  fs.writeFileSync(file, img.toPNG())
  return file
})
ipcMain.on('clipboard:write', (_evt, text) => {
  if (typeof text === 'string' && text.length) clipboard.writeText(text)
})

// --- Terminals live in the terminal host (ptyHost.js) --------------------------
// so they survive app restarts, crashes and reloads.
const ptyInfo = new Map() // id -> { shellId, shellName, backend } for terminals this app knows

function hostToken() {
  const file = join(app.getPath('userData'), 'pty-host.token')
  try {
    const t = fs.readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(t)) return t
  } catch {
    /* create one */
  }
  const t = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(file, t, { mode: 0o600 })
  return t
}

const hostPipe = pipeName(
  os.userInfo().username,
  process.env.TESSEL_PTYHOST_CHANNEL || (app.isPackaged ? 'app' : 'dev')
)

// Safety limit: never start more than 3 hosts a minute, whatever goes wrong.
const hostStarts = []
function startHost() {
  const now = Date.now()
  while (hostStarts.length && now - hostStarts[0] > 60000) hostStarts.shift()
  if (hostStarts.length >= 3) {
    log.error('pty', 'terminal host keeps failing to start; not trying again for a minute')
    return
  }
  hostStarts.push(now)
  const script = join(__dirname, 'ptyHost.js')
  log.info('pty', `starting terminal host (${script})`)
  const child = spawn(process.execPath, [script], {
    env: {
      ...cleanEnv(process.env),
      ELECTRON_RUN_AS_NODE: '1',
      TESSEL_PTYHOST_PIPE: hostPipe,
      TESSEL_PTYHOST_TOKEN: hostToken(),
      TESSEL_LOG_DIR: log.dir
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.on('error', (err) => log.error('pty', `could not start terminal host: ${err.message}`))
  child.unref()
}

const pendingData = new Map() // id -> string
let flushTimer = null
function flushData() {
  flushTimer = null
  for (const [id, data] of pendingData) send('pty:data', { id, data })
  pendingData.clear()
}
function queueData(id, data) {
  pendingData.set(id, (pendingData.get(id) || '') + data)
  if (!flushTimer) flushTimer = setTimeout(flushData, 8)
}

const host = createPtyClient({
  pipe: hostPipe,
  token: hostToken(),
  startHost,
  log,
  // Output is batched per terminal (every ~8 ms) instead of one message per
  // chunk: a busy agent can print thousands of small chunks a second.
  onData: (id, data) => queueData(id, data),
  onExit: (id, exitCode, signal, pid) => {
    flushData() // deliver the last output before the exit notice
    const info = ptyInfo.get(id)
    if (exitCode && info) {
      log.warn(
        'pty',
        `${info.shellName} ${id} exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`
      )
    }
    send('pty:exit', { id, exitCode, signal, pid: pid || null })
  },
  onLost: () => {
    if (quitting) return
    log.error('pty', 'lost the connection to the terminal host')
    // Its terminals are gone with it: tell the panes.
    for (const id of ptyInfo.keys()) send('pty:exit', { id, exitCode: -1, signal: 0 })
    ptyInfo.clear()
  }
})

ipcMain.handle('pty:create', async (_evt, opts = {}) => {
  const { id, shellId, cols = 80, rows = 24, cwd, projectDir } = opts
  if (!id) throw new Error('pty:create requires an id')
  const shell = getShells().find((s) => s.id === shellId) || defaultShell()
  const startDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir()
  const useConpty = shouldUseConpty()
  const backend = useConpty ? 'conpty' : 'winpty'
  let res
  try {
    res = await host.request('create', {
      id,
      file: shell.file,
      args: shell.args,
      cwd: startDir,
      env: {
        ...freshEnv(),
        // For the Tessel team tools (teamMcp/server.cjs): which pane this is,
        // and the project its team lives in.
        TESSEL_PANE_ID: String(id),
        ...(projectDir && isAbsolute(projectDir) && fs.existsSync(projectDir) ? { TESSEL_PROJECT_DIR: projectDir } : {})
      },
      cols,
      rows,
      useConpty,
      // ConPTY is required for full-screen TUIs like Claude Code to redraw on
      // resize. Set TESSEL_USE_WINPTY=1 only as a fallback.
      meta: { shellId: shell.id, shellName: shell.name, backend, cwd: startDir }
    })
  } catch (err) {
    res = { ok: false, error: err.message }
  }
  if (!res.ok) {
    log.error('pty', `failed to launch ${shell.name} (${shell.file}) in ${startDir}: ${res.error}`)
    return { ok: false, error: `Failed to launch ${shell.name}: ${res.error}` }
  }
  ptyInfo.set(id, { shellId: shell.id, shellName: shell.name, backend })
  return {
    ok: true,
    shell: { id: shell.id, name: shell.name },
    backend,
    windowsBuild: windowsBuildNumber(),
    pid: res.pid,
    cwd: startDir
  }
})

// Re-attach to a terminal that kept running in the host (after a restart,
// crash or reload). Returns its recent output to replay.
ipcMain.handle('pty:attach', async (_evt, id) => {
  let res
  try {
    res = await host.request('attach', { id })
  } catch (err) {
    return { ok: false, error: err.message }
  }
  if (!res.ok) return { ok: false }
  ptyInfo.set(id, { shellId: res.shellId, shellName: res.shellName, backend: res.backend })
  return {
    ok: true,
    shell: { id: res.shellId, name: res.shellName },
    backend: res.backend,
    windowsBuild: windowsBuildNumber(),
    pid: res.pid,
    cwd: res.cwd,
    exited: !!res.exited,
    exitCode: res.exitCode,
    buffer: res.buffer || ''
  }
})

// After the interface restores its panes: close host terminals no pane uses.
ipcMain.handle('pty:reconcile', async (_evt, liveIds = []) => {
  let hello
  try {
    hello = await host.ensure()
  } catch {
    return 0
  }
  const keep = new Set(liveIds)
  let closed = 0
  const list = hello && hello.ptys ? hello.ptys.map((p) => p.id) : [...ptyInfo.keys()]
  for (const id of list) {
    if (!keep.has(id)) {
      host.send('kill', { id })
      ptyInfo.delete(id)
      closed++
    }
  }
  if (closed) log.info('pty', `closed ${closed} terminal(s) no pane was using`)
  return closed
})

ipcMain.on('pty:write', (_evt, { id, data }) => host.send('write', { id, data }))

ipcMain.on('pty:resize', (_evt, { id, cols, rows }) => {
  if (cols > 0 && rows > 0) host.send('resize', { id, cols, rows })
})

ipcMain.on('pty:kill', (_evt, { id }) => {
  host.send('kill', { id })
  ptyInfo.delete(id)
})

// Recent output saved when you close the app, shown again when panes reopen.
function scrollbackFile() {
  return join(app.getPath('userData'), 'scrollback.json')
}

ipcMain.handle('scrollback:load', () => {
  try {
    const data = JSON.parse(fs.readFileSync(scrollbackFile(), 'utf8'))
    fs.unlinkSync(scrollbackFile())
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
})

// Closing the app on purpose: save each terminal's recent output, then stop
// the host and its terminals. (A crash or a dev restart skips this, so the
// terminals keep running and the app re-attaches.)
let quitting = false
let shutdownDone = false
// Save every terminal's recent output (64 KB each) for the next start.
async function saveScrollback() {
  try {
    const res = await host.request('dump', {}, 4000)
    const keep = {}
    for (const [id, text] of Object.entries(res.buffers || {})) {
      keep[id] = String(text).slice(-64 * 1024)
    }
    const tmp = scrollbackFile() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(keep))
    fs.renameSync(tmp, scrollbackFile())
  } catch (err) {
    log.warn('pty', `could not save terminal output: ${err.message}`)
  }
}

// Also every 30 s, and when Windows signs out or shuts down, so a reboot or
// power loss still leaves recent output to show next time.
setInterval(() => {
  if (host.connected && !quitting) saveScrollback()
}, 30000).unref()
app.on('session-end', () => {
  log.info('app', 'Windows is signing out or shutting down: saving terminal output')
  saveScrollback()
})

async function shutdownTerminals() {
  quitting = true
  await saveScrollback()
  try {
    await host.request('shutdown', {}, 4000)
  } catch {
    /* host already gone */
  }
}

// --- Updates (see updater.js) --------------------------------------------------
// Installing closes the app the same way as closing it on purpose (layout and
// terminal output saved, terminal host stopped so the installer can replace
// its files), and leaves a note so the next start can say what changed.
function updateNoteFile() {
  return join(app.getPath('userData'), 'update-installed.json')
}

const updater = createUpdater({
  log,
  send,
  beforeInstall: async (version) => {
    fs.writeFileSync(updateNoteFile(), JSON.stringify({ from: app.getVersion(), to: version }))
    await shutdownTerminals()
    shutdownDone = true
  }
})

ipcMain.handle('update:status', () => updater.status)
ipcMain.handle('update:check', () => updater.check())
ipcMain.handle('update:install', () => updater.install())
ipcMain.on('window:theme', (event, theme) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
  const palette = {
    classic: { color: '#101216', symbolColor: '#d6d9df' },
    warp: { color: '#161917', symbolColor: '#dfe5df' }
  }[theme]
  if (!palette) return
  mainWindow.setTitleBarOverlay({ ...palette, height: 39 })
})
// After an update: { from, to } once, on the first start of the new version.
ipcMain.handle('update:justInstalled', () => {
  try {
    const note = JSON.parse(fs.readFileSync(updateNoteFile(), 'utf8'))
    fs.unlinkSync(updateNoteFile())
    return note && note.to === app.getVersion() ? note : null
  } catch {
    return null
  }
})

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#101216',
    title: 'Tessel',
    autoHideMenuBar: true,
    // Merge the title bar and our toolbar into one unified bar: hide the native
    // frame but overlay the Windows min/max/close buttons on top of our bar.
    // Taskbar/window icon. The installed app also gets it from the .exe; in dev
    // this replaces the default Electron icon.
    ...(fs.existsSync(appIconPath()) ? { icon: appIconPath() } : {}),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#101216',
      symbolColor: '#d6d9df',
      height: 39
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Lets the window mark itself as the dev build.
      additionalArguments: app.isPackaged ? [] : ['--tessel-dev'],
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Dev build: point the taskbar button at our icon explicitly.
  if (process.platform === 'win32' && !app.isPackaged && fs.existsSync(appIconPath())) {
    mainWindow.setAppDetails({
      appId: APP_ID,
      appIconPath: appIconPath(),
      appIconIndex: 0,
      relaunchDisplayName: 'Tessel (dev)'
    })
  }
  // Never open pages inside the app window: send them to the system browser
  // (OAuth sign-in, e.g. Gemini or Claude, only works there).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL() && !url.startsWith('http://localhost:5173')) {
      event.preventDefault()
      if (isSafeExternal(url)) shell.openExternal(url)
    }
  })
  mainWindow.maximize()

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logCrashContext(`renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })

  mainWindow.webContents.on('responsive', () => log.info('window', 'responsive again'))
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) =>
    log.error('window', `failed to load ${url}: ${desc} (${code})`)
  )
  mainWindow.webContents.on('unresponsive', () => {
    logCrashContext('renderer unresponsive')
  })

  mainWindow.on('focus', () => {
    if (mainWindow) mainWindow.flashFrame(false)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Windows takes a taskbar button's icon from the Start menu shortcut that owns
// the app's taskbar id. In dev, Electron creates one itself ("Electron.lnk",
// with Electron's icon) the first time a notification is shown, and then the
// taskbar shows Electron's logo whatever the window's icon is. So the dev
// build keeps its own shortcut with our icon, and removes Electron's only when
// it carries our id (other Electron apps are left alone).
function ensureDevShortcut() {
  if (process.platform !== 'win32' || app.isPackaged) return false
  const icon = appIconPath()
  if (!fs.existsSync(icon)) return false
  const programs = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const details = {
    target: process.execPath,
    args: `"${app.getAppPath()}"`,
    cwd: app.getAppPath(),
    icon,
    iconIndex: 0,
    appUserModelId: APP_ID,
    description: 'Tessel (development build)'
  }
  let repaired = false
  const write = (file) => {
    try {
      shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', details)
    } catch (err) {
      log.warn('app', `dev shortcut ${file} failed: ${err.message}`)
    }
  }
  write(join(programs, 'Tessel (dev).lnk'))
  // Left over from before the rename to Tessel.
  try {
    fs.rmSync(join(programs, 'Shell Panels (dev).lnk'), { force: true })
  } catch {
    /* best-effort */
  }
  // Electron (re)creates "Electron.lnk" with Electron's icon and our id each
  // time a notification is shown and the file is missing. Deleting it only
  // lasts until the next notification, so keep it, with our icon instead.
  const electronLnk = join(programs, 'Electron.lnk')
  try {
    if (fs.existsSync(electronLnk)) {
      const link = shell.readShortcutLink(electronLnk)
      const ours = String(link.appUserModelId || '').startsWith('com.jeanclaudetrottier.tessel')
      if (ours && link.icon !== icon) {
        write(electronLnk)
        repaired = true
      }
    } else {
      write(electronLnk)
    }
  } catch {
    /* unreadable: leave it */
  }
  if (repaired) {
    log.info('app', 'repaired the dev taskbar shortcut icon (Electron had reset it)')
    // Ask Windows to refresh its icon cache so the taskbar picks it up.
    try {
      spawn(join(process.env.WINDIR || 'C:\\Windows', 'System32', 'ie4uinit.exe'), ['-show'], {
        windowsHide: true,
        stdio: 'ignore'
      }).on('error', () => {})
    } catch {
      /* best-effort */
    }
  }
  return repaired
}

// One running copy per data folder: two copies on the same data would
// overwrite each other's layout and saved output, so opening a second copy
// focuses the first instead. The installed app and the dev build have their
// own data folders (see DATA_DIR), so one of each can run side by side.
// (TESSEL_USER_DATA gives tests their own data, so they get their own lock.)
// In the dev build, electron-vite restarts the app on every code change and
// can start the new copy a moment before the old one has exited. The new copy
// then found the old one's lock and quit, and electron-vite (which stops when
// its app exits) stopped with it. So the dev build waits a few seconds for
// the lock instead of giving up at once.
async function acquireInstanceLock() {
  if (app.requestSingleInstanceLock()) return true
  if (app.isPackaged) return false
  const until = Date.now() + 8000
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250))
    if (app.requestSingleInstanceLock()) return true
  }
  return false
}

Promise.all([acquireInstanceLock(), app.whenReady()]).then(([gotInstanceLock]) => {
  if (!gotInstanceLock) {
    // Quit without touching the terminal host: it belongs to the running copy.
    log.info('app', 'another Tessel is already running: focusing it and exiting')
    shutdownDone = true
    app.quit()
    return
  }
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  log.info(
    'app',
    `started v${app.getVersion()} (${app.isPackaged ? 'installed' : 'dev'}) electron ${process.versions.electron} node ${process.versions.node} ${process.platform} ${os.release()} ${os.arch()}`
  )
  ensureDevShortcut()
  createWindow()
  updater.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit')
    log.error(
      'app',
      `child process gone: ${details.type} ${details.reason} (exit ${details.exitCode})`
    )
})

app.on('before-quit', () => log.info('app', 'quitting'))

process.on('uncaughtException', (error) => {
  log.error('main', `uncaught exception: ${describe(error)}`)
})

process.on('unhandledRejection', (error) => {
  logCrashContext(`unhandledRejection: ${error && (error.stack || error.message || String(error))}`)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownDone) return
  event.preventDefault()
  shutdownDone = true
  shutdownTerminals().finally(() => app.quit())
})
