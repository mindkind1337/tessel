import { app, BrowserWindow, ipcMain, clipboard, nativeImage, dialog, Notification, shell, powerSaveBlocker, powerMonitor, safeStorage } from 'electron'
import { join, isAbsolute, dirname } from 'path'
import os from 'os'
import fs from 'fs'
import { spawn, execFile } from 'child_process'
import { loadTasks, loadBoard, saveTasks } from './taskBoardPersistence'
import { trimEvents, isEvent } from '../shared/activity'
import { agentModelLive, watchModelFiles } from './agentModel'
import { createCodexAccounts } from './codexAccounts'
import { createClaudeAccounts } from './claudeAccounts'
import { createProviderLogin } from './providerLogin'
import { createProviderAccounts } from './providerAccounts'
import { createAccountUsage } from './providerAccountUsage'
import { registerProviderUsage } from './providerUsageIpc'
import { createAccountSessions } from './providerAccountSessions'
import { postToInbox } from './agentInbox'
import { hooksStatus } from './teamHooksStatus'
import { createAgentStateStore } from './agentStateStore'
import { createUsageStatsTracker } from './usageStatsTracker'
import { copyUsageImage } from './usageClipboard'
import { registerIssueServices } from './issueServicesIpc'
import { createRemoteHosts, registerRemoteHosts } from './remoteHosts'
import { prepareAgentStateHooks } from './agentStateSetup'
import { assessNeeds } from './tesselNeeds'
import { createClaudeUsageReport } from './claudeUsageReport'
import { resolveFiles, codeGotoArg, listProjectFiles } from './fileOpen'
import { titleBarColors } from '../shared/themePalettes'
import { geminiSessionExists, qwenSessionExists } from './agentResume'
import { paneEnv } from './paneEnv'
import { readForView, readImageForView, openPdfWindow } from './fileView'
import { readForEdit, statForEdit, writeForEdit, headContent, createFileWatcher } from './editorFiles'
import * as explorer from './explorer'
import { extraToolDirs, withToolDirs } from './toolDirs'
import { createInstallLogs } from './installLog'
import { writeBoardRule } from './agentMemory'
import { claudeImageFile, isPastedImage, PASTE_DIR } from './pastedImages'
import { createLogger, describe } from './logger'
import { cleanEnv } from './cleanEnv'
import { createPtyClient } from './ptyClient'
import { listProcesses, treeOf, waitForExit, killPids, listProcessNames, runningWork } from './processTree'
import { pipeName } from './ptyProtocol'
import { createUpdater } from './updater'
import { createAgentUpdates } from './agentUpdates'
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
import { reviewInfo, reviewDiff, reviewMerge, reviewRemove, reviewCommit, reviewPush } from './review'
import * as scm from './sourceControl'
import { runHeadless, cancelHeadless } from './agentHeadless'
import { takeTeamAcks } from './teamAcks'
import { writeJsonSafe, readJsonSafe } from './safeJson'
import { addNotices, writeCurrentTeams, retireOldTeams } from './teamNotices'
import { JSON_AGENTS, setJsonAgentServer, teamToolsEntry } from './jsonAgents'
import { detectAgents } from './agentDetect'
import { createPortScanner } from './workspacePorts'
import { createResourceCollector } from './resourceUsage'
import { publishTeamTasks, takeTeamRequests, finishTeamRequests, messageStatuses, writeBoardPanes, toolsAlive, writeRoster } from './teamTasks'
import {
  writeServerScript,
  installClaudeHooks,
  installCodexHooks,
  installGeminiHooks,
  installCopilotHooks,
  installOpencodePlugin,
  installKimiHooks,
  installCodexServer,
  claudeServerPresent,
  claudeServerExists,
  SERVER_NAME
} from './teamInstall'
import teamServerSource from './teamMcp/server.cjs?raw'
import { ensureInbox, takeInbox, removeInbox } from './leadInbox'
import { t, setLanguage as setMainLanguage } from './i18n'
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
    id: 'kimi',
    name: 'Kimi Code',
    command: 'kimi',
    accent: '#3b82f6',
    // Kimi Code's own installer (the pip kimi-cli is no longer maintained);
    // run through PowerShell so it works from any shell.
    install: ['powershell -NoProfile -Command "irm https://code.kimi.com/kimi-code/install.ps1 | iex"'],
    // The old pip kimi-cli answers to "kimi" too (and only says it is no
    // longer maintained): found there, Kimi Code is not installed.
    notFrom: /[\\/](Python\d*[\\/]Scripts|local-packages[\\/][^\\/]+[\\/]Scripts)[\\/]kimi(\.exe)?$/i
  },
  {
    id: 'ollama',
    name: 'Ollama',
    command: 'ollama',
    accent: '#f5f5f5',
    install: ['winget install --id Ollama.Ollama -e']
  },
  {
    id: 'cline',
    name: 'Cline',
    command: 'cline',
    accent: '#6ea8fe',
    install: ['npm install -g cline']
  },
  {
    id: 'amp',
    name: 'Amp',
    command: 'amp',
    accent: '#f34e3f',
    install: ['npm install -g @ampcode/cli']
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    // `agent` is also a Grok alias. Cursor keeps its distinctive CLI name.
    command: 'cursor-agent',
    accent: '#a3a3a3',
    install: null
  },
  {
    id: 'grok',
    name: 'Grok Build',
    command: 'grok',
    accent: '#b8b8b8',
    install: null
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    accent: '#cf7cdb',
    install: ['npm install -g --ignore-scripts @earendil-works/pi-coding-agent']
  },
  {
    id: 'droid',
    name: 'Factory Droid',
    command: 'droid',
    accent: '#f08050',
    install: ['npm install -g @factory/cli']
  },
  {
    id: 'crush',
    name: 'Crush',
    command: 'crush',
    accent: '#ff79c6',
    install: ['npm install -g @charmland/crush']
  },
  {
    id: 'goose',
    name: 'Goose',
    command: 'goose',
    accent: '#e4b65b',
    install: null
  },
  {
    id: 'auggie',
    name: 'Auggie',
    command: 'auggie',
    accent: '#67c5ad',
    // Augment currently documents Windows through WSL, not native setup.
    install: null
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    accent: '#14b014',
    install: ['python -m pip install aider-install', 'aider-install']
  },
  // More agents Orca knows (its catalog, MIT). Only installers we are sure
  // of; the others: see their Docs link in Settings > Agents.
  {
    id: 'openclaude',
    name: 'OpenClaude',
    command: 'openclaude',
    accent: '#d9a077',
    install: null
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    command: 'kilo',
    accent: '#f8f675',
    install: ['npm install -g @kilocode/cli']
  },
  {
    id: 'kiro',
    name: 'Kiro',
    command: 'kiro-cli chat --tui',
    accent: '#9046ff',
    install: null
  },
  {
    id: 'continue',
    name: 'Continue',
    command: 'cn',
    accent: '#be1fff',
    install: ['npm install -g @continuedev/cli']
  },
  {
    id: 'codebuff',
    name: 'Codebuff',
    command: 'codebuff',
    accent: '#56c271',
    install: ['npm install -g codebuff']
  },
  {
    id: 'vibe',
    name: 'Mistral Vibe',
    command: 'vibe',
    accent: '#fa520f',
    install: null
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    accent: '#5b8def',
    install: null
  },
  {
    id: 'rovo',
    name: 'Rovo Dev',
    command: 'rovo',
    accent: '#1868db',
    install: null
  },
  {
    id: 'hermes',
    name: 'Hermes',
    command: 'hermes --tui',
    accent: '#c9a86a',
    install: null
  },
  {
    id: 'devin',
    name: 'Devin',
    command: 'devin',
    accent: '#3fb68b',
    install: null
  },
  {
    id: 'trae',
    name: 'Trae',
    command: 'traecli',
    accent: '#ff4d4f',
    install: null
  },
  {
    id: 'zcode',
    name: 'ZCode',
    command: 'zcode',
    accent: '#6c8cff',
    install: null
  },
  {
    id: 'autohand',
    name: 'Autohand Code',
    command: 'autohand',
    accent: '#f59e0b',
    install: null
  },
  {
    id: 'commandcode',
    name: 'Command Code',
    command: 'command-code --trust',
    accent: '#e5e7eb',
    install: null
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    command: 'openclaw',
    accent: '#ef6b5b',
    install: null
  }
]

// PATH as it is *now* in the registry (machine + user), not as it was when
// Tessel started. Installing an agent, or fixing PATH, then works in new
// panes without restarting the app.
// Run a program without blocking the app (the window and terminals keep
// running while it works). -> { ok, stdout }
function runQuiet(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, ...opts }, (err, stdout) =>
      resolve({ ok: !err, stdout: String(stdout || '') })
    )
  })
}

let freshPath = null
async function readFreshPath() {
  if (process.platform !== 'win32') return process.env.PATH
  try {
    // UTF-8 output: by default PowerShell writes in the console code page
    // (cp850 on a French Windows) and folders with accents come out wrong.
    const script =
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
    const res = await runQuiet('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 15000
    })
    const value = res.ok ? res.stdout.trim() : ''
    return value || null
  } catch {
    return null
  }
}

// Read once at start (in the background): until then, the PATH Tessel was
// started with.
readFreshPath().then((p) => {
  if (freshPath === null) freshPath = p || ''
})
// Plus the folders installers put commands in without adding them to PATH
// (pip with the Store Python, uv, pipx...: see toolDirs.js), looked up again
// when PATH is read again (after installing an agent).
let toolDirs = null
// Python's user scripts folder (where pip --user puts kimi, aider...), asked
// once in the background: python and the py launcher.
let pythonDirs = []
if (process.platform === 'win32') {
  const ask = "import sysconfig, os; print(sysconfig.get_path('scripts', os.name + '_user'))"
  Promise.all([runQuiet('python', ['-c', ask], { timeout: 15000 }), runQuiet('py', ['-3', '-c', ask], { timeout: 15000 })]).then(
    (res) => {
      pythonDirs = [...new Set(res.filter((r) => r.ok).map((r) => r.stdout.trim()).filter(Boolean))]
      toolDirs = null
    }
  )
}
function currentPath() {
  if (!toolDirs) toolDirs = extraToolDirs(process.env, os.homedir(), pythonDirs)
  return withToolDirs(freshPath || process.env.PATH || process.env.Path || '', toolDirs)
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

// notFrom: a copy found there does not count (the first one found is the
// one that runs).
async function commandExists(bin, notFrom = null) {
  if (!bin || !/^[\w.@+-]+$/.test(bin)) return false
  const res = await runQuiet('where.exe', [bin], { env: freshEnv(), timeout: 10000 })
  const first = res.ok ? res.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) : ''
  if (!first) return false
  return !(notFrom && notFrom.test(first))
}

function firstWord(command) {
  return (
    String(command || '')
      .trim()
      .split(/\s+/)[0] || ''
  )
}

let agentCache = null // a promise of the presets with 'available'
async function getAgents(custom = []) {
  if (!agentCache) {
    agentCache = Promise.all(
      AGENT_PRESETS.map(async (a) => ({
        id: a.id,
        name: a.name,
        command: a.command,
        accent: a.accent,
        install: a.install,
        available: await commandExists(firstWord(a.command), a.notFrom || null)
      }))
    )
  }
  const extra = await Promise.all(
    (Array.isArray(custom) ? custom : [])
      .filter((c) => c && c.id && c.name && c.command)
      .map(async (c) => ({
        id: String(c.id),
        name: String(c.name),
        command: String(c.command),
        accent: typeof c.accent === 'string' ? c.accent : '#8a93a6',
        custom: true,
        install: null,
        available: await commandExists(firstWord(c.command))
      }))
  )
  return [...(await agentCache), ...extra]
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

// The layout survives a kill mid-write: saved through a temp file (the
// previous copy kept as .bak), and a damaged file falls back to that copy
// instead of starting over with an empty grid.
// A saved layout is an object (null, a number or a list is damage).
const isLayout = (d) => !!d && typeof d === 'object' && !Array.isArray(d)

ipcMain.handle('layout:load', () => {
  try {
    const res = readJsonSafe(layoutFile(), isLayout, { onLocked: 'backup' })
    // Held by another program even after retries: say so, with the previous
    // copy to show (the window never saves over the file this session).
    if (res.locked) {
      log.warn('app', 'layout: the file is in use by another program; showing the previous copy, not saving')
      return { locked: true, backup: res.data || null }
    }
    if (res.corrupt) logCrashContext(`layout:load: damaged layout kept as ${res.corrupt}`)
    if (res.from === 'backup') log.warn('app', 'layout: restored from the previous copy (the file was damaged)')
    return res.data
  } catch (err) {
    logCrashContext(`layout:load failed: ${err.message}`)
    // Unread is not empty: the window must not start blank and save over it.
    return { locked: true, backup: null }
  }
})

ipcMain.on('layout:save', (_evt, data) => {
  try {
    writeJsonSafe(layoutFile(), data, isLayout)
  } catch {
    /* best-effort: a failed save just means last layout is reused next launch */
  }
})

// ---------------------------------------------------------------------------
// Task-board persistence
// ---------------------------------------------------------------------------
// The kanban task board is stored in its own task-board.json (see
// taskBoardPersistence.js) so it never collides with workspace-layout.json.
// opts.withLedger: -> { tasks, appliedRequests } instead of the task list.
ipcMain.handle('taskboard:load', (_evt, opts) => {
  const withLedger = !!(opts && opts.withLedger)
  try {
    return withLedger ? loadBoard(app.getPath('userData')) : loadTasks(app.getPath('userData'))
  } catch (err) {
    logCrashContext(`taskboard:load failed: ${err.message}`)
    // Unread is not empty: the window shows nothing and saves nothing.
    return { locked: true, tasks: [], appliedRequests: [] }
  }
})

// The task list, or { tasks, appliedRequests } (saved together).
ipcMain.handle('taskboard:save', (_evt, board) => {
  try {
    if (Array.isArray(board)) saveTasks(app.getPath('userData'), board)
    else saveTasks(app.getPath('userData'), board && board.tasks, board && board.appliedRequests)
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
    title: opts.title || t('main.dialog.pickFolder', 'Choose a project folder'),
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
      return { ok: false, error: t('main.error.noProjectFolder', 'The project folder does not exist.') }
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
        resolve({ ok: false, error: t('main.error.openNotes', 'Could not open the notes: {{error}}', { error: e.message }) })
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
ipcMain.handle('app:systemLocale', async () => {
  if (windowsUiLanguage !== null) return windowsUiLanguage
  windowsUiLanguage = ''
  if (process.platform === 'win32') {
    try {
      windowsUiLanguage = (
        await runQuiet(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', '[Globalization.CultureInfo]::CurrentUICulture.Name'],
          { timeout: 10000 }
        )
      ).stdout.trim()
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
// The sub-agents an agent pane's conversation started (title, time, tokens).
ipcMain.handle('agents:children', async (_evt, q = {}) => {
  try {
    return await accountSessions.children(q)
  } catch (err) {
    log.warn('sessions', `children: ${err.message}`)
    return []
  }
})
// A pane's title from its conversation (Settings > Agents, automatic titles).
ipcMain.handle('sessions:title', async (_evt, q = {}) => {
  try {
    return await accountSessions.title(q)
  } catch (err) {
    log.warn('sessions', `title: ${err.message}`)
  }
  return ''
})
ipcMain.handle('sessions:claudeExists', async (_evt, id, scope) => {
  try { return await accountSessions.claudeExists(id, scope) } catch { return false }
})
ipcMain.handle('sessions:findCodex', async (_evt, q = {}) => {
  try { return await accountSessions.find({ ...q, agent: 'codex' }) } catch { return null }
})
// Gemini: is there a conversation to resume? OpenCode, Cline, Copilot, Codex:
// the session a pane started (they choose its id), found after it starts.
ipcMain.handle('sessions:geminiExists', (_evt, id) => geminiSessionExists(id))
ipcMain.handle('sessions:qwenExists', (_evt, id) => qwenSessionExists(id))
// The conversation each agent pane is in now, as its hooks reported it
// (teamMcp/server.cjs reportSession): { paneId: { agent, sessionId, source, at } }.
const sessionsDir = () => join(app.getPath('appData'), 'tessel-team', 'sessions')
const agentStateDir = join(app.getPath('userData'), 'agent-status')
const usageStats = createUsageStatsTracker({ file: join(app.getPath('userData'), 'stats-usage.json') })
const agentStateStore = createAgentStateStore({
  dir: agentStateDir,
  onChange: (states) => {
    send('agents:state', states)
    void usageStats.observe(states).catch(() => {})
  }
})
ipcMain.handle('statsUsage:summary', () => usageStats.summary())
ipcMain.handle('statsUsage:copyImage', (_event, bytes) => copyUsageImage(bytes, { nativeImage, clipboard }))

// --- Language (src/main/i18n.js) ---------------------------------------------
// The interface tells the main process the language it shows ('en', 'fr');
// until it does, Windows' display languages decide.
function systemLanguages() {
  try {
    const list = typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages() : []
    return list && list.length ? list : [app.getLocale()]
  } catch {
    return []
  }
}
ipcMain.on('app:setUiLanguage', (_evt, language) => {
  setMainLanguage(typeof language === 'string' ? language : 'system', systemLanguages())
})
app.whenReady().then(() => {
  setMainLanguage('system', systemLanguages())
})

app.whenReady().then(() => {
  powerMonitor.on('suspend', () => { void usageStats.suspend() })
  powerMonitor.on('resume', () => { void usageStats.resume() })
})
let scanningAgentStates = false
const agentStateTimer = setInterval(async () => {
  if (scanningAgentStates) return
  scanningAgentStates = true
  try { await agentStateStore.scan() } catch { /* next bounded scan retries */ }
  finally { scanningAgentStates = false }
}, 500)
agentStateTimer.unref()
app.on('will-quit', () => { clearInterval(agentStateTimer); void agentStateStore.dispose() })
ipcMain.handle('agents:states', () => agentStateStore.snapshot())
ipcMain.on('agents:screen', (_evt, q) => {
  if (!q || typeof q !== 'object') return
  void agentStateStore.observe(q.paneId, q.launchToken, { event: q.event, reset: q.reset }).catch(() => {})
})
function prepareStatus(provider, env = process.env) {
  return prepareAgentStateHooks({ provider, env, source: teamServerSource, sharedDir: join(app.getPath('appData'), 'tessel-team') })
}
ipcMain.handle('agents:prepareStatus', (_evt, provider) => prepareStatus(provider))
ipcMain.handle('sessions:reported', () => {
  const dir = sessionsDir()
  const out = {}
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return out
  }
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(join(dir, n), 'utf8'))
      if (r && typeof r.sessionId === 'string') {
        // The inbox key stays in this process (agents:inbox).
        const { inboxToken, ...shown } = r
        out[n.slice(0, -5)] = { ...shown, inbox: !!(r.inbox && inboxToken) }
      }
    } catch {
      /* being written: next time */
    }
  }
  return out
})
// A message into a Claude Code session's own inbox (agentInbox.js), only
// for the conversation the pane is in now. -> { ok } or { ok: false, error }
ipcMain.handle('agents:inbox', (_evt, q = {}) =>
  postToInbox({ sessionsDir: sessionsDir(), paneId: q && q.paneId, sessionId: q && q.sessionId, text: q && q.text })
)
ipcMain.handle('sessions:find', async (_evt, q = {}) => {
  try {
    return await accountSessions.find(q || {})
  } catch {
    return null
  }
})
ipcMain.handle('sessions:list', async (_evt, q = {}) => {
  try { return await accountSessions.list(q) } catch { return [] }
})
// The model an agent pane uses (for its header), or null.
ipcMain.handle('agents:model', async (_evt, q = {}) => {
  try {
    return await agentModelLive(q || {})
  } catch {
    return null
  }
})

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

// Keep the computer awake (Settings > Agents): the renderer says when, as
// it knows which agents are working. The screen may still turn off.
let keepAwakeId = null
ipcMain.handle('power:keepAwake', (_evt, on) => {
  if (on === true && keepAwakeId === null) keepAwakeId = powerSaveBlocker.start('prevent-app-suspension')
  if (on !== true && keepAwakeId !== null) {
    powerSaveBlocker.stop(keepAwakeId)
    keepAwakeId = null
  }
  return keepAwakeId !== null
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
  safe(({ cwd, label, options } = {}) => createWorktree(cwd, label, options))
)
const accountOptions = { userData: app.getPath('userData'), runLogin: createProviderLogin() }
registerIssueServices({ ipcMain, dir: join(app.getPath('userData'), 'linear'), safeStorage, onPrCreated: (url) => usageStats.prCreated(url) })
// Remote hosts over SSH (remoteHosts.js): Settings > SSH Hosts, the status bar.
const remoteHosts = createRemoteHosts({ dir: app.getPath('userData'), onChange: (states) => send('remoteHosts:state', states) })
registerRemoteHosts({ ipcMain, service: remoteHosts, killPane: (id) => host.send('kill', { id }) })
const accounts = createProviderAccounts({
  claude: createClaudeAccounts(accountOptions),
  codex: createCodexAccounts(accountOptions)
})
ipcMain.handle('accounts:list', safe(() => accounts.list()))
registerProviderUsage({ ipcMain, accounts, userData: app.getPath('userData'), log, listAgents: () => getAgents() })
ipcMain.handle('accounts:loginStatus', safe((id) => accounts.loginStatus(id)))
ipcMain.handle('accounts:launchEnv', safe((query) => typeof query === 'string'
  ? accounts.launchEnv(query) : accounts.launchEnv(query?.provider, query?.accountId)))
const accountSessions = createAccountSessions({ accounts })
const accountUsage = createAccountUsage({ accounts, userData: app.getPath('userData') })
ipcMain.handle('usage:get', safe(() => accountUsage.usage()))
// Claude Code's usage report from its own conversation files (tokens, estimated cost).
const claudeUsageReport = createClaudeUsageReport()
ipcMain.handle('usage:claudeReport', safe((query) => claudeUsageReport(query)))
// Codex's usage report from its own session files (tokens, requests).
ipcMain.handle('usage:codexReport', safe((query) => accountUsage.report(query)))
ipcMain.handle('review:info', safe(reviewInfo))
ipcMain.handle('review:diff', safe(reviewDiff))
ipcMain.handle('review:merge', safe(reviewMerge))
ipcMain.handle('review:remove', safe(reviewRemove))
ipcMain.handle('review:commit', safe(reviewCommit))
ipcMain.handle('review:push', safe(reviewPush))
// Source control (the Changes tab, after Orca's): status, stage, unstage,
// discard (untracked files to the Recycle Bin), commit, push, pull, and the
// two sides of a file's diff. Any folder in a repository: the project or a
// task's copy.
ipcMain.handle('scm:status', safe((q) => scm.scmStatus(q || {})))
ipcMain.handle('scm:stage', safe((q) => scm.scmStage(q || {})))
ipcMain.handle('scm:unstage', safe((q) => scm.scmUnstage(q || {})))
ipcMain.handle('scm:discard', safe((q) => scm.scmDiscard(q || {}, (p) => shell.trashItem(p))))
ipcMain.handle('scm:commit', safe((q) => scm.scmCommit(q || {})))
ipcMain.handle('scm:push', safe((q) => scm.scmPush(q || {})))
ipcMain.handle('scm:pull', safe((q) => scm.scmPull(q || {})))
ipcMain.handle('scm:fetch', safe((q) => scm.scmFetch(q || {})))
ipcMain.handle('scm:sync', safe((q) => scm.scmSync(q || {})))
ipcMain.handle('scm:fileVersions', safe((q) => scm.scmFileVersions(q || {})))
// A commit message written by an agent from the staged diff (Orca's Generate).
ipcMain.handle('scm:generate', safe(async (q) => {
  const d = await scm.scmStagedDiff(q || {})
  if (!d.ok) return d
  const res = await runHeadless(q && q.agent, scm.commitPrompt(d.diff), { cwd: d.top, key: d.top })
  if (!res.ok) return res
  const message = scm.cleanGeneratedMessage(res.text)
  return message ? { ok: true, message } : { ok: false, error: t('main.error.noCommitMessage', 'The agent gave no message.') }
}))
ipcMain.handle('scm:cancelGenerate', safe(async (q) => {
  const r = await scm.repoOf(q && q.root)
  return { ok: !r.error && cancelHeadless(r.top) }
}))
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
// This window, among Tessel windows sharing a project's team folder: its
// data folder (the dev build and the installed app have different ones).
const TEAM_OWNER = crypto.createHash('sha1').update(app.getPath('userData').toLowerCase()).digest('hex').slice(0, 12)
ipcMain.handle('team:current', safe((args) => writeCurrentTeams({ ...args, owner: TEAM_OWNER })))
ipcMain.handle('team:retire', safe((args) => retireOldTeams({ ...args, owner: TEAM_OWNER })))
ipcMain.handle('team:tasks', safe(publishTeamTasks))
ipcMain.handle('team:roster', safe(writeRoster))
ipcMain.handle('team:requests', safe(takeTeamRequests))
ipcMain.handle('team:requests-done', safe(finishTeamRequests))
ipcMain.handle('team:board-panes', safe((args) => writeBoardPanes({ ...args, owner: TEAM_OWNER })))
ipcMain.handle('team:message-status', safe(messageStatuses))
ipcMain.handle('team:tools-alive', safe(toolsAlive))

// A Codex config.toml Tessel is about to write, checked by Codex itself in a
// throwaway CODEX_HOME. -> { ok, error }
function validateCodexConfig(text) {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-codex-check-'))
  fs.writeFileSync(join(home, 'config.toml'), text, 'utf8')
  const script = [
    "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    `$env:CODEX_HOME = '${home.replace(/'/g, "''")}'`,
    // codex.cmd, not the npm codex.ps1 shim (it cannot run where scripts are
    // blocked); the arguments are plain words, safe through cmd.exe.
    '& (Get-Command -CommandType Application -Name codex | Select-Object -First 1).Source mcp list --json | Out-Null',
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

// How each agent gets its team messages (teamHooksStatus.js), read-only.
ipcMain.handle(
  'team:hooksStatus',
  safe(async () => {
    const codex = await accounts.sessionEnv('codex')
    const claude = await accounts.sessionEnv('claude')
    return hooksStatus({
      sessionsDir: sessionsDir(),
      scriptPath: join(app.getPath('appData'), 'tessel-team', 'tessel-team-mcp.cjs'),
      configDirs: {
        codex: codex.env?.CODEX_HOME || process.env.CODEX_HOME || join(os.homedir(), '.codex'),
        claude: claude.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude')
      },
      states: agentStateStore.snapshot()
    })
  })
)

// Team tools for agents (background messages, never typed into terminals):
// the MCP server script, registered for Claude Code and Codex, plus Claude
// Code hooks. -> { ok, changed: [...], errors: [...] }
ipcMain.handle(
  'team:install',
  safe(async () => {
    // Shared by the dev build and the installed app (see teamInstall.js).
    const script = writeServerScript(join(app.getPath('appData'), 'tessel-team'), teamServerSource)
    const changed = []
    const errors = []
    if (!claudeServerPresent(script)) {
      // Registered with another path (an older version, the other build):
      // replaced, since Claude Code refuses to add a name that exists.
      // The old entry is put back if the new one cannot be added, so Claude
      // Code is never left without the team tools.
      let before = null
      if (claudeServerExists()) {
        try {
          before = JSON.parse(fs.readFileSync(join(os.homedir(), '.claude.json'), 'utf8')).mcpServers[SERVER_NAME]
        } catch {
          before = null
        }
        await removeMcp({ agent: 'claude', name: SERVER_NAME, scope: 'user' })
      }
      const res = await addMcp({
        agent: 'claude',
        name: SERVER_NAME,
        transport: 'stdio',
        commandLine: `node "${script}"`,
        scope: 'user'
      })
      if (res.ok) changed.push('Claude Code: MCP server tessel-team')
      else {
        errors.push(`Claude Code: ${res.error}`)
        if (before && before.command) {
          const words = [before.command, ...(Array.isArray(before.args) ? before.args : [])]
          await addMcp({
            agent: 'claude',
            name: SERVER_NAME,
            transport: 'stdio',
            commandLine: words.map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(' '),
            scope: 'user'
          })
        }
      }
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
    // Codex hooks: they tell Tessel the conversation Codex is in (after /new,
    // /resume, a restart), so it resumes that one. Only where Codex is installed.
    try {
      const codex = (await getAgents()).find((a) => a.id === 'codex')
      if (codex && codex.available) {
        const r = installCodexHooks(script)
        if (r.error) errors.push(`Codex hooks: ${r.error}`)
        else if (r.changed) changed.push('Codex: hooks (current conversation)')
      }
    } catch (err) {
      errors.push(`Codex hooks: ${err.message}`)
    }
    // Gemini CLI hooks: its conversation, and its team messages while it works
    // and when it finishes a turn (never typed). Only where it is installed.
    try {
      const gemini = (await getAgents()).find((a) => a.id === 'gemini')
      if (gemini && gemini.available) {
        const r = installGeminiHooks(script)
        if (r.error) errors.push(`Gemini CLI hooks: ${r.error}`)
        else if (r.changed) changed.push('Gemini CLI: hooks (team messages, current conversation)')
      }
    } catch (err) {
      errors.push(`Gemini CLI hooks: ${err.message}`)
    }
    // Copilot CLI hooks, in their own file: the same, where it is installed.
    try {
      const copilot = (await getAgents()).find((a) => a.id === 'copilot')
      if (copilot && copilot.available) {
        const r = installCopilotHooks(script)
        if (r.error) errors.push(`Copilot CLI hooks: ${r.error}`)
        else if (r.changed) changed.push('Copilot CLI: hooks (team messages, current conversation)')
      }
    } catch (err) {
      errors.push(`Copilot CLI hooks: ${err.message}`)
    }
    // OpenCode plugin: its conversation, messages after a tool, and when idle
    // (woken through its own API, never typed). Where it is installed.
    try {
      const opencode = (await getAgents()).find((a) => a.id === 'opencode')
      if (opencode && opencode.available) {
        const r = installOpencodePlugin(script)
        if (r.error) errors.push(`OpenCode plugin: ${r.error}`)
        else if (r.changed) changed.push('OpenCode: plugin (team messages, current conversation)')
      }
    } catch (err) {
      errors.push(`OpenCode plugin: ${err.message}`)
    }
    try {
      const kimi = (await getAgents()).find((a) => a.id === 'kimi')
      if (kimi && kimi.available) {
        const r = await installKimiHooks(script)
        if (r.error) errors.push(`Kimi Code hooks: ${r.error}`)
        else if (r.changed) changed.push('Kimi Code: hooks (team messages, current conversation)')
      }
    } catch {
      errors.push('Kimi Code hooks: installation could not be completed.')
    }
    // Gemini CLI, Qwen Code, Copilot CLI, OpenCode, Cline: in their settings file,
    // for those installed here (a file Tessel cannot read is left alone).
    for (const agent of JSON_AGENTS) {
      const preset = (await getAgents()).find((a) => a.id === agent)
      if (!preset || !preset.available) continue
      const r = setJsonAgentServer(agent, SERVER_NAME, teamToolsEntry(agent, script))
      if (!r.ok) errors.push(`${preset.name}: ${r.error}`)
      else if (r.changed) changed.push(`${preset.name}: MCP server tessel-team`)
    }
    // The task board rule in each installed agent's persistent memory
    // (CLAUDE.md, AGENTS.md...: read every session), see agentMemory.js.
    for (const preset of await getAgents()) {
      if (!preset.available || preset.custom) continue
      const r = writeBoardRule(preset.id)
      if (r.error) errors.push(`${preset.name}: memory file ${r.file}: ${r.error}`)
      else if (r.changed) changed.push(`${preset.name}: task board rule in ${r.file}`)
    }
    if (changed.length) log.info('team', `team tools set up: ${changed.join('; ')}`)
    if (errors.length) log.error('team', `team tools: ${errors.join('; ')}`)
    // The tools' version: an agent started with an older one is restarted
    // (in place, when quiet) to load the new tools.
    // The version agents run: the shared file's (another build may have put
    // a newer one there).
    let installed = teamServerSource
    try {
      installed = fs.readFileSync(script, 'utf8')
    } catch {
      // not readable: ours
    }
    const version = (/const VERSION = '([^']+)'/.exec(installed) || [])[1] || null
    return { ok: errors.length === 0, script, changed, errors, version }
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

// Agent CLI updates (agentUpdates.js): checked in the background a while
// after start, then every few hours (latest versions cached 6 h), and on
// demand. The window shows them in Settings > Agents and runs the updates.
const agentUpdates = createAgentUpdates({
  getAgents: () => getAgents(),
  which: (bin) => whichFresh(bin),
  shell: (line) =>
    process.platform === 'win32'
      ? runQuiet('cmd.exe', ['/d', '/s', '/c', line], { env: freshEnv(), timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
      : runQuiet('sh', ['-c', line], { env: freshEnv(), timeout: 60000, maxBuffer: 8 * 1024 * 1024 }),
  runFile: (file, args) => runQuiet(file, args, { env: freshEnv(), timeout: 20000 }),
  cacheFile: join(app.getPath('userData'), 'agent-updates.json'),
  home: os.homedir(),
  registry: process.env.TESSEL_AGENT_REGISTRY || undefined,
  fakeFile: process.env.TESSEL_AGENT_UPDATES_FAKE || null,
  log: (level, message) => log[level === 'warn' ? 'warn' : 'info']('agents', message)
})
async function checkAgentUpdates(opts = {}) {
  const r = await agentUpdates.check(opts)
  const found = Object.values(r.agents || {}).filter((a) => a.update)
  log.info('agents', `update check: ${found.length ? found.map((a) => `${a.id} ${a.installed} -> ${a.latest}`).join(', ') : 'all up to date'}`)
  send('agentUpdates:changed', r)
  return r
}
ipcMain.handle('agentUpdates:status', () => agentUpdates.status())
ipcMain.handle('agentUpdates:check', (_evt, q = {}) =>
  checkAgentUpdates({ force: !!(q && q.force) }).catch((err) => ({ error: err.message, agents: {}, newlyFound: [] }))
)
const AGENT_UPDATE_FIRST_MS = Number(process.env.TESSEL_AGENT_UPDATES_FIRST_MS) || 2 * 60 * 1000
const AGENT_UPDATE_EVERY_MS = 4 * 60 * 60 * 1000
const firstAgentCheck = setTimeout(() => checkAgentUpdates().catch(() => {}), AGENT_UPDATE_FIRST_MS)
if (firstAgentCheck.unref) firstAgentCheck.unref()
const agentCheckTimer = setInterval(() => checkAgentUpdates().catch(() => {}), AGENT_UPDATE_EVERY_MS)
if (agentCheckTimer.unref) agentCheckTimer.unref()

// Codex 0.157+ runs its tools through a shared background server (daemon) by
// default. In Tessel that breaks the team tools: the daemon does not get each
// pane's TESSEL_PANE_ID, and it closes stdio MCP servers right after a session
// starts ("Transport closed"). Codex started by Tessel runs without it
// (--no-daemon), when the installed Codex knows that option. Checked once.
let codexNoDaemon = null
function codexSupportsNoDaemon() {
  if (!codexNoDaemon) {
    codexNoDaemon = new Promise((resolve) => {
      execFile(
        process.platform === 'win32' ? 'cmd.exe' : 'codex',
        process.platform === 'win32' ? ['/d', '/s', '/c', 'codex --help'] : ['--help'],
        { windowsHide: true, timeout: 20000, env: freshEnv() },
        (err, stdout) => {
          const knows = /--no-daemon\b/.test(String(stdout || ''))
          // Not installed yet, or too slow this time: asked again next time.
          if (!knows && err) codexNoDaemon = null
          resolve(knows)
        }
      )
    })
  }
  return codexNoDaemon
}
ipcMain.handle('agents:codex-no-daemon', () => codexSupportsNoDaemon())
// Which agent CLI runs inside each shell pane (started by hand in it).
ipcMain.handle('agents:detect', safe(detectAgents))
// Live ports of each workspace copy (sidebar plug, status bar), like Orca.
const portScanner = createPortScanner()
ipcMain.handle('ports:scan', safe((q) => portScanner.scan(q || {})))
// Stop Process never stops Tessel itself: none of its processes (main,
// renderers, GPU, utility, terminal host), nothing they run outside a
// terminal, nothing started from Tessel's executable or its folders.
ipcMain.handle(
  'ports:kill',
  safe((q) => {
    const hostPids = ptyHostPids()
    let metricPids = []
    try {
      metricPids = app.getAppMetrics().map((m) => m.pid)
    } catch {}
    return portScanner.kill(q || {}, {
      selfPids: [process.pid, ...metricPids, ...hostPids],
      terminalHostPids: hostPids,
      selfExe: process.execPath,
      appRoots: [dirname(process.execPath), app.getAppPath()]
    })
  })
)
// The status bar's Resource Manager: Tessel's processes and each terminal's
// process tree (Orca's memory collector).
const resourceCollector = createResourceCollector({ cpuCount: os.cpus().length })
ipcMain.handle(
  'resources:snapshot',
  safe((q) =>
    resourceCollector.snapshot({
      appMetrics: app.getAppMetrics(),
      ptys: Array.isArray(q && q.ptys) ? q.ptys.filter((t) => t && typeof t.id === 'string' && Number.isSafeInteger(t.pid)).slice(0, 500) : [],
      hostPids: ptyHostPids()
    })
  )
)
// Which of these commands are on PATH (fresh PATH, so just-installed tools
// show up). Returns { bin: true|false }.
ipcMain.handle('tools:check', async (_evt, bins) => {
  const list = Array.isArray(bins) ? bins.slice(0, 50) : []
  const found = await Promise.all(list.map((b) => commandExists(b)))
  return Object.fromEntries(list.map((b, i) => [b, found[i]]))
})
// Full path of a command on the fresh PATH (null if missing).
async function whichFresh(bin) {
  const res = await runQuiet('where.exe', [bin], { env: freshEnv(), timeout: 10000 })
  if (!res.ok) return null
  return (
    res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || null
  )
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

// What Tessel itself needs, checked on this machine (tesselNeeds.js).
ipcMain.handle(
  'tools:needs',
  safe(async () => {
    const [nodePath, gitPath, uvx, agentList] = await Promise.all([
      whichFresh('node'),
      whichFresh('git'),
      commandExists('uvx'),
      getAgents()
    ])
    const node = nodePath ? { path: nodePath, version: (await runFile(nodePath, ['--version'])).out.trim() } : null
    let git = null
    if (gitPath) {
      const name = await runFile(gitPath, ['config', '--global', 'user.name'])
      const email = await runFile(gitPath, ['config', '--global', 'user.email'])
      git = { path: gitPath, configured: !!(name.ok && name.out.trim() && email.ok && email.out.trim()) }
    }
    const claude = agentList.find((a) => a.id === 'claude' && a.available)
    // An npm launcher (claude.cmd): through cmd, on the fresh PATH.
    const claudeVersion = claude ? (await runFile('cmd.exe', ['/d', '/c', 'claude', '--version'])).out.trim() : null
    const scriptPath = join(app.getPath('appData'), 'tessel-team', 'tessel-team-mcp.cjs')
    let script = { exists: false }
    try {
      const text = fs.readFileSync(scriptPath, 'utf8')
      script = { exists: true, version: (/const VERSION = '([^']+)'/.exec(text) || [])[1] || null }
    } catch {
      /* not set up yet */
    }
    let hooks
    try {
      hooks = hooksStatus({ sessionsDir: sessionsDir(), scriptPath })
    } catch (err) {
      hooks = { error: err.message }
    }
    return { ok: true, rows: assessNeeds({ node, git, uvx, agents: agentList, claudeVersion, script, hooks }) }
  })
)

// Setup status for tools that need a one-time step, so Tools only offers the
// step when it's still needed: GitHub CLI sign-in and git's name/email.
ipcMain.handle('tools:status', async () => {
  const status = {}
  const gh = await whichFresh('gh')
  if (gh) {
    const res = await runFile(gh, ['auth', 'status', '--hostname', 'github.com'])
    const m = /account\s+(\S+)/i.exec(res.out)
    status.gh = { signedIn: res.ok, account: res.ok && m ? m[1] : null }
  }
  const git = await whichFresh('git')
  if (git) {
    const name = await runFile(git, ['config', '--global', 'user.name'])
    const email = await runFile(git, ['config', '--global', 'user.email'])
    const n = name.ok ? name.out.trim() : ''
    const e = email.ok ? email.out.trim() : ''
    status.git = { configured: !!(n && e), name: n || null, email: e || null }
  }
  return status
})

ipcMain.handle('tools:refreshPath', async () => {
  freshPath = await readFreshPath()
  toolDirs = null
  agentCache = null
  codexNoDaemon = null
  return true
})

// Re-read PATH and re-detect agents (after installing one).
ipcMain.handle('agents:refresh', async (_evt, custom) => {
  freshPath = await readFreshPath()
  toolDirs = null
  agentCache = null
  codexNoDaemon = null // an agent just installed or updated
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
  const dir = PASTE_DIR
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
// [Image #N] clicked in a Claude Code pane: the image Tessel pasted, or the
// one in the pane's conversation, for Tessel's own viewer. -> { ok, file, src }
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
ipcMain.handle('images:get', async (_evt, q = {}) => {
  try {
    let file = q && isPastedImage(q.file) && fs.existsSync(q.file) ? q.file : null
    if (!file && q && typeof q.sessionId === 'string') file = await claudeImageFile({ sessionId: q.sessionId, n: Number(q.n) })
    if (!file) return { ok: false }
    const data = fs.readFileSync(file)
    if (data.length > 40 * 1024 * 1024) return { ok: false, error: t('main.error.imageTooLarge', 'The image is too large to show.') }
    const mime = IMAGE_MIME[file.split('.').pop().toLowerCase()] || 'image/png'
    return { ok: true, file, src: `data:${mime};base64,${data.toString('base64')}` }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
// "Open in viewer" from Tessel's image popup: the system's image app.
ipcMain.handle('images:openExternal', async (_evt, file) => {
  if (!isPastedImage(file) || !fs.existsSync(file)) return { ok: false }
  const err = await shell.openPath(file)
  return err ? { ok: false, error: err } : { ok: true }
})
// File references in a terminal (fileOpen.js): which exist, and opening one
// at its line in VS Code when installed, else in its default program.
ipcMain.handle('files:resolve', (_evt, q = {}) => resolveFiles(q || {}))
ipcMain.handle('files:list', safe((root) => listProjectFiles(root)))
ipcMain.handle('files:open', async (_evt, q = {}) => {
  const file = q && typeof q.file === 'string' ? q.file : ''
  let ok = false
  try {
    ok = !!file && fs.statSync(file).isFile()
  } catch {
    ok = false
  }
  if (!ok) return { ok: false, error: t('main.error.fileNotFound', 'The file was not found.') }
  const line = Number.isInteger(q.line) && q.line > 0 ? q.line : null
  const col = Number.isInteger(q.col) && q.col > 0 ? q.col : null
  // VS Code's launcher is a .cmd (run through cmd): never with a path cmd
  // could read as a command; such a file opens in its default program.
  if (!/[&|<>^%"]/.test(file) && (await commandExists('code'))) {
    const res = await runQuiet('cmd.exe', ['/d', '/c', 'code', '-g', codeGotoArg(file, line, col)], { env: freshEnv(), timeout: 20000 })
    if (res.ok) return { ok: true, with: 'code' }
  }
  const err = await shell.openPath(file)
  return err ? { ok: false, error: err } : { ok: true, with: 'default' }
})
// The file explorer (explorer.js): folders, git status, a few changes, and a
// watch per project (the window is told when files change).
ipcMain.handle('explorer:list', safe((q) => explorer.listDir(q || {})))
ipcMain.handle('explorer:status', safe((q) => explorer.projectStatus(q || {})))
// Search the project: file names (also in folders not opened yet), or contents.
ipcMain.handle('explorer:searchNames', safe((q) => explorer.searchNames(q || {})))
ipcMain.handle('explorer:searchContent', safe((q) => explorer.searchContent(q || {})))
ipcMain.handle('explorer:create', safe((q) => explorer.create(q || {})))
ipcMain.handle('explorer:rename', safe((q) => explorer.rename(q || {})))
ipcMain.handle('explorer:trash', safe((q) => explorer.trash(q || {}, (p) => shell.trashItem(p))))
ipcMain.handle('explorer:reveal', safe((q) => {
  const p = q && explorer.inside(q.root, q.path)
  if (!p || !fs.existsSync(p)) return { ok: false, error: t('main.error.notFound', 'Not found.') }
  shell.showItemInFolder(p)
  return { ok: true }
}))
const explorerWatches = new Map() // root -> stop
ipcMain.handle('explorer:watch', (_evt, root) => {
  if (typeof root !== 'string' || !isAbsolute(root) || !fs.existsSync(root)) return { ok: false }
  if (!explorerWatches.has(root)) {
    // One project watched at a time is enough (the one shown).
    for (const [r, stop] of explorerWatches) {
      stop()
      explorerWatches.delete(r)
    }
    explorerWatches.set(
      root,
      explorer.watchProject(root, (r) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('explorer:changed', r)
      })
    )
  }
  return { ok: true }
})
ipcMain.handle('explorer:unwatch', () => {
  for (const stop of explorerWatches.values()) stop()
  explorerWatches.clear()
  return { ok: true }
})

// The file viewer (fileView.js): read a file to show it; a PDF in its own window.
ipcMain.handle('files:view', (_evt, file) => {
  try {
    return readForView(file)
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
ipcMain.handle('files:viewImage', (_evt, file) => {
  try {
    return readImageForView(file)
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
ipcMain.handle('files:openPdf', (_evt, file) =>
  openPdfWindow(BrowserWindow, file, { icon: fs.existsSync(appIconPath()) ? appIconPath() : null })
)

// Tessel's code editor (editorFiles.js): read, write (atomic), the last
// committed version, and a watch on the open files (the window is told when
// one changes on disk; Tessel's own saves are not reported back).
const editorWatcher = createFileWatcher((change) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('editor:changed', change)
})
ipcMain.handle('editor:read', safe((file) => readForEdit(file)))
ipcMain.handle('editor:stat', safe((file) => statForEdit(file)))
ipcMain.handle('editor:write', safe(async (q) => {
  const res = await writeForEdit(q || {})
  if (res.ok) editorWatcher.noteWritten(q.file, res.sig)
  return res
}))
ipcMain.handle('editor:head', safe((file) => headContent(file)))
ipcMain.handle('editor:watch', safe((paths) => ({ ok: true, count: editorWatcher.set(paths) })))
// Closing the window with unsaved editor files: the window asks first (Save,
// Don't Save, Cancel). Quitting for an update was asked about beforehand.
let editorDirtyCount = 0
let editorCloseAllowed = false
let appQuitting = false
ipcMain.on('editor:dirty', (event, n) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  editorDirtyCount = Number.isInteger(n) && n > 0 ? n : 0
})
ipcMain.on('editor:closeWindow', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
  editorCloseAllowed = true
  mainWindow.close()
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

function hostPidFile() {
  return join(app.getPath('userData'), 'pty-host.pid')
}

// The terminal host's PID, as it wrote it ([] when unknown).
function ptyHostPids() {
  try {
    const pid = parseInt(fs.readFileSync(hostPidFile(), 'utf8'), 10)
    return pid > 0 ? [pid] : []
  } catch {
    return []
  }
}

// A host that holds the pipe but no longer answers (stuck while closing its
// terminals): ended so a new one can start. Only the PID the host wrote, and
// only if that process really is this build's terminal host (a PID can be
// reused by another program). -> true once it is gone.
async function endStuckHost() {
  if (process.platform !== 'win32') return false
  let pid = 0
  try {
    pid = parseInt(fs.readFileSync(hostPidFile(), 'utf8'), 10)
  } catch {
    log.error('pty', 'the stuck terminal host left no PID: end it in Task Manager (electron.exe running ptyHost.js)')
    return false
  }
  if (!(pid > 0) || pid === process.pid) return false
  const q = await runQuiet('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
  ])
  const script = join(__dirname, 'ptyHost.js').toLowerCase()
  if (!q.stdout.toLowerCase().includes(script)) {
    log.error('pty', `the stuck terminal host is not PID ${pid} any more: not ending it`)
    return false
  }
  log.warn('pty', `ending the stuck terminal host (pid ${pid})`)
  await runQuiet('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
  try {
    fs.rmSync(hostPidFile(), { force: true })
  } catch {
    /* rewritten by the next host */
  }
  await new Promise((r) => setTimeout(r, 500))
  return true
}

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
      TESSEL_PTYHOST_PIDFILE: hostPidFile(),
      TESSEL_LOG_DIR: log.dir
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.on('error', (err) => log.error('pty', `could not start terminal host: ${err.message}`))
  child.unref()
}

// Installs run from Tessel: their output is logged, their end told to the
// window (installLog.js).
const installLogs = createInstallLogs({
  dir: log.dir,
  appVersion: app.getVersion(),
  notify: (r) => {
    log[r.ok === false ? 'warn' : 'info']('install', `${r.name}: ${r.ok === true ? 'succeeded' : r.ok === false ? 'FAILED' : 'unknown'}${r.reason ? ` (${r.reason})` : ''}, log ${r.file}`)
    send('install:result', r)
  }
})
ipcMain.handle('install:logStart', (_evt, q = {}) => installLogs.start(q || {}))
ipcMain.handle('install:openLog', async (_evt, file) => {
  if (!installLogs.isLog(file)) return { ok: false, error: t('main.error.notInstallLog', 'Not an install log.') }
  const err = await shell.openPath(file)
  return err ? { ok: false, error: err } : { ok: true }
})
ipcMain.handle('install:showLog', (_evt, file) => {
  if (!installLogs.isLog(file)) return { ok: false }
  shell.showItemInFolder(file)
  return { ok: true }
})

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
  endStuckHost,
  log,
  // Output is batched per terminal (every ~8 ms) instead of one message per
  // chunk: a busy agent can print thousands of small chunks a second.
  onData: (id, data) => {
    installLogs.onData(id, data)
    queueData(id, data)
  },
  onExit: (id, exitCode, signal, pid) => {
    const info = ptyInfo.get(id)
    if (pid && info?.pid && pid !== info.pid) return // a delayed exit from the previous execution
    void agentStateStore.unregister(id, info?.agentLaunchToken).catch(() => {})
    installLogs.onExit(id, exitCode)
    remoteHosts.paneExited(id, exitCode)
    flushData() // deliver the last output before the exit notice
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
    for (const id of ptyInfo.keys()) {
      void agentStateStore.unregister(id).catch(() => {})
      remoteHosts.paneExited(id, -1)
      send('pty:exit', { id, exitCode: -1, signal: 0 })
    }
    ptyInfo.clear()
  }
})

ipcMain.handle('pty:create', async (_evt, opts = {}) => {
  const { id, shellId, cols = 80, rows = 24, cwd, projectDir } = opts
  if (!id) throw new Error('pty:create requires an id')
  const shell = getShells().find((s) => s.id === shellId) || defaultShell()
  // A pane on a remote host runs ssh.exe with the argv built from the saved host.
  const remote = opts.remoteHostId ? remoteHosts.launchFor(String(opts.remoteHostId)) : null
  if (remote && !remote.ok) return { ok: false, error: remote.error }
  const startDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir()
  const useConpty = shouldUseConpty()
  const backend = useConpty ? 'conpty' : 'winpty'
  // Its agent's variables and its provider account's (see paneEnv.js).
  const env = paneEnv(freshEnv(), opts)
  const agentProvider = ['claude', 'codex'].includes(opts.agentId) ? opts.agentId : null
  const agentLaunchToken = agentProvider ? crypto.randomBytes(16).toString('hex') : null
  const agentStartedAt = Date.now()
  // Do not let inherited Tessel identity bind a nested app to another launch.
  for (const key of Object.keys(env)) if (/^TESSEL_AGENT_/i.test(key)) delete env[key]
  let agentStatusWarning = null
  if (agentProvider) {
    const setup = prepareStatus(agentProvider, env)
    if (!setup.ok) agentStatusWarning = setup.error
  }
  let res
  try {
    res = await host.request('create', {
      id,
      file: remote ? remote.file : shell.file,
      args: remote ? remote.args : shell.args,
      cwd: startDir,
      env: {
        ...env,
        // For the Tessel team tools (teamMcp/server.cjs): which pane this is,
        // and the project its team lives in.
        TESSEL_PANE_ID: String(id),
        ...(agentProvider ? { TESSEL_AGENT_PROVIDER: agentProvider, TESSEL_AGENT_LAUNCH: agentLaunchToken, TESSEL_AGENT_STATE_DIR: agentStateDir } : {}),
        ...(projectDir && isAbsolute(projectDir) && fs.existsSync(projectDir) ? { TESSEL_PROJECT_DIR: projectDir } : {})
      },
      cols,
      rows,
      useConpty,
      // ConPTY is required for full-screen TUIs like Claude Code to redraw on
      // resize. Set TESSEL_USE_WINPTY=1 only as a fallback.
      meta: { shellId: shell.id, shellName: shell.name, backend, cwd: startDir, agentProvider, agentLaunchToken, agentStartedAt, remoteHostId: remote ? remote.target.id : null }
    })
  } catch (err) {
    res = { ok: false, error: err.message }
  }
  if (!res.ok) {
    log.error('pty', `failed to launch ${shell.name} (${shell.file}) in ${startDir}: ${res.error}`)
    return { ok: false, error: t('main.error.launchShell', 'Failed to launch {{shell}}: {{error}}', { shell: shell.name, error: res.error }) }
  }
  ptyInfo.set(id, { shellId: shell.id, shellName: shell.name, backend, pid: res.pid, agentLaunchToken })
  if (remote) remoteHosts.paneStarted(id, remote.target.id)
  if (agentProvider) {
    try { await agentStateStore.register({ paneId: id, provider: agentProvider, launchToken: agentLaunchToken, startedAt: agentStartedAt }) }
    catch { agentStatusWarning = 'Agent status observations are unavailable.' }
  }
  return {
    ok: true,
    shell: { id: shell.id, name: shell.name },
    backend,
    windowsBuild: windowsBuildNumber(),
    pid: res.pid,
    cwd: startDir,
    agentLaunchToken,
    agentStatusWarning,
    remoteHost: remote ? { id: remote.target.id, label: remote.name } : null
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
  // Output queued here but not sent yet is in the snapshot already.
  pendingData.delete(id)
  ptyInfo.set(id, { shellId: res.shellId, shellName: res.shellName, backend: res.backend, pid: res.pid, agentLaunchToken: res.agentLaunchToken })
  if (res.remoteHostId && !res.exited) remoteHosts.paneStarted(id, res.remoteHostId)
  if (res.agentProvider && res.agentLaunchToken && !res.exited) {
    try { await agentStateStore.register({ paneId: id, provider: res.agentProvider, launchToken: res.agentLaunchToken, startedAt: res.agentStartedAt }) }
    catch { /* renderer shows unknown until an observation can be read */ }
  }
  return {
    ok: true,
    shell: { id: res.shellId, name: res.shellName },
    backend: res.backend,
    windowsBuild: windowsBuildNumber(),
    pid: res.pid,
    cwd: res.cwd,
    exited: !!res.exited,
    exitCode: res.exitCode,
    buffer: res.buffer || '',
    agentLaunchToken: res.agentLaunchToken || null,
    remoteHostId: res.remoteHostId || null
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
  // Every terminal the host really runs (an older host cannot tell: then
  // those known at connection, then those this app attached or created).
  let list = null
  try {
    const res = await host.request('list', {}, 3000)
    if (res && res.ok && Array.isArray(res.ids)) list = res.ids
  } catch {
    list = null
  }
  if (!list) list = hello && hello.ptys ? hello.ptys.map((p) => p.id) : [...ptyInfo.keys()]
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

// Settings > General, "Confirm before closing running terminals": is a
// program running under this terminal's shell? -> { running, names }, or
// { unknown: true } when it can't tell (the renderer then asks).
ipcMain.handle('pty:runningWork', async (_evt, id) => {
  if (!((typeof id === 'string' && id) || Number.isInteger(id))) return { unknown: true }
  let pid = ptyInfo.get(id)?.pid
  if (!pid) {
    const a = await host.request('attach', { id }, 3000).catch(() => null)
    if (a && a.ok && a.exited) return { running: false, names: [] }
    pid = a && a.ok ? a.pid : null
  }
  if (!Number.isInteger(pid) || pid <= 0) return { unknown: true }
  const procs = await listProcessNames()
  if (!procs) return { unknown: true }
  if (!procs.some((p) => p.pid === pid)) return { running: false, names: [] }
  const names = runningWork(procs, pid)
  return { running: names.length > 0, names: [...new Set(names)].slice(0, 5) }
})

// Stop these terminals and wait for the real end of each one's processes
// (shell and everything under it), not just the host forgetting it: an
// agent update retries an install only once they released their files.
// See processTree.js for why the host's word is not enough.
// -> { ok: true } or { ok: false, stuck: [ids still running something] }
ipcMain.handle('pty:stopAndWait', async (_evt, { ids = [], timeoutMs = 15000 } = {}) => {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => (typeof id === 'string' && id) || Number.isInteger(id))
  const roots = {} // id -> shell pid
  for (const id of list) {
    let pid = ptyInfo.get(id)?.pid
    if (!pid) {
      const a = await host.request('attach', { id }, 5000).catch(() => null)
      pid = a && a.ok && !a.exited ? a.pid : null
    }
    if (Number.isInteger(pid) && pid > 0) roots[id] = pid
  }
  // Recorded before the stop: once the shell is gone, what it started can
  // no longer be traced back to it.
  const procs = Object.keys(roots).length ? await listProcesses() : []
  const trees = {}
  for (const [id, pid] of Object.entries(roots)) {
    trees[id] = procs ? treeOf(procs, [{ pid }]) : [{ pid, created: null }]
    if (!trees[id].length) delete trees[id] // already ended
  }
  for (const id of list) {
    host.send('kill', { id })
    ptyInfo.delete(id)
  }
  const res = await waitForExit({
    entries: Object.values(trees).flat(),
    // Still there after the host's own force-kill (1.5 s): what was left
    // under the shell (an agent that outlived it) is ended too.
    force: (left) => killPids(left),
    timeoutMs: Math.min(Math.max(Number(timeoutMs) || 15000, 1000), 60000)
  })
  if (res.ok) return { ok: true }
  const left = new Set(res.left.map((e) => e.pid))
  const stuck = Object.keys(trees).filter((id) => trees[id].some((e) => left.has(e.pid)))
  log.warn('pty', `terminal(s) ${Object.keys(trees).join(', ')} did not end: pid(s) ${[...left].join(', ')} still run`)
  // Only a process started under them since the stop is left: still theirs.
  return { ok: false, stuck: stuck.length ? stuck : Object.keys(trees) }
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
    // No host running (it stopped or crashed): nothing to save, and starting
    // an empty one would replace the output saved before.
    if (!(await host.connectIfRunning())) return
    const res = await host.request('dump', {}, 4000)
    const keep = {}
    for (const [id, text] of Object.entries(res.buffers || {})) {
      keep[id] = String(text).slice(-64 * 1024)
    }
    if (!Object.keys(keep).length && fs.existsSync(scrollbackFile())) return
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
  // Only a host that runs is asked to stop (asking would start a new one).
  if (!(await host.connectIfRunning())) return
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
  },
  // The installer never started: back to a normal running app (the
  // terminals start again as panes restart or reattach).
  onInstallFailed: () => {
    shutdownDone = false
    quitting = false
    try {
      fs.rmSync(updateNoteFile(), { force: true })
    } catch {
      // no note
    }
  }
})

ipcMain.handle('update:status', () => updater.status)
ipcMain.handle('update:check', () => updater.check())
ipcMain.handle('update:install', () => updater.install())
ipcMain.on('window:theme', (event, theme) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
  if (typeof theme !== 'string') return
  mainWindow.setTitleBarOverlay({ ...titleBarColors(theme), height: 39 })
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
      nodeIntegration: false,
      // Tessel works while minimized or behind other windows: agents message
      // each other, get reminders, the board and the team map stay current.
      // Chromium's background throttling slowed its timers to about once a
      // minute after 5 minutes hidden, so a minimized window stopped the team
      // loop and agents were told their team was gone (2026-09-28).
      backgroundThrottling: false
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
    // The dev server's page only in the dev build (the installed app never
    // loads a page from the network: another local program could use that
    // port).
    if (url !== mainWindow.webContents.getURL() && !(!app.isPackaged && url.startsWith('http://localhost:5173'))) {
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
  // Unsaved files in the editor: the window asks before it closes (see
  // editor:dirty). Not while the app is quitting (an update asked already).
  mainWindow.on('close', (event) => {
    if (editorCloseAllowed || appQuitting || editorDirtyCount <= 0) return
    // A page that cannot answer never keeps the window open.
    if (mainWindow.webContents.isCrashed() || mainWindow.webContents.isLoading()) return
    event.preventDefault()
    mainWindow.webContents.send('editor:confirmClose')
  })
  // A new page (reload) or a crashed one has no unsaved editor files.
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details && details.isMainFrame && !details.isSameDocument) editorDirtyCount = 0
  })
  mainWindow.webContents.on('render-process-gone', () => {
    editorDirtyCount = 0
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
  // A model changed in an agent: its panes read it again (header).
  const stopModelWatch = watchModelFiles((agentId) => send('agents:modelChanged', agentId))
  app.on('will-quit', stopModelWatch)
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
  appQuitting = true
  if (shutdownDone) return
  event.preventDefault()
  shutdownDone = true
  Promise.allSettled([accounts.close(), usageStats.close(), shutdownTerminals()]).finally(() => app.quit())
})
