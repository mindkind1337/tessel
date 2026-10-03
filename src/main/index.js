import { app, BrowserWindow, Menu, ipcMain, clipboard, nativeImage, dialog, Notification, shell, powerSaveBlocker, powerMonitor, safeStorage, webContents, session, utilityProcess } from 'electron'
import { join, isAbsolute, dirname, basename } from 'path'
import os from 'os'
import fs from 'fs'
import { spawn, execFile } from 'child_process'
import { loadTasks, loadBoard, saveTasks } from './taskBoardPersistence'
import { createAutomations } from './automations'
import { createRemotePromptWriter } from './automationRemotePrompt'
import { trimEvents, isEvent } from '../shared/activity'
import { agentModelLive, watchModelFiles } from './agentModel'
import { createCodexAccounts } from './codexAccounts'
import { createClaudeAccounts } from './claudeAccounts'
import { createProviderLogin } from './providerLogin'
import { createProviderAccounts } from './providerAccounts'
import { createAccountUsage } from './providerAccountUsage'
import { registerProviderUsage } from './providerUsageIpc'
import { createProviderCredentials } from './providerCredentials'
import { createAccountSessions } from './providerAccountSessions'
import { postToInbox } from './agentInbox'
import { hooksStatus } from './teamHooksStatus'
import { createAgentStateStore } from './agentStateStore'
import { createCodexTurnEnd, allowedCodexHome, TURN_END_CHECK_MS } from './codexTurnEnd'
import { createUsageStatsTracker } from './usageStatsTracker'
import { copyUsageImage } from './usageClipboard'
import { registerIssueServices } from './issueServicesIpc'
import { createGithubService } from './githubService'
import { createRemoteHosts, registerRemoteHosts, findSshExe } from './remoteHosts'
import { remoteProjectLaunch, validateRemotePath } from './remoteProject'
import { createSshRemote } from './ssh/sshRemote'
import { STORE_FILE_NAME as SSH_HOST_KEYS_FILE } from './ssh/hostKeyStore'
import { createAddProject, registerAddProject } from './addProject'
import { createSshAskpass, registerSshAskpass, askpassExePath } from './sshAskpass'
import { createAskpassPipeHost } from './askpassPipeHost'
import { createRemoteFs, registerRemoteFs, remoteRootsOfLayout, SESSION_PREFIX as REMOTE_FS_PREFIX } from './remoteFs'
import { createGitTrust, setGitTrust } from './gitSafety'
import { createWorktreeList, localRootsOfLayout } from './worktreeList'
import { isRemotePath } from '../shared/remotePath'
import { STATUS_PROVIDERS } from '../shared/agentStateModel'
import { prepareAgentStateHooks } from './agentStateSetup'
import { assessNeeds } from './tesselNeeds'
import { createClaudeUsageReport } from './claudeUsageReport'
import { createJobCost } from './jobCost'
import { resolveFiles, codeGotoArg, listProjectFiles } from './fileOpen'
import { statChatPaths, openChatPath, revealChatPath } from './chatFileOpen'
import { titleBarColors } from '../shared/themePalettes'
import { createThemedDialog } from './themedDialog'
import { geminiSessionExists, qwenSessionExists, resumeTarget } from './agentResume'
import { paneEnv } from './paneEnv'
import { readForView, readImageForView, openPdfWindow } from './fileView'
import { readForEdit, statForEdit, writeForEdit, headContent, createFileWatcher } from './editorFiles'
import * as explorer from './explorer'
import { extraToolDirs, withToolDirs } from './toolDirs'
import { AGENT_INSTALLS, checkInstall } from './agentInstalls'
import { createInstallLogs } from './installLog'
import { writeBoardRule } from './agentMemory'
import { claudeImageFile, isPastedImage, PASTE_DIR } from './pastedImages'
import { createBrowserGuests } from './browserGuest'
import { createAgentBrowser } from './agentBrowser'
import { createChatSessions } from './chat/sessions'
import { createChatImages } from './chat/chatImages'
import { transcriptHomeFor } from './chat/transcriptHistory'
import { createTranscriptViews } from './chat/transcriptView'
import { createTerminalSkills } from './chat/terminalSkills'
import { createSessionSearch } from './sessionSearch/index.js'
import { createClaudeChat } from './chat/claudeChat'
import { createCodexChat } from './chat/codexChat'
import { createOpencodeChat } from './chat/opencodeChat'
import { createServerPidFile, reapOpencodeServers } from './chat/opencodeServers'
import { createChatTrust } from './chat/chatTrust'
import { createAgentFolderTrust } from './agentFolderTrust'
import { createWorkerCopies } from './chat/workerCopies'
import { createLogger, describe } from './logger'
import { guardIpc, mainFrameSender } from './ipcGuard'
import { cleanEnv } from './cleanEnv'
import { createPtyClient } from './ptyClient'
import { listProcesses, treeOf, waitForExit, killPids, listProcessNames, runningWork } from './processTree'
import { pipeName } from './ptyProtocol'
import { createUpdater } from './updater'
import { createAgentUpdates } from './agentUpdates'
import { createUpdateRunner, fakeSpawn, classifyFailure } from './agentUpdateRunner'
import { createUpdateHistory } from './agentUpdateHistory'
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
import { runHeadless, cancelHeadless, resolveProgram } from './agentHeadless'
import { createCommitMessageGeneration } from './commitMessageGeneration'
import { createModelLister } from './agentModelList'
import { takeTeamAcks } from './teamAcks'
import { writeJsonSafe, readJsonSafe } from './safeJson'
import { addNotices, writeCurrentTeams, retireOldTeams } from './teamNotices'
import { JSON_AGENTS, setJsonAgentServer, teamToolsEntry } from './jsonAgents'
import { detectAgents } from './agentDetect'
import { createPortScanner } from './workspacePorts'
import { createResourceCollector } from './resourceUsage'
import { newTeamSecret, setTeamSecret, revokeTeamSecret, verifyRequest } from './teamAuth'
import { publishTeamTasks, forgetPublishedTasks, takeTeamRequests, finishTeamRequests, releaseTeamRequests, messageStatuses, writeBoardPanes, toolsAlive, writeRoster, writeTeamAnswer, publishWorkers } from './teamTasks'
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
  removeTeamHooks,
  SERVER_NAME
} from './teamInstall'
import { findNode, noNodeError } from './nodePath'
import { removeStatusHooks, STATUS_HOOK_AGENTS } from './agentStatusHooks'
import teamServerSource from './teamMcp/server.cjs?raw'
import { ensureInbox, takeInbox, removeInbox } from './leadInbox'
import { t, setLanguage as setMainLanguage, currentLocale, onLanguageChange } from './i18n'
import { createCliServer, CliError } from './cliServer'
import { createCliBridge } from './cliBridge'
import { createCloseGuard } from './closeGuard'
import { createCliInstaller, createUserPathRegistry, cliBinDir, cliCommandName, cliScriptPath, cliLauncherPath, iniText, readRegistryPathSync } from './cliInstall'
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
// Started by the tessel command (src/cli/tessel.js): its environment is a
// clean one without the terminal's PATH; PATH comes from the registry, as a
// Start-menu launch has it, so panes and agents never inherit a terminal's.
if (process.env.TESSEL_STARTED_BY_CLI === '1') {
  delete process.env.TESSEL_STARTED_BY_CLI
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  process.env.PATH =
    readRegistryPathSync() || [join(sysRoot, 'System32'), sysRoot, join(sysRoot, 'System32', 'Wbem'), join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
}

// Chromium caches and per-run files are never copied between data folders.
const NOT_COPIED = [
  'update-installed.json',
  'logs',
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'lockfile',
  'session-search'
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

// Windows caches a taskbar or shortcut icon by its file's path, so a new
// icon at the same path keeps showing the old one. The dev build uses a copy
// named after its content (userData\icons\icon-dev-<hash>.ico): a changed
// icon gets a new path, never a cached image. Older copies are removed.
let devIconCopyPath = null
function devIconCopy(file) {
  if (devIconCopyPath) return devIconCopyPath
  try {
    const bytes = fs.readFileSync(file)
    const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 10)
    const dir = join(app.getPath('userData'), 'icons')
    fs.mkdirSync(dir, { recursive: true })
    const out = join(dir, `icon-dev-${hash}.ico`)
    if (!fs.existsSync(out)) fs.writeFileSync(out, bytes)
    for (const f of fs.readdirSync(dir)) {
      if (/^icon-dev-[0-9a-f]+\.ico$/.test(f) && f !== basename(out)) fs.rmSync(join(dir, f), { force: true })
    }
    devIconCopyPath = out
  } catch {
    devIconCopyPath = file
  }
  return devIconCopyPath
}

// The dev build uses a yellow copy of the icon (window, taskbar, Start menu
// shortcut), so it can't be mistaken for the installed app.
function appIconPath() {
  const devIco = join(__dirname, '../../build/icon-dev.ico')
  if (!app.isPackaged && fs.existsSync(devIco)) return devIconCopy(devIco)
  const ico = join(__dirname, '../../build/icon.ico')
  return fs.existsSync(ico) ? ico : join(__dirname, '../../build/icon.png')
}

// Our own taskbar identity. Without it, Windows groups the dev build under
// electron.exe and shows Electron's icon; with it, the taskbar uses ours. The
// installed app uses the installer's id so its Start menu shortcut, taskbar
// button and notifications line up.
const APP_ID = app.isPackaged
  ? 'com.jeanclaudetrottier.tessel'
  : 'com.jeanclaudetrottier.tessel.devtiles'
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

// Logs: %APPDATA%\\tessel\\logs\\tessel.log (rotated, 1 MB x 4).
const log = createLogger({ dir: join(app.getPath('userData'), 'logs') })

// Every IPC channel below (and the register*(ipcMain) modules') answers only
// the main window's own page, never a browser page or a frame (ipcGuard.js).
// Installed before the first channel is registered. The built-in browser's
// channels too (they check the window again themselves, browserGuest.js).
guardIpc(ipcMain, { isTrustedSender: mainFrameSender(() => mainWindow), log })

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
    // Kimi Code's own installer (the pip kimi-cli is no longer maintained).
    ...AGENT_INSTALLS.kimi,
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
    ...AGENT_INSTALLS.cursor
  },
  {
    id: 'grok',
    name: 'Grok Build',
    command: 'grok',
    accent: '#b8b8b8',
    ...AGENT_INSTALLS.grok
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
    ...AGENT_INSTALLS.goose
  },
  {
    id: 'auggie',
    name: 'Auggie',
    command: 'auggie',
    accent: '#67c5ad',
    // Augment currently documents Windows through WSL, not native setup.
    ...AGENT_INSTALLS.auggie
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    accent: '#14b014',
    ...AGENT_INSTALLS.aider
  },
  // More agents Orca knows (its catalog, MIT). Only installers we are sure
  // of (agentInstalls.js); the others: a link to their install page.
  {
    id: 'openclaude',
    name: 'OpenClaude',
    command: 'openclaude',
    accent: '#d9a077',
    ...AGENT_INSTALLS.openclaude
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
    ...AGENT_INSTALLS.kiro
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
    ...AGENT_INSTALLS.vibe
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    accent: '#5b8def',
    ...AGENT_INSTALLS.antigravity
  },
  {
    id: 'rovo',
    name: 'Rovo Dev',
    command: 'rovo',
    accent: '#1868db',
    ...AGENT_INSTALLS.rovo
  },
  {
    id: 'hermes',
    name: 'Hermes',
    command: 'hermes --tui',
    accent: '#c9a86a',
    ...AGENT_INSTALLS.hermes
  },
  {
    id: 'devin',
    name: 'Devin',
    command: 'devin',
    accent: '#3fb68b',
    ...AGENT_INSTALLS.devin
  },
  {
    id: 'trae',
    name: 'Trae',
    command: 'traecli',
    accent: '#ff4d4f',
    ...AGENT_INSTALLS.trae
  },
  {
    id: 'zcode',
    name: 'ZCode',
    command: 'zcode',
    accent: '#6c8cff',
    ...AGENT_INSTALLS.zcode
  },
  {
    id: 'autohand',
    name: 'Autohand Code',
    command: 'autohand',
    accent: '#f59e0b',
    ...AGENT_INSTALLS.autohand
  },
  {
    id: 'commandcode',
    name: 'Command Code',
    command: 'command-code --trust',
    accent: '#e5e7eb',
    ...AGENT_INSTALLS.commandcode
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    command: 'openclaw',
    accent: '#ef6b5b',
    ...AGENT_INSTALLS.openclaw
  },
  {
    id: 'omp',
    name: 'OMP',
    command: 'omp',
    accent: '#c04fd8',
    ...AGENT_INSTALLS.omp
  },
  {
    id: 'muse',
    name: 'Muse',
    // Skips its first-run "trust this folder?" question.
    command: 'muse --trust-workspace',
    accent: '#0668e1',
    ...AGENT_INSTALLS.muse
  },
  {
    id: 'opencode2',
    name: 'OpenCode 2',
    command: 'opencode2',
    accent: '#e8e8e8',
    ...AGENT_INSTALLS.opencode2
  },
  {
    id: 'mimocode',
    name: 'MiMo Code',
    command: 'mimo',
    accent: '#ff6900',
    ...AGENT_INSTALLS.mimocode
  },
  {
    id: 'primeagent',
    name: 'Prime Agent',
    command: 'prime-agent',
    accent: '#8b8bf5',
    ...AGENT_INSTALLS.primeagent
  },
  {
    id: 'ante',
    name: 'Ante',
    command: 'ante',
    accent: '#22c55e',
    ...AGENT_INSTALLS.ante
  },
  // Qoder CLI, Freebuff and DeepSeek Harness, after Orca's
  // src/renderer/src/lib/agent-catalog.tsx and src/shared/tui-agent-config.ts,
  // MIT, Copyright (c) 2026 Lovecast Inc.
  {
    id: 'qoder',
    name: 'Qoder CLI',
    // Its installer and its npm package both ship `qodercli`.
    command: 'qodercli',
    accent: '#2adb5c',
    ...AGENT_INSTALLS.qoder
  },
  {
    id: 'freebuff',
    name: 'Freebuff',
    command: 'freebuff',
    accent: '#e5e7eb',
    ...AGENT_INSTALLS.freebuff
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    // The launcher of dsh's interactive profile (it runs dsh --profile dsh-tui).
    command: 'dsh-tui',
    accent: '#4d6bfe',
    ...AGENT_INSTALLS.dsh
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
const freshPathRead = readFreshPath().then((p) => {
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
  // The first list waits for the PATH read from Windows: Tessel started from
  // a terminal opened before an agent was installed would otherwise not see
  // that agent until a manual refresh (its old PATH, kept in agentCache).
  if (freshPath === null) await freshPathRead
  if (!agentCache) {
    agentCache = Promise.all(
      AGENT_PRESETS.map(async (a) => ({
        id: a.id,
        name: a.name,
        command: a.command,
        accent: a.accent,
        // Only an install that passes its checks (agentInstalls.js) reaches
        // the window; else its install page, if it has one.
        ...checkInstall(a),
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
  // Its remote projects are the only remote folders Files, Changes and the
  // editor may reach (remoteFs.js).
  if (isLayout(data)) remoteFs.setRoots(remoteRootsOfLayout(data))
  // Its local project folders are the only ones whose worktrees are listed.
  if (isLayout(data)) worktreeList.setRoots(localRootsOfLayout(data))
  // ...and the projects whose folder an agent may be pre-trusted in.
  if (isLayout(data)) agentFolderTrust.setRoots(localRootsOfLayout(data))
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
    else saveTasks(app.getPath('userData'), board && board.tasks, board && board.appliedRequests, board && board.deleted)
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
    if (!Array.isArray(events)) return { ok: false, error: 'not a list' } // i18n-ignore internal: the renderer's own data, never shown
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
// Resuming the other agents' conversations: null (start fresh), {} or
// { transcriptPath } (Pi). The command line is built in the renderer.
ipcMain.handle('sessions:resumeTarget', (_evt, q = {}) => {
  try {
    return resumeTarget({ agent: q && q.agent, sessionId: q && q.sessionId })
  } catch {
    return null
  }
})
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
// Chat agents (src/main/chat): Claude without a terminal, in its stream-json
// mode. Each chat is a pane of its own: its identity and team secret like a
// terminal pane's, its state reported here (no hooks), its team messages
// given as turns. In -p mode Claude runs the project's hooks and MCP servers
// without asking: Tessel asks once per folder first (chatTrust.js).
// The copies Tessel made from a project's own code (HEAD or a local branch):
// only those count as their project for a worker's chat (workerCopies.js).
const workerCopies = createWorkerCopies({ file: join(app.getPath('userData'), 'worker-copies.json') })
// Security questions (trust a folder, trust a repository) in Tessel's look:
// a window of their own that only the user answers, never Tessel's window or
// its pages (themedDialog.js; the native dialog if it cannot open).
let windowTheme = 'classic'
const themedMessageBox = createThemedDialog({
  BrowserWindow,
  ipcMain,
  dialog,
  preload: join(__dirname, '../preload/themedDialog.js'),
  getTheme: () => windowTheme,
  log
})
const chatTrust = createChatTrust({
  file: join(app.getPath('userData'), 'chat-trust.json'),
  ask: async ({ dir }) => {
    const opts = {
      type: 'warning',
      title: t('main.chat.trustTitle', 'Trust this folder for a chat agent?'),
      message: t('main.chat.trustMessage', 'A chat agent runs Claude, Codex or OpenCode in {{dir}} without its terminal: it then runs the hooks, plugins and MCP servers this folder sets up (.claude/settings.json, .mcp.json, .codex/config.toml, opencode.json, .opencode/) without asking.', { dir: String(dir).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) }),
      detail: t('main.chat.trustDetail', 'Trust it only if you know where this folder comes from. Agents Tessel starts here in a terminal then skip their own "trust this folder?" question too (Settings > Agents).'),
      buttons: [t('main.chat.trustYes', 'Trust this folder'), t('main.chat.trustNo', 'Cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    const res = win ? await themedMessageBox(win, opts) : await themedMessageBox(opts)
    return res.response === 0
  }
})
// The folder an agent starts in, pre-trusted in that agent's own settings
// (agentFolderTrust.js): only a project the user added, a folder trusted for
// chats, or a copy Tessel made from such a project's own code.
const agentFolderTrust = createAgentFolderTrust({ chatTrust, workerCopies, log })
// The OpenCode servers chat panes start, by PID: one a crash left behind is
// stopped at the next start (opencodeServers.js checks it is ours first).
const opencodePidsFile = join(app.getPath('userData'), 'opencode-chat', 'servers.json')
const opencodePids = createServerPidFile({ file: opencodePidsFile })
app.whenReady().then(() => {
  reapOpencodeServers({ file: opencodePidsFile, log })
    .then((stopped) => {
      if (stopped.length) log.info?.('chat', `stopped ${stopped.length} OpenCode server(s) left by an earlier run`)
    })
    .catch(() => {})
})
// Images attached to chat messages: Tessel's own copies (chat/chatImages.js).
const chatImages = createChatImages({ nativeImage, log })
chatImages.sweep()
// The usage indicator's live readings (usagePoller.js ingest), set once the
// usage service is registered below.
let usageLiveIngest = null
const chatSessions = createChatSessions({
  dir: app.getPath('userData'),
  images: chatImages,
  send,
  onRateLimit: (event) => void usageLiveIngest?.(event)?.catch?.(() => {}),
  // Claude (stream-json), Codex (codex app-server, JSON-RPC) or OpenCode
  // (opencode serve: HTTP + SSE on 127.0.0.1 with a password of its own).
  createAdapter: (opts) => (opts && opts.agent === 'codex' ? createCodexChat(opts) : opts && opts.agent === 'opencode' ? createOpencodeChat({ ...opts, pids: opencodePids, envPluginFile: join(app.getPath('userData'), 'opencode-chat', 'tessel-chat-env.js') }) : createClaudeChat(opts)),
  // The installed claude (the npm shim resolved to what it runs), as for
  // Tessel's headless calls.
  resolveClaude: async () => {
    const prog = await resolveProgram('claude')
    return prog ? { exe: prog.file, exeArgs: prog.pre || [], pathEnv: prog.path || null } : null
  },
  // Codex's npm shim runs `node codex.js`: the same, with app-server added by the adapter.
  resolveCodex: async () => {
    const prog = await resolveProgram('codex')
    return prog ? { exe: prog.file, exeArgs: prog.pre || [], pathEnv: prog.path || null } : null
  },
  // OpenCode's npm shim runs its native opencode.exe: that exe, started
  // directly (`serve` is added by the adapter).
  resolveOpencode: async () => {
    const prog = await resolveProgram('opencode')
    return prog ? { exe: prog.file, exeArgs: prog.pre || [], pathEnv: prog.path || null } : null
  },
  // As a terminal pane's: Tessel's clean environment, then Settings > Agents
  // variables and the provider account's (paneEnv checks them).
  env: { forPane: ({ extraEnv, accountEnv, unsetEnv }) => paneEnv(freshEnv(), { extraEnv, accountEnv, unsetEnv }) },
  team: { newSecret: newTeamSecret, setSecret: setTeamSecret, revokeSecret: revokeTeamSecret },
  state: agentStateStore,
  trust: chatTrust,
  // A worker's chat in a copy Tessel made from the project's own code counts
  // as that project (verified both ways by git's links). Any other worktree,
  // such as a pull request's copy, is trusted (or asked) like any folder.
  trustRoots: (cwd, opts) => workerCopies.trustRoots(cwd, opts),
  // A Codex chat in a trusted folder: Codex's own trust too, or a read-only
  // chat would ignore the project's .codex settings (agentFolderTrust.js).
  preTrust: (q) => agentFolderTrust.apply(q),
  // Where a resumed conversation's earlier history is read (its agent's own
  // transcript): the system Claude folder, the system Codex home or a managed
  // Codex account's, never another folder.
  transcriptHome: (agent, env) =>
    transcriptHomeFor(agent, env, {
      systemClaude: process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude'),
      systemCodex: process.env.CODEX_HOME || join(os.homedir(), '.codex'),
      codexAccountsBase: join(app.getPath('userData'), 'codex-accounts')
    }),
  log
})
chatSessions.register(ipcMain)
// Read-only chat views of the agents without a chat protocol (Grok,
// OpenClaude, OMP): their session file, watched while the view is open.
// Search in what was said in the agents' conversations: a local index, off
// until the user turns it on; filled in the background by a process of its
// own, not while the window is hidden or minimized (sessionSearch/index.js).
function sessionSearchDir() {
  const userData = app.getPath('userData')
  const local = process.platform === 'win32' ? process.env.LOCALAPPDATA : ''
  return local && !process.env.TESSEL_USER_DATA ? join(local, basename(userData)) : userData
}
const sessionSearch = createSessionSearch({
  // Its index is local to this computer: under %LOCALAPPDATA% on Windows (not
  // the roaming profile), else in the data folder (a private folder there).
  dir: sessionSearchDir(),
  // Its own process: the index and the indexing never run in this one.
  fork: (dir) => utilityProcess.fork(join(__dirname, 'sessionSearchWorker.js'), [dir], { serviceName: 'Tessel session search' }),
  isPaused: () => !mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || !mainWindow.isVisible(),
  log
})
sessionSearch.register(ipcMain)
app.whenReady().then(() => sessionSearch.start())
app.on('will-quit', () => sessionSearch.close())
// Claude Code and Codex: the folder of the pane's account (resolved here from
// its id), and the session file its hooks reported (sessions/<pane>.json).
const transcriptViews = createTranscriptViews({
  send,
  log,
  homes: async (agent, accountId) => {
    const r = await accountSessions.roots({ agent, accountId })
    return (r && r[agent]) || null
  },
  sessionsDir: () => sessionsDir()
})
transcriptViews.register(ipcMain)
app.on('will-quit', () => transcriptViews.closeAll())
// The skills a terminal agent's chat view lists ("/" menu): its project's
// (its open view's folder), the user's and its account's.
createTerminalSkills({
  views: transcriptViews,
  homes: async (agent, accountId) => {
    const r = await accountSessions.roots({ agent, accountId })
    return (r && r[agent]) || null
  }
}).register(ipcMain)
// Quitting kills the chat agents' process trees at once (before-quit below
// waits for it); this one only catches a quit that skipped before-quit.
app.on('will-quit', () => {
  void Promise.resolve(chatSessions.closeAll({ kill: true })).catch(() => {})
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
  // Back from sleep: due automations are looked at now, not a minute later.
  powerMonitor.on('resume', () => automations.tick())
})

// ---------------------------------------------------------------------------
// Scheduled automations (src/main/automations.js): the scheduler runs here,
// only while Tessel is open; the window starts each run's pane and reports.
// ---------------------------------------------------------------------------
// A remote project's prompt file, written through its Files session
// (automationRemotePrompt.js), never typed into the host's login shell.
const remotePrompts = createRemotePromptWriter({
  // An automation the user scheduled on that project may sign in (a run's
  // pane on the host connects too).
  listDir: (q) => {
    remoteFs.allowPath(q && q.root)
    return remoteFs.listDir(q)
  },
  create: (q) => {
    remoteFs.allowPath(q && q.root)
    return remoteFs.create(q)
  },
  writeForEdit: (q) => {
    remoteFs.allowPath(q && q.file)
    return remoteFs.writeForEdit(q)
  },
  snapshot: () => remoteFs.snapshot()
})
const automations = createAutomations({
  dir: app.getPath('userData'),
  send,
  log,
  writeRemotePrompt: (q) => remotePrompts.write(q),
  clearRemotePrompt: (q) => remotePrompts.clear(q)
})
app.whenReady().then(() => automations.start())
app.on('will-quit', () => automations.stop())
ipcMain.handle('automations:list', () => automations.snapshot())
ipcMain.handle('automations:create', (_evt, input) => automations.create(input))
ipcMain.handle('automations:update', (_evt, id, input) => automations.update(String(id || ''), input || {}))
ipcMain.handle('automations:setEnabled', (_evt, id, enabled, confirmed, sig) => automations.setEnabled(String(id || ''), !!enabled, confirmed === true, typeof sig === 'string' ? sig : null))
ipcMain.handle('automations:remove', (_evt, id) => automations.remove(String(id || '')))
ipcMain.handle('automations:runNow', (_evt, id, confirmed, sig) => automations.runNow(String(id || ''), confirmed === true, typeof sig === 'string' ? sig : null))
ipcMain.handle('automations:status', (_evt, runId) => automations.status(String(runId || '')))
ipcMain.handle('automations:setSettings', (_evt, patch) => automations.setSettings(patch || {}))
ipcMain.handle('automations:markResult', (_evt, result) => automations.markResult(result || {}))
ipcMain.handle('automations:reconcile', (_evt, paneIds) => automations.reconcile(paneIds))
ipcMain.handle('automations:windowReady', () => {
  automations.setWindowReady(true)
  return automations.snapshot()
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
// A Codex turn that ended without its Stop hook (an errored turn runs none):
// its own session rollout says so (codexTurnEnd.js). Only the CODEX_HOME the
// pane was started with, when it is the system home or a managed account's.
const codexTurnEnd = createCodexTurnEnd({
  store: agentStateStore,
  homeFor: (paneId, token) => {
    const info = ptyInfo.get(paneId)
    if (!info || !token || info.agentLaunchToken !== token) return null
    const home = info.agentCodexHome || process.env.CODEX_HOME || join(os.homedir(), '.codex')
    return allowedCodexHome(home, {
      systemHome: process.env.CODEX_HOME || join(os.homedir(), '.codex'),
      accountsBase: join(app.getPath('userData'), 'codex-accounts')
    }) ? home : null
  }
})
const codexTurnEndTimer = setInterval(() => { void codexTurnEnd().catch(() => {}) }, TURN_END_CHECK_MS)
codexTurnEndTimer.unref()
app.on('will-quit', () => clearInterval(codexTurnEndTimer))
ipcMain.handle('agents:states', () => agentStateStore.snapshot())
ipcMain.on('agents:screen', (_evt, q) => {
  if (!q || typeof q !== 'object') return
  void agentStateStore.observe(q.paneId, q.launchToken, { event: q.event, reset: q.reset }).catch(() => {})
})
// optIn: the agents whose status hooks the user turned on in Settings (only
// Cursor's are off by default), from the renderer: { cursor: true }.
const hookOptIn = (value) => ({ cursor: !!(value && typeof value === 'object' && value.cursor === true) })
function prepareStatus(provider, env = process.env, optIn = {}) {
  return prepareAgentStateHooks({ provider, env, optIn: hookOptIn(optIn), source: teamServerSource, sharedDir: join(app.getPath('appData'), 'tessel-team') })
}
ipcMain.handle('agents:prepareStatus', (_evt, provider, optIn) => prepareStatus(provider, process.env, optIn))
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
        // The inbox key stays in this process (agents:inbox), and so does the
        // session file's path (transcriptView.js reads it here).
        const { inboxToken, transcriptPath, ...shown } = r
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
// One past conversation (Agent Session History, sessionDetails.js): its
// first prompt and latest turns, its transcript shown in the file manager,
// its deletion (to the Recycle Bin).
ipcMain.handle('sessions:details', async (_evt, q = {}) => {
  try { return await accountSessions.details(q || {}) } catch { return { ok: false } }
})
ipcMain.handle('sessions:revealLog', async (_evt, q = {}) => {
  try { return await accountSessions.reveal(q || {}, (p) => shell.showItemInFolder(p)) } catch { return { ok: false, error: 'failed' } }
})
ipcMain.handle('sessions:delete', async (_evt, q = {}) => {
  try { return await accountSessions.remove(q || {}, (p) => shell.trashItem(p)) } catch { return { ok: false, error: 'failed' } }
})
// The model an agent pane uses (for its header), or null.
ipcMain.handle('agents:model', async (_evt, q = {}) => {
  try {
    return await agentModelLive(q || {})
  } catch {
    return null
  }
})

// The models each agent's CLI listed (Settings > Agents > Refresh models):
// the kept lists, and a probe run only when asked (agentModelList.js).
let modelLister = null
const getModelLister = () => (modelLister ||= createModelLister(app.getPath('userData'), { resolve: resolveProgram }))
ipcMain.handle('agents:modelLists', () => {
  try {
    return getModelLister().list()
  } catch {
    return {}
  }
})
ipcMain.handle('agents:probeModels', async (_evt, q = {}) => {
  const agent = q && typeof q.agent === 'string' ? q.agent : ''
  const command = q && typeof q.command === 'string' ? q.command.slice(0, 300) : ''
  try {
    const res = await getModelLister().probe(agent, command)
    log.info('models', `model list for ${agent}: ${res.ok ? `${res.models.length} models` : `${res.reason} ${res.detail || ''}`}`)
    return res
  } catch (err) {
    return { ok: false, reason: 'failed', detail: String((err && err.message) || err).slice(0, 300) }
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
// The sidebar's "other branches": the worktrees of an open project's
// repository (read-only, worktreeList.js).
const worktreeList = createWorktreeList()
ipcMain.handle(
  'git:worktrees',
  // A remote project's (its virtual root): over its host's signed-in session.
  safe((cwd) => (isRemotePath(cwd) ? remoteFs.gitWorktrees(cwd) : worktreeList.list(cwd)))
)
ipcMain.handle(
  'git:createWorktree',
  safe(async ({ cwd, label, options } = {}) => {
    const res = await createWorktree(cwd, label, options)
    // Recorded only when made from HEAD or a local branch (never a pinned
    // commit such as a pull request's head, nor a remote branch).
    if (res && res.ok) workerCopies.created({ path: res.path, project: res.root, baseKind: res.baseKind })
    return res
  })
)
const accountOptions = { userData: app.getPath('userData'), runLogin: createProviderLogin() }
// A remote project's GitHub form and Create PR: its repository named from
// its remote's URL, read on the host (remoteFs.js githubContext).
registerIssueServices({
  ipcMain,
  dir: join(app.getPath('userData'), 'linear'),
  safeStorage,
  github: createGithubService({ remote: { isRemote: isRemotePath, context: (root) => remoteFs.githubContext(root) } }),
  onPrCreated: (url) => usageStats.prCreated(url)
})
// Remote hosts over SSH (remoteHosts.js): Settings > SSH Hosts, the status bar.
const remoteHosts = createRemoteHosts({ dir: app.getPath('userData'), onChange: (states) => send('remoteHosts:state', states) })
// A remote project's Files / Changes session (remoteFs.js) counts as one of
// the host's connections: Disconnect ends it like a terminal.
const isRemoteFsPane = (id) => typeof id === 'string' && id.startsWith(REMOTE_FS_PREFIX)
// The shared ssh2 connection of each host (ssh/sshRemote.js): it lives in
// the terminal host (so remote terminals survive app restarts like local
// ones), reached through `host`, created further down (used lazily here).
const sshRemote = createSshRemote({
  host: {
    ensure: () => host.ensure(),
    request: (op, body, timeout) => host.request(op, body, timeout),
    send: (op, body) => host.send(op, body),
    get connected() {
      return host.connected
    },
    get features() {
      return host.features
    }
  },
  hosts: remoteHosts,
  send: (channel, payload) => send(channel, payload),
  log,
  t,
  sshExe: () => findSshExe()
})
registerRemoteHosts({
  ipcMain,
  service: remoteHosts,
  killPane: (id) => (isRemoteFsPane(id) ? remoteFs.closePane(id) : host.send('kill', { id })),
  ssh: sshRemote
})
// Its passwords, passphrases and host key questions come through OpenSSH's
// npm run dev did not always leave the helper next to index.js (the build
// plugin only covers it reliably in packaged builds): in development Tessel
// builds it itself when it is missing, with the same script, in the
// background. Until then ssh asks in the terminal.
if (!app.isPackaged && process.platform === 'win32' && !askpassExePath(__dirname)) {
  const script = join(app.getAppPath(), 'scripts', 'build-askpass.mjs')
  if (fs.existsSync(script)) {
    execFile(
      process.execPath,
      [script, join(__dirname, 'tessel-askpass.exe')],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 120000 },
      (err) => {
        if (err) log.warn('ssh', `askpass helper not built: ${err.message}`)
        else log.info('ssh', 'askpass helper built for development')
      }
    )
  }
}
// The same for the tessel command's launcher (Settings > General > Tessel CLI).
if (!app.isPackaged && process.platform === 'win32' && !fs.existsSync(join(__dirname, 'tessel-cli.exe'))) {
  const script = join(app.getAppPath(), 'scripts', 'build-askpass.mjs')
  if (fs.existsSync(script)) {
    execFile(
      process.execPath,
      [script, '--cli', join(__dirname, 'tessel-cli.exe')],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 120000 },
      (err) => {
        if (err) log.warn('cli', `command launcher not built: ${err.message}`)
        else log.info('cli', 'command launcher built for development')
      }
    )
  }
}
// askpass channel (sshAskpass.js): only ssh can ask, the answer goes back to
// ssh's helper, never to the terminal. Never logged.
const sshAskpass = createSshAskpass({
  helperPath: () => askpassExePath(__dirname),
  // The pipe is served by the helper, with a DACL for this user only.
  netApi: createAskpassPipeHost({ exePath: () => askpassExePath(__dirname) }),
  send: (channel, payload) => send(channel, payload),
  // Ctrl+C when the user cancels (stops ssh); never an answer.
  // (A Files session has no terminal: cancelling ends it instead.)
  writePty: (id, data) => {
    if (!isRemoteFsPane(id)) host.send('write', { id, data })
  },
  onConnected: (id) => remoteHosts.paneConnected(id),
  onConnecting: (id) => remoteHosts.paneConnecting(id),
  onCancel: (id, hostId) => {
    if (isRemoteFsPane(id)) remoteFs.closePane(id, 'auth-cancelled')
    else if (hostId) remoteHosts.markDisconnecting(hostId)
  },
  log
})
// One answer path for both: askpass (system ssh) and ssh2 questions.
registerSshAskpass({
  ipcMain,
  broker: { submit: (req) => (sshRemote.isPane(req && req.paneId) ? sshRemote.submit(req) : sshAskpass.submit(req)) }
})
// A repository whose own git config runs programs (core.fsmonitor, filters,
// textconv, hooksPath, sshCommand): asked once whether to trust it, the
// answer kept per repository and settings (gitSafety.js); until then git
// runs with them off.
setGitTrust(
  createGitTrust({
    file: join(app.getPath('userData'), 'git-trust.json'),
    ask: async ({ name, where, risky }) => {
      const shown = risky
        .slice(0, 8)
        .map((r) => {
          const value = String(r.value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160)
          return r.key === 'hook' ? t('main.gitTrust.hook', 'hook: {{name}}', { name: value }) : `${r.key} = ${value}`
        })
        .join('\n')
      const opts = {
        type: 'warning',
        title: t('main.gitTrust.title', 'Trust this repository?'),
        message: where
          ? t('main.gitTrust.messageRemote', 'The git settings of {{repo}} on {{host}} run programs on that host when Tessel reads its status.', { repo: name, host: where })
          : t('main.gitTrust.message', 'The git settings of {{repo}} run programs on this computer when Tessel reads its status.', { repo: name }),
        detail: `${shown}${risky.length > 8 ? '\n…' : ''}\n\n${t('main.gitTrust.detail', 'Trust it only if you know where this folder comes from. Until then Tessel runs git with these settings turned off.')}`,
        buttons: [t('main.gitTrust.trust', 'Trust and run them'), t('main.gitTrust.dontTrust', 'Keep them off')],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      }
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      const res = win ? await themedMessageBox(win, opts) : await themedMessageBox(opts)
      return res.response === 0
    }
  })
)
// Files, Changes and the editor of remote projects (remoteFs.js): one ssh
// session per host, the same askpass dialog.
const remoteFs = createRemoteFs({ hosts: remoteHosts, askpass: sshAskpass, ssh: sshRemote, send: (channel, payload) => send(channel, payload), log })
registerRemoteFs({ ipcMain, service: remoteFs })
// The saved remote projects (the layout on disk; each save updates them).
try {
  const saved = readJsonSafe(layoutFile(), isLayout)
  remoteFs.setRoots(remoteRootsOfLayout(saved && saved.data))
  worktreeList.setRoots(localRootsOfLayout(saved && saved.data))
  agentFolderTrust.setRoots(localRootsOfLayout(saved && saved.data))
} catch {
  /* none yet: the first save brings them */
}
app.on('will-quit', () => remoteFs.close())
// A remote project's path (ssh://…) in a call made for local files.
const remoteArg = (q) => (q && typeof q === 'object' ? isRemotePath(q.root) || isRemotePath(q.file) || isRemotePath(q.path) : isRemotePath(q))
// Add a project (addProject.js): clone from a URL, create a new one, find the
// repositories in a folder.
registerAddProject({ ipcMain, service: createAddProject({ send: (channel, payload) => send(channel, payload) }) })
const accounts = createProviderAccounts({
  claude: createClaudeAccounts(accountOptions),
  codex: createCodexAccounts(accountOptions)
})
ipcMain.handle('accounts:list', safe(() => accounts.list()))
// Usage refresh: at startup, every 2 min (Settings) while the window is in use,
// on focus when older than 5 min, and from the chats' own rate-limit reports
// (usagePoller.js); results are pushed on providerUsage:update.
registerProviderUsage({
  ipcMain,
  accounts,
  userData: app.getPath('userData'),
  log,
  listAgents: () => getAgents(),
  send,
  getWindow: () => mainWindow,
  onLiveIngest: (ingest) => {
    usageLiveIngest = ingest
  },
  // Settings > AI provider accounts: Gemini, OpenCode Go and MiniMax usage
  // credentials, encrypted with the OS (providerCredentials.js).
  credentials: createProviderCredentials({ dir: join(app.getPath('userData'), 'provider-credentials'), safeStorage })
})
ipcMain.handle('accounts:loginStatus', safe((id) => accounts.loginStatus(id)))
ipcMain.handle('accounts:launchEnv', safe((query) => typeof query === 'string'
  ? accounts.launchEnv(query) : accounts.launchEnv(query?.provider, query?.accountId)))
const accountSessions = createAccountSessions({ accounts })
const accountUsage = createAccountUsage({ accounts, userData: app.getPath('userData') })
// Tokens, time and estimated cost of each job (task card) and pane session,
// from the agents' session files in every account's folder (jobCost.js).
let jobCostHomes = { at: 0, agentHomes: null }
async function jobCostHomeList(agent) {
  if (!jobCostHomes.agentHomes || Date.now() - jobCostHomes.at > 60000) {
    const agentHomes = { claude: new Set(), codex: new Set() }
    let rows = []
    try {
      rows = (await accounts.list()).providers || []
    } catch {
      rows = []
    }
    for (const a of ['claude', 'codex']) {
      const row = rows.find((r) => r.provider === a)
      const ids = [undefined, null, ...((row && row.accounts) || []).map((x) => x && x.id).filter(Boolean)]
      for (const accountId of ids) {
        try {
          const r = await accountSessions.roots({ agent: a, accountId })
          if (r && r[a]) agentHomes[a].add(r[a])
        } catch {
          // that account's folder is unknown
        }
      }
    }
    jobCostHomes = { at: Date.now(), agentHomes }
  }
  return [...(jobCostHomes.agentHomes[agent] || [])]
}
const jobCost = createJobCost({
  userDataDir: app.getPath('userData'),
  sessionsDir: () => sessionsDir(),
  homes: jobCostHomeList,
  isRemote: isRemotePath,
  send,
  log
})
jobCost.register(ipcMain)
app.on('will-quit', () => void jobCost.close())
ipcMain.handle('usage:get', safe(() => accountUsage.usage()))
// Claude Code's usage report from its own conversation files (tokens, estimated cost).
const claudeUsageReport = createClaudeUsageReport()
ipcMain.handle('usage:claudeReport', safe((query) => claudeUsageReport(query)))
// Codex's usage report from its own session files (tokens, requests).
ipcMain.handle('usage:codexReport', safe((query) => accountUsage.report(query)))
ipcMain.handle('review:info', safe(reviewInfo))
ipcMain.handle('review:diff', safe(reviewDiff))
ipcMain.handle('review:merge', safe(reviewMerge))
ipcMain.handle(
  'review:remove',
  safe(async (args) => {
    const res = await reviewRemove(args)
    // The copy is gone: so is its record (a new folder there is not it).
    if (args && typeof args.path === 'string' && args.path && (res?.ok || res?.copyRemoved || !fs.existsSync(args.path)))
      workerCopies.forget(args.path)
    return res
  })
)
ipcMain.handle('review:commit', safe(reviewCommit))
ipcMain.handle('review:push', safe(reviewPush))
// Source control (the Changes tab, after Orca's): status, stage, unstage,
// discard (untracked files to the Recycle Bin), commit, push, pull, and the
// two sides of a file's diff. Any folder in a repository: the project or a
// task's copy.
// A remote project's root (ssh://…) goes to the same operations run on its
// host (remoteFs.js).
const scmFor = (q) => (remoteArg(q) ? remoteFs.scm : scm)
ipcMain.handle('scm:status', safe((q) => scmFor(q).scmStatus(q || {})))
ipcMain.handle('scm:stage', safe((q) => scmFor(q).scmStage(q || {})))
ipcMain.handle('scm:unstage', safe((q) => scmFor(q).scmUnstage(q || {})))
ipcMain.handle('scm:discard', safe((q) => scmFor(q).scmDiscard(q || {}, (p) => shell.trashItem(p))))
ipcMain.handle('scm:commit', safe((q) => scmFor(q).scmCommit(q || {})))
ipcMain.handle('scm:push', safe((q) => scmFor(q).scmPush(q || {})))
ipcMain.handle('scm:pull', safe((q) => scmFor(q).scmPull(q || {})))
ipcMain.handle('scm:fetch', safe((q) => scmFor(q).scmFetch(q || {})))
ipcMain.handle('scm:sync', safe((q) => scmFor(q).scmSync(q || {})))
ipcMain.handle('scm:fileVersions', safe((q) => scmFor(q).scmFileVersions(q || {})))
// The branch against its base (Orca's branch context row), the Commits
// section and the files of one commit.
ipcMain.handle('scm:branchCompare', safe((q) => scmFor(q).scmBranchCompare(q || {})))
ipcMain.handle('scm:history', safe((q) => scmFor(q).scmHistory(q || {})))
ipcMain.handle('scm:commitFiles', safe((q) => scmFor(q).scmCommitFiles(q || {})))
// A commit message written by an agent from the staged diff (Orca's Generate).
// The agents run on this machine: not for a remote project yet.
const commitMessageGeneration = createCommitMessageGeneration({ scm, runHeadless, cancelHeadless })
ipcMain.handle('scm:generate', safe(async (q) => {
  if (remoteArg(q)) return remoteFs.remoteOnly()
  return commitMessageGeneration.generate(q || {})
}))
ipcMain.handle('scm:cancelGenerate', safe(async (q) => {
  if (remoteArg(q)) return { ok: false }
  return commitMessageGeneration.cancel(q || {})
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
// Cards deleted on the board: out of every copy published in a project.
ipcMain.handle('team:forget-tasks', safe(forgetPublishedTasks))
ipcMain.handle('team:roster', safe(writeRoster))
ipcMain.handle('team:requests', safe(takeTeamRequests))
ipcMain.handle('team:requests-done', safe(finishTeamRequests))
ipcMain.handle('team:requests-release', safe(releaseTeamRequests))
ipcMain.handle('team:board-panes', safe((args) => writeBoardPanes({ ...args, owner: TEAM_OWNER })))
ipcMain.handle('team:message-status', safe(messageStatuses))
ipcMain.handle('team:tools-alive', safe(toolsAlive))
// Orchestration: answers to a coordinator's worker requests, the workers list.
ipcMain.handle('team:answer', safe(writeTeamAnswer))
ipcMain.handle('team:workers', safe(publishWorkers))

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
    return hooksStatus({
      sessionsDir: sessionsDir(),
      scriptPath: join(app.getPath('appData'), 'tessel-team', 'tessel-team-mcp.cjs'),
      configDirs: await hookConfigDirs(),
      states: agentStateStore.snapshot(),
      env: freshEnv()
    })
  })
)
// Where Claude Code's and Codex's hooks are (their account's folder, if any).
async function hookConfigDirs() {
  const codex = await accounts.sessionEnv('codex')
  const claude = await accounts.sessionEnv('claude')
  return {
    codex: codex.env?.CODEX_HOME || process.env.CODEX_HOME || join(os.homedir(), '.codex'),
    claude: claude.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude')
  }
}

// Settings > "Remove Tessel hooks": every hook, plugin and extension Tessel
// added to the agents (status and team messages), and the copies it kept of
// their files (<file>.before-tessel). Its MCP servers stay. They come back
// the next time Tessel sets up the team tools or starts one of these agents.
// -> { ok, changed: [file], errors: [message] }
ipcMain.handle(
  'team:removeHooks',
  safe(async () => {
    const changed = []
    const errors = []
    const env = freshEnv()
    for (const agent of STATUS_HOOK_AGENTS) {
      const r = removeStatusHooks(agent, { env })
      if (r.error) errors.push(r.error)
      else if (r.changed) changed.push(agent)
    }
    const team = await removeTeamHooks(os.homedir(), { configDirs: await hookConfigDirs() })
    changed.push(...team.changed)
    errors.push(...team.errors)
    if (changed.length) log.info('team', `Tessel hooks removed: ${changed.join('; ')}`)
    if (errors.length) log.error('team', `Tessel hooks removal: ${errors.join('; ')}`)
    return { ok: errors.length === 0, changed, errors }
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
    // Hooks and MCP servers run node by its absolute path, never by name (a
    // node.exe in the project folder would run instead): none found, nothing
    // is set up.
    const node = findNode({ env: freshEnv() })
    if (!node) {
      log.error('team', 'team tools: no absolute node on PATH, nothing set up')
      let installed = teamServerSource
      try {
        installed = fs.readFileSync(script, 'utf8')
      } catch {
        // not readable: ours
      }
      return { ok: false, script, changed, errors: [noNodeError()], version: (/const VERSION = '([^']+)'/.exec(installed) || [])[1] || null }
    }
    if (!claudeServerPresent(script, undefined, node)) {
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
        commandLine: `"${node}" "${script}"`,
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
      const r = installClaudeHooks(script, undefined, { node })
      if (r.error) errors.push(t('main.hooks.claudeFailed', 'Claude Code hooks: {{error}}', { error: r.error }))
      else if (r.changed) changed.push('Claude Code: hooks for team messages')
    } catch (err) {
      errors.push(t('main.hooks.claudeFailed', 'Claude Code hooks: {{error}}', { error: err.message }))
    }
    try {
      const r = await installCodexServer(script, validateCodexConfig, undefined, { node })
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
        const r = installCodexHooks(script, undefined, { node })
        if (r.error) errors.push(t('main.hooks.codexFailed', 'Codex hooks: {{error}}', { error: r.error }))
        else if (r.changed) changed.push('Codex: hooks (current conversation)')
      }
    } catch (err) {
      errors.push(t('main.hooks.codexFailed', 'Codex hooks: {{error}}', { error: err.message }))
    }
    // Gemini CLI hooks: its conversation, and its team messages while it works
    // and when it finishes a turn (never typed). Only where it is installed.
    try {
      const gemini = (await getAgents()).find((a) => a.id === 'gemini')
      if (gemini && gemini.available) {
        const r = installGeminiHooks(script, undefined, { node })
        if (r.error) errors.push(t('main.hooks.geminiFailed', 'Gemini CLI hooks: {{error}}', { error: r.error }))
        else if (r.changed) changed.push('Gemini CLI: hooks (team messages, current conversation)')
      }
    } catch (err) {
      errors.push(t('main.hooks.geminiFailed', 'Gemini CLI hooks: {{error}}', { error: err.message }))
    }
    // Copilot CLI hooks, in their own file: the same, where it is installed.
    try {
      const copilot = (await getAgents()).find((a) => a.id === 'copilot')
      if (copilot && copilot.available) {
        const r = installCopilotHooks(script, undefined, { node })
        if (r.error) errors.push(t('main.hooks.copilotFailed', 'Copilot CLI hooks: {{error}}', { error: r.error }))
        else if (r.changed) changed.push('Copilot CLI: hooks (team messages, current conversation)')
      }
    } catch (err) {
      errors.push(t('main.hooks.copilotFailed', 'Copilot CLI hooks: {{error}}', { error: err.message }))
    }
    // OpenCode plugin: its conversation, messages after a tool, and when idle
    // (woken through its own API, never typed). Where it is installed.
    try {
      const opencode = (await getAgents()).find((a) => a.id === 'opencode')
      if (opencode && opencode.available) {
        const r = installOpencodePlugin(script, undefined, { node })
        if (r.error) errors.push(t('main.hooks.opencodeFailed', 'OpenCode plugin: {{error}}', { error: r.error }))
        else if (r.changed) changed.push('OpenCode: plugin (team messages, current conversation)')
      }
    } catch (err) {
      errors.push(t('main.hooks.opencodeFailed', 'OpenCode plugin: {{error}}', { error: err.message }))
    }
    try {
      const kimi = (await getAgents()).find((a) => a.id === 'kimi')
      if (kimi && kimi.available) {
        const r = await installKimiHooks(script, undefined, { node })
        if (r.error) errors.push(t('main.hooks.kimiFailed', 'Kimi Code hooks: {{error}}', { error: r.error }))
        else if (r.changed) changed.push('Kimi Code: hooks (team messages, current conversation)')
      }
    } catch {
      errors.push(t('main.hooks.kimiInstallIncomplete', 'Kimi Code hooks: installation could not be completed.'))
    }
    // Gemini CLI, Qwen Code, Copilot CLI, OpenCode, Cline: in their settings file,
    // for those installed here (a file Tessel cannot read is left alone).
    for (const agent of JSON_AGENTS) {
      const preset = (await getAgents()).find((a) => a.id === agent)
      if (!preset || !preset.available) continue
      const r = setJsonAgentServer(agent, SERVER_NAME, teamToolsEntry(agent, script, node))
      if (!r.ok) errors.push(`${preset.name}: ${r.error}`)
      else if (r.changed) changed.push(`${preset.name}: MCP server tessel-team`)
    }
    // The task board rule in each installed agent's persistent memory
    // (CLAUDE.md, AGENTS.md...: read every session), see agentMemory.js.
    for (const preset of await getAgents()) {
      if (!preset.available || preset.custom) continue
      const r = writeBoardRule(preset.id)
      if (r.error) errors.push(t('main.hooks.memoryFailed', '{{agent}}: memory file {{file}}: {{error}}', { agent: preset.name, file: r.file, error: r.error }))
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
// Agent updates run in the background here, not in a pane
// (agentUpdateRunner.js): same commands and environment as a pane's (the
// terminals' fresh environment, without Tessel's per-agent variables), output
// in the same install log. Each attempt (background or pane) goes to the
// update history shown in Settings > Agents (agentUpdateHistory.js).
const agentUpdateHistory = createUpdateHistory({
  file: join(app.getPath('userData'), 'agent-update-history.json'),
  log: (level, message) => log[level === 'warn' ? 'warn' : 'info']('agents', message)
})
function updateEnv() {
  const env = freshEnv()
  for (const key of Object.keys(env)) if (/^TESSEL_AGENT_/i.test(key)) delete env[key]
  return env
}
// TESSEL_AGENT_UPDATES_FAKE: nothing is ever started; each fake agent's
// `run` ({ output, exitCode, delayMs, hang }) is played instead.
function fakeRunOf(agentId) {
  try {
    const data = JSON.parse(fs.readFileSync(process.env.TESSEL_AGENT_UPDATES_FAKE, 'utf8'))
    const f = (data.agents || []).find((a) => a && a.id === agentId)
    return (f && f.run) || {}
  } catch {
    return {}
  }
}
const agentUpdateRunner = createUpdateRunner({
  spawn: process.env.TESSEL_AGENT_UPDATES_FAKE
    ? (file, args, opts) => fakeSpawn(() => fakeRunOf(agentUpdateRunner.busy()))(file, args, opts)
    : spawn,
  getEnv: updateEnv,
  logs: { start: (q) => installLogs.start(q), onData: (id, d) => installLogs.onData(id, d), end: (id, ok, r) => installLogs.end(id, ok, r) },
  // The tree this run started, by its PID (never by image name).
  killTree: (pid) =>
    process.platform === 'win32'
      ? execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
      : process.kill(pid, 'SIGKILL'),
  cwd: os.homedir(),
  timeoutMs: Number(process.env.TESSEL_AGENT_UPDATE_TIMEOUT_MS) || undefined,
  log: (level, message) => log[level === 'warn' ? 'warn' : 'info']('agents', message)
})

// After an attempt: the version it now reports (a fresh check), then the
// history entry. -> { entry, row }
async function recordAgentUpdate({ agentId, name, from, to, ok, kind, detail, reason, file, via, auto }) {
  let row = null
  if (ok) {
    const r = await checkAgentUpdates({ force: false }).catch(() => null)
    row = r && r.agents ? r.agents[agentId] || null : null
  }
  const version = row && row.installed ? row.installed : ''
  // It ran fine but still reports the old version (another copy runs first).
  const same = ok && version && from && version === from
  const entry = agentUpdateHistory.add({
    agentId,
    name,
    at: Date.now(),
    ok: ok && !same,
    kind: ok ? (same ? 'same-version' : 'ok') : kind || 'failed',
    from,
    to,
    version,
    detail,
    reason,
    file,
    via,
    auto
  })
  log[entry && entry.ok ? 'info' : 'warn'](
    'agents',
    `update ${agentId} (${via}): ${entry ? entry.kind : '?'}${reason ? ` (${reason})` : ''}${file ? `, log ${file}` : ''}`
  )
  send('agentUpdates:history', agentUpdateHistory.get())
  return { entry, row }
}

// A pane's update ended (install log): classified from the end of its log.
function recordPaneUpdate(r) {
  const u = r.agentUpdate
  let kind = r.ok === true ? 'ok' : r.locked ? 'in-use' : 'failed'
  let detail = ''
  if (r.ok !== true && r.file) {
    try {
      const text = fs.readFileSync(r.file, 'utf8').slice(-64 * 1024)
      const c = classifyFailure({ output: text })
      kind = c.kind
      detail = c.detail
    } catch {
      /* no log: kind from the pane's own flag */
    }
  }
  const row = agentUpdates.status() && agentUpdates.status().agents ? agentUpdates.status().agents[u.agentId] : null
  return recordAgentUpdate({
    agentId: u.agentId,
    name: (row && row.name) || r.name,
    from: u.from,
    to: u.to,
    ok: r.ok === true,
    kind,
    detail,
    reason: r.reason,
    file: r.file,
    via: 'pane',
    auto: false
  })
}

ipcMain.handle('agentUpdates:history', () => agentUpdateHistory.get())
// Update one agent in the background. Its steps come from the last check
// (never from the window). Progress: 'agentUpdates:progress'
// { agentId, state: 'running' | 'succeeded' | 'failed', kind?, detail?, file? }.
// -> { ok, kind?, detail?, reason, file, locked?, version?, row? }
ipcMain.handle('agentUpdates:run', async (_evt, q = {}) => {
  const agentId = q && typeof q.agentId === 'string' ? q.agentId : ''
  const status = agentUpdates.status()
  const row = status && status.agents ? status.agents[agentId] : null
  if (!row || !Array.isArray(row.steps) || !row.steps.length) return { ok: false, kind: 'failed', reason: t('main.agentUpdate.noneKnown', 'no update known for this agent') }
  if (agentUpdateRunner.busy()) return { ok: false, kind: 'busy', reason: t('main.agentUpdate.otherBusy', 'another agent is being updated') }
  const from = row.installed || ''
  const to = row.latest || ''
  send('agentUpdates:progress', { agentId, state: 'running', from, to })
  const res = await agentUpdateRunner.run({ agentId, name: row.name, steps: row.steps })
  if (res.kind === 'busy') return res
  const { entry, row: after } = await recordAgentUpdate({
    agentId,
    name: row.name,
    from,
    to,
    ok: res.ok,
    kind: res.kind,
    detail: res.detail,
    reason: res.reason,
    file: res.file,
    via: 'background',
    auto: !!(q && q.auto)
  })
  send('agentUpdates:progress', {
    agentId,
    state: res.ok ? 'succeeded' : 'failed',
    kind: entry ? entry.kind : res.kind,
    detail: res.detail || '',
    file: res.file
  })
  return {
    ...res,
    ...(res.kind === 'in-use' ? { locked: true } : {}),
    ...(after ? { version: after.installed || '', row: after } : {})
  }
})
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
      hooks = hooksStatus({ sessionsDir: sessionsDir(), scriptPath, env: freshEnv() })
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
// The built-in browser (browserGuest.js): its pages' rules, Design Mode
// (pick an element, screenshots saved next to pasted images).
const browserGuests = createBrowserGuests({
  getWindow: () => mainWindow,
  send,
  log,
  screenshotDir: PASTE_DIR,
  electron: { webContents, clipboard, nativeImage, session, Menu },
  // "Open Link in Default Browser" of a page's right-click menu (http(s)).
  openExternal: (url) => {
    if (isSafeExternal(url)) shell.openExternal(url).catch(() => {})
  },
  // Each page's console, for the agents' browser tools.
  onGuest: (guest) => agentBrowser.watchGuest(guest)
})
browserGuests.register(ipcMain)
// Agents driving the browser's pages (agentBrowser.js): the browser_* tools
// of teamMcp/server.cjs, over the tessel command's pipe ('browser' below),
// each request signed by its pane's team secret.
// Off until the window says what the setting is (its first report comes at start).
let agentBrowserEnabled = false
const agentBrowser = createAgentBrowser({
  verify: (body, paneId) => verifyRequest(body, paneId, 'browser'),
  enabled: () => agentBrowserEnabled,
  ask: (method, params) => cliBridge.ask(method, params),
  guestById: (id) => browserGuests.guestById(id),
  send,
  nativeImage,
  // Its own folder: only the latest agent screenshots are kept there.
  screenshotDir: join(PASTE_DIR, 'agent-browser'),
  log
})
// Settings > Agents > Let agents use the browser (the window says it at
// start and on each change).
ipcMain.handle('browser:agentSettings', (event, opts) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false
  agentBrowserEnabled = !!(opts && opts.enabled === true)
  // Turned off: every page an agent drives is let go now.
  if (!agentBrowserEnabled) agentBrowser.releaseAll()
  return true
})
// The Stop on a page's "Agent" badge.
ipcMain.handle('browser:agentStop', (event, id) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false
  return agentBrowser.stop(id)
})
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
  if (isRemotePath(file)) return remoteFs.remoteOnly()
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
// Paths named in the native chat (chatFileOpen.js): which exist (a bounded
// batch), and a folder or a media / document file opened with the system,
// re-checked here (local, absolute, never a program or a script).
ipcMain.handle('chatFiles:stat', (_evt, q = {}) => statChatPaths(q || {}))
ipcMain.handle('chatFiles:open', (_evt, q = {}) => openChatPath(q || {}, { shell }))
ipcMain.handle('chatFiles:reveal', (_evt, q = {}) => revealChatPath(q || {}, { shell }))
// The file explorer (explorer.js): folders, git status, a few changes, and a
// watch per project (the window is told when files change).
// A remote project (ssh://… root): the same operations on its host
// (remoteFs.js); delete goes to the host user's trash.
const explorerFor = (q) => (remoteArg(q) ? remoteFs : explorer)
ipcMain.handle('explorer:list', safe((q) => explorerFor(q).listDir(q || {})))
ipcMain.handle('explorer:status', safe((q) => explorerFor(q).projectStatus(q || {})))
// A sparse checkout's folders, offered as the tree's root.
ipcMain.handle('explorer:sparse', safe((q) => explorerFor(q).sparseInfo(q || {})))
// Search the project: file names (also in folders not opened yet), or contents.
ipcMain.handle('explorer:searchNames', safe((q) => explorerFor(q).searchNames(q || {})))
ipcMain.handle('explorer:searchContent', safe((q) => explorerFor(q).searchContent(q || {})))
ipcMain.handle('explorer:create', safe((q) => explorerFor(q).create(q || {})))
ipcMain.handle('explorer:rename', safe((q) => explorerFor(q).rename(q || {})))
ipcMain.handle('explorer:trash', safe((q) => (remoteArg(q) ? remoteFs.trash(q) : explorer.trash(q || {}, (p) => shell.trashItem(p)))))
ipcMain.handle('explorer:reveal', safe((q) => {
  if (remoteArg(q)) return remoteFs.remoteOnly()
  const p = q && explorer.inside(q.root, q.path)
  if (!p || !fs.existsSync(p)) return { ok: false, error: t('main.error.notFound', 'Not found.') }
  shell.showItemInFolder(p)
  return { ok: true }
}))
const explorerWatches = new Map() // root -> stop
ipcMain.handle('explorer:watch', (_evt, root) => {
  // A remote project is polled (nothing like a file watch reaches over ssh);
  // one project watched at a time, local or remote.
  if (isRemotePath(root)) {
    for (const stop of explorerWatches.values()) stop()
    explorerWatches.clear()
    return remoteFs.watchRoot(root)
  }
  remoteFs.unwatchRoots()
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
  remoteFs.unwatchRoots()
  return { ok: true }
})

// The file viewer (fileView.js): read a file to show it; a PDF in its own window.
ipcMain.handle('files:view', (_evt, file) => {
  if (isRemotePath(file)) return remoteFs.remoteOnly()
  try {
    return readForView(file)
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
ipcMain.handle('files:viewImage', async (_evt, file) => {
  try {
    return isRemotePath(file) ? await remoteFs.readImage(file) : readImageForView(file)
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
ipcMain.handle('files:openPdf', (_evt, file) =>
  isRemotePath(file) ? remoteFs.remoteOnly() : openPdfWindow(BrowserWindow, file, { icon: fs.existsSync(appIconPath()) ? appIconPath() : null })
)

// Tessel's code editor (editorFiles.js): read, write (atomic), the last
// committed version, and a watch on the open files (the window is told when
// one changes on disk; Tessel's own saves are not reported back).
const editorWatcher = createFileWatcher((change) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('editor:changed', change)
})
// A file of a remote project (ssh://…): read and written on its host
// (remoteFs.js: size cap, conflict check, atomic replace there), watched by
// polling.
ipcMain.handle('editor:read', safe((file) => (isRemotePath(file) ? remoteFs.readForEdit(file) : readForEdit(file))))
ipcMain.handle('editor:stat', safe((file) => (isRemotePath(file) ? remoteFs.statForEdit(file) : statForEdit(file))))
ipcMain.handle('editor:write', safe(async (q) => {
  if (remoteArg(q && q.file)) return remoteFs.writeForEdit(q || {})
  const res = await writeForEdit(q || {})
  if (res.ok) editorWatcher.noteWritten(q.file, res.sig)
  return res
}))
ipcMain.handle('editor:head', safe((file) => (isRemotePath(file) ? remoteFs.headContent(file) : headContent(file))))
ipcMain.handle('editor:watch', safe((paths) => {
  const list = Array.isArray(paths) ? paths : []
  const remote = list.filter((p) => isRemotePath(p))
  const count = editorWatcher.set(list.filter((p) => !isRemotePath(p))) + remoteFs.watchFiles(remote)
  return { ok: true, count }
}))
// Closing the window quits Tessel: the window asks first (closeGuard.js), for
// unsaved editor files (Save, Don't Save, Cancel) and for running agents and
// terminals (Settings > General). Quitting for an update was asked about
// beforehand; a Windows shutdown or a page that cannot answer is never held.
let appQuitting = false
const closeGuard = createCloseGuard({ isQuitting: () => appQuitting, log })
ipcMain.on('editor:closeAck', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
  closeGuard.ack()
})
ipcMain.on('editor:closeWindow', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
  closeGuard.allow(mainWindow)
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
      TESSEL_LOG_DIR: log.dir,
      // The SSH host keys the user accepts (ssh/hostKeyStore.js).
      TESSEL_SSH_HOSTKEYS: join(app.getPath('userData'), SSH_HOST_KEYS_FILE)
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
    // An agent update run in a pane: its attempt goes to the update history.
    if (r.agentUpdate) recordPaneUpdate(r).catch(() => {})
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
    revokeTeamSecret(id)
    installLogs.onExit(id, exitCode)
    sshAskpass.paneExited(id)
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
  // ssh2 connections, channels and questions (ssh/sshRemote.js).
  onEvent: (msg) => sshRemote.onEvent(msg),
  onConnected: () => {
    void sshRemote.onConnected()
  },
  onLost: () => {
    sshRemote.onLost()
    if (quitting) return
    log.error('pty', 'lost the connection to the terminal host')
    // Its terminals are gone with it: tell the panes.
    for (const id of ptyInfo.keys()) {
      void agentStateStore.unregister(id).catch(() => {})
      sshAskpass.paneExited(id)
      remoteHosts.paneExited(id, -1)
      send('pty:exit', { id, exitCode: -1, signal: 0 })
    }
    ptyInfo.clear()
  }
})

ipcMain.handle('pty:create', async (_evt, opts = {}) => {
  const launchCancelled = () => ({
    ok: false,
    cancelled: true,
    error: t('main.remote.launchCancelled', 'The terminal was closed before ssh started.')
  })
  const { id, shellId, cols = 80, rows = 24, cwd, projectDir } = opts
  if (!id) throw new Error('pty:create requires an id') // i18n-ignore internal: programming error
  const shell = getShells().find((s) => s.id === shellId) || defaultShell()
  // A pane on a remote host: a shell channel on the host's shared ssh2
  // connection (in the terminal host), or, for a host that needs the system
  // ssh (ProxyJump, ProxyCommand…), ssh.exe with the argv built from the
  // saved host.
  if (opts.remoteHostId) {
    const startedAt = Date.now()
    const target = remoteHosts.get(String(opts.remoteHostId))
    if (!target) return { ok: false, error: t('main.remote.notFound', 'This remote host is no longer saved in Tessel.') }
    // A terminal opened on the host (a new pane, or Connect in a restored
    // one): its Files / Changes session may sign in too from now on.
    remoteFs.allow(target.id)
    const mode = await sshRemote.modeFor(target)
    if (mode.mode === 'ssh2') return createSshPane(opts, target, mode.spec, shell, startedAt)
    // Closed while that was decided: nothing is started.
    if ((paneKills.get(id) || 0) >= startedAt) return launchCancelled()
  }
  let remote = opts.remoteHostId ? remoteHosts.launchFor(String(opts.remoteHostId)) : null
  if (remote && !remote.ok) return { ok: false, error: remote.error }
  // A project on that host (remoteProject.js): the terminal starts in its folder.
  if (remote && opts.remotePath) {
    remote = remoteProjectLaunch(remote, opts.remotePath)
    if (!remote.ok) return { ok: false, error: t('main.project.remotePathInvalid', 'This remote folder path is not valid. Use an absolute path like /home/user/project or ~/project.') }
  }
  const startDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir()
  const useConpty = shouldUseConpty()
  const backend = useConpty ? 'conpty' : 'winpty'
  // Its agent's variables and its provider account's (see paneEnv.js).
  const env = paneEnv(freshEnv(), opts)
  // The agents whose own hooks report their status (agentStateModel.js).
  const agentProvider = STATUS_PROVIDERS.includes(opts.agentId) ? opts.agentId : null
  const agentLaunchToken = agentProvider ? crypto.randomBytes(16).toString('hex') : null
  // The Codex home this launch reads and writes (its account's, if any): where
  // its session rollout is (codexTurnEnd.js).
  const agentCodexHome = agentProvider === 'codex'
    ? Object.entries(env).find(([key]) => key.toUpperCase() === 'CODEX_HOME')?.[1] || join(os.homedir(), '.codex')
    : null
  // This launch's team secret (teamAuth.js): the team tools MAC their
  // requests with it. Only in the pane's environment and in memory (here and
  // in the terminal host), never on disk or in a log.
  const teamSecret = newTeamSecret()
  const agentStartedAt = Date.now()
  // Do not let inherited Tessel identity bind a nested app to another launch.
  for (const key of Object.keys(env)) if (/^TESSEL_AGENT_|^TESSEL_TEAM_SECRET$/i.test(key)) delete env[key]
  let agentStatusWarning = null
  if (agentProvider) {
    const setup = await prepareStatus(agentProvider, env, opts.hookOptIn)
    if (!setup.ok) agentStatusWarning = setup.error
  }
  // The agent does not stop at "Do you trust this folder?" in a folder the
  // user chose in Tessel (agentFolderTrust.js decides which; never throws).
  if (opts.agentId && cwd === startDir) {
    await agentFolderTrust.apply({
      agentId: opts.agentId,
      cwd: startDir,
      env,
      enabled: opts.agentFolderTrust === true,
      remote: !!remote,
      wsl: shell.id === 'wsl' || /[\\/]wsl\.exe$/i.test(String(shell.file || ''))
    })
  }
  // ssh's questions go to Tessel's askpass helper (sshAskpass.js). 'fallback'
  // (old ssh, no helper): ssh asks in the terminal. 'cancelled': the pane was
  // closed or launched again meanwhile: ssh is not started at all.
  const launch = remote ? await sshAskpass.prepareLaunch(id, { hostId: remote.target.id, label: remote.name, sshExe: remote.file }) : null
  if (launch && launch.status === 'cancelled') return launchCancelled()
  const askpassEnv = launch && launch.status === 'ready' ? launch.env : null
  // This launch's own token: its success / failure touches only it.
  const askpassToken = askpassEnv ? askpassEnv.TESSEL_ASKPASS_TOKEN : undefined
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
        TESSEL_TEAM_SECRET: teamSecret,
        // Where this Tessel's command pipe is described (cli-runtime.json):
        // the browser tools reach this Tessel, not another one.
        TESSEL_RUNTIME_DIR: app.getPath('userData'),
        ...(agentProvider ? { TESSEL_AGENT_PROVIDER: agentProvider, TESSEL_AGENT_LAUNCH: agentLaunchToken, TESSEL_AGENT_STATE_DIR: agentStateDir } : {}),
        ...(projectDir && isAbsolute(projectDir) && fs.existsSync(projectDir) ? { TESSEL_PROJECT_DIR: projectDir } : {}),
        ...(askpassEnv || {})
      },
      cols,
      rows,
      useConpty,
      // ConPTY is required for full-screen TUIs like Claude Code to redraw on
      // resize. Set TESSEL_USE_WINPTY=1 only as a fallback.
      meta: { shellId: shell.id, shellName: shell.name, backend, cwd: startDir, agentProvider, agentLaunchToken, agentStartedAt, agentCodexHome, teamSecret, remoteHostId: remote ? remote.target.id : null }
    })
  } catch (err) {
    res = { ok: false, error: err.message }
  }
  if (!res.ok) {
    if (askpassToken) sshAskpass.releasePane(id, askpassToken)
    log.error('pty', `failed to launch ${shell.name} (${shell.file}) in ${startDir}: ${res.error}`)
    return { ok: false, error: t('main.error.launchShell', 'Failed to launch {{shell}}: {{error}}', { shell: shell.name, error: res.error }) }
  }
  // Closed while the terminal was being created: end the ssh it started (the
  // kill went to the host before this terminal existed). Launched again
  // meanwhile: the newer launch owns the pane, left alone.
  if (launch) {
    const state = sshAskpass.launchState(id, launch.lease)
    if (state !== 'current') {
      if (askpassToken) sshAskpass.releasePane(id, askpassToken)
      if (state === 'released') host.send('kill', { id })
      return launchCancelled()
    }
  }
  ptyInfo.set(id, { shellId: shell.id, shellName: shell.name, backend, pid: res.pid, agentLaunchToken, agentCodexHome })
  // A relaunch replaces the previous secret: the old one is void.
  setTeamSecret(id, teamSecret)
  if (remote) {
    // "Connecting…" while ssh logs in (sshAskpass.js decides when it is
    // through); without askpass, connected at once as before.
    remoteHosts.paneStarted(id, remote.target.id, { connected: !askpassEnv })
    if (askpassToken) sshAskpass.paneStarted(id, askpassToken)
  }
  if (agentProvider) {
    try { await agentStateStore.register({ paneId: id, provider: agentProvider, launchToken: agentLaunchToken, startedAt: agentStartedAt }) }
    catch { agentStatusWarning = t('main.agents.statusUnavailable', 'Agent status observations are unavailable.') }
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

// A terminal on an SSH host over the shared ssh2 connection (the terminal
// host opens the shell channel; its questions come as ssh-prompt events).
// pty:kill times, so a pane closed while its ssh terminal was being created
// ends it (the kill reached the host before the terminal existed).
const paneKills = new Map() // id -> time
async function createSshPane(opts, target, spec, shell, startedAt) {
  const { id, cols = 80, rows = 24 } = opts
  let remotePath = null
  if (opts.remotePath) {
    const checked = validateRemotePath(opts.remotePath)
    if (checked.error) return { ok: false, error: t('main.project.remotePathInvalid', 'This remote folder path is not valid. Use an absolute path like /home/user/project or ~/project.') }
    remotePath = checked.path
  }
  // Also voids an askpass launch still being prepared for this pane.
  sshAskpass.releasePane(id)
  const startDir = os.homedir()
  const teamSecret = newTeamSecret()
  let res
  try {
    res = await host.request('create', {
      id,
      file: 'ssh',
      args: [],
      cwd: startDir,
      env: {},
      cols,
      rows,
      ssh: sshRemote.terminalRequest(target, spec, remotePath),
      meta: { shellId: shell.id, shellName: shell.name, backend: 'ssh', cwd: startDir, agentProvider: null, agentLaunchToken: null, agentStartedAt: Date.now(), agentCodexHome: null, teamSecret, remoteHostId: target.id }
    })
  } catch (err) {
    res = { ok: false, error: err.message }
  }
  if (!res.ok) {
    log.error('pty', `failed to open an ssh terminal on ${target.id}: ${res.error}`)
    return { ok: false, error: t('main.error.launchShell', 'Failed to launch {{shell}}: {{error}}', { shell: target.label, error: res.error }) }
  }
  if ((paneKills.get(id) || 0) >= startedAt) {
    host.send('kill', { id })
    return { ok: false, cancelled: true, error: t('main.remote.launchCancelled', 'The terminal was closed before ssh started.') }
  }
  ptyInfo.set(id, { shellId: shell.id, shellName: shell.name, backend: 'ssh', pid: null, agentLaunchToken: null, agentCodexHome: null })
  setTeamSecret(id, teamSecret)
  remoteHosts.paneStarted(id, target.id, { ssh2: true })
  return {
    ok: true,
    shell: { id: shell.id, name: shell.name },
    backend: 'ssh',
    windowsBuild: windowsBuildNumber(),
    pid: null,
    cwd: startDir,
    agentLaunchToken: null,
    agentStatusWarning: null,
    remoteHost: { id: target.id, label: target.label }
  }
}

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
  ptyInfo.set(id, { shellId: res.shellId, shellName: res.shellName, backend: res.backend, pid: res.pid, agentLaunchToken: res.agentLaunchToken, agentCodexHome: typeof res.agentCodexHome === 'string' ? res.agentCodexHome : null })
  // Still running since before: its team secret comes back from the host.
  if (res.exited) revokeTeamSecret(id)
  else setTeamSecret(id, res.teamSecret)
  if (res.remoteHostId && !res.exited) remoteHosts.paneStarted(id, res.remoteHostId, { ssh2: res.backend === 'ssh' })
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
      revokeTeamSecret(id)
      closed++
    }
  }
  if (closed) log.info('pty', `closed ${closed} terminal(s) no pane was using`)
  return closed
})

ipcMain.on('pty:write', (_evt, { id, data }) => host.send('write', { id, data }))

// Reset Terminal: the host clears the modes in its own copy of the screen (an
// older host ignores the unknown op; the pane still resets itself).
ipcMain.on('pty:resetModes', (_evt, { id } = {}) => host.send('resetModes', { id }))

ipcMain.on('pty:resize', (_evt, { id, cols, rows }) => {
  if (cols > 0 && rows > 0) host.send('resize', { id, cols, rows })
})

ipcMain.on('pty:kill', (_evt, { id }) => {
  paneKills.set(id, Date.now())
  if (paneKills.size > 500) paneKills.delete(paneKills.keys().next().value)
  remoteHosts.paneClosing(id)
  // Also voids a launch still being prepared for it.
  sshAskpass.releasePane(id)
  host.send('kill', { id })
  ptyInfo.delete(id)
  revokeTeamSecret(id)
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
    revokeTeamSecret(id)
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

// Is the window on screen (shown, not minimized)?
function windowShown() {
  return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
}
ipcMain.handle('window:shown', () => windowShown())

// Also every 30 s, and when Windows signs out or shuts down, so a reboot or
// power loss still leaves recent output to show next time.
setInterval(() => {
  if (host.connected && !quitting) saveScrollback()
}, 30000).unref()
app.on('session-end', () => {
  closeGuard.sessionEnding()
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
    // Installing: the window closes without asking (the user chose to install).
    appQuitting = true
    // The chat agents too: before-quit skips its shutdown after this one.
    await Promise.allSettled([shutdownTerminals(), chatSessions.closeAll({ kill: true })])
    shutdownDone = true
  },
  // The installer never started: back to a normal running app (the
  // terminals start again as panes restart or reattach).
  onInstallFailed: () => {
    shutdownDone = false
    quitting = false
    appQuitting = false
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
  windowTheme = theme.slice(0, 64)
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

// Every webContents Electron creates (the window, the built-in browser's
// pages, the PDF viewer, DevTools): only Tessel's window may hold <webview>
// pages (browserGuest.js then checks which), and no page opens a window. The
// window and the browser's pages set their own window rule after this one,
// which replaces it (setWindowOpenHandler keeps the last handler).
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || contents !== mainWindow.webContents) event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
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
      // The built-in browser's pages (<webview>): each one is checked and
      // locked down when it attaches (browserGuest.js).
      webviewTag: true,
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
  browserGuests.attachToWindow(mainWindow)
  mainWindow.maximize()

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logCrashContext(`renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })

  mainWindow.webContents.on('responsive', () => {
    closeGuard.setUnresponsive(false)
    log.info('window', 'responsive again')
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) =>
    log.error('window', `failed to load ${url}: ${desc} (${code})`)
  )
  mainWindow.webContents.on('unresponsive', () => {
    closeGuard.setUnresponsive(true)
    logCrashContext('renderer unresponsive')
  })

  mainWindow.on('focus', () => {
    if (mainWindow) mainWindow.flashFrame(false)
  })
  // Minimized or hidden: told to the window. With background throttling off
  // (above), its page stays "visible" and keeps drawing at 60 frames a
  // second while minimized; the page uses this to pause what nobody sees
  // (windowVisibility.js), as Orca's window does with its visibility.
  for (const name of ['minimize', 'restore', 'hide', 'show']) mainWindow.on(name, () => send('window:shown', windowShown()))
  // The window asks before it closes (unsaved editor files, running agents
  // and terminals; see closeGuard.js). Never while the app is quitting (an
  // update asked already), Windows shuts down, or the page cannot answer.
  mainWindow.on('close', (event) => closeGuard.onClose(event, mainWindow))
  // Windows asks whether it may end the session: never refused (no
  // preventDefault), and the window then closes without asking.
  mainWindow.on('query-session-end', () => closeGuard.sessionEnding())
  mainWindow.on('session-end', () => closeGuard.sessionEnding())
  // A new page (reload) or a crashed one: a question it got is dropped.
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details && details.isMainFrame && !details.isSameDocument) {
      closeGuard.pageGone()
      // A reloading page starts no run until it says it is ready again.
      automations.setWindowReady(false)
      cliBridge.windowGone()
    }
  })
  mainWindow.webContents.on('render-process-gone', () => {
    closeGuard.pageGone()
    automations.setWindowReady(false)
    cliBridge.windowGone()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    automations.setWindowReady(false)
    cliBridge.windowGone()
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

// --- The tessel command (Settings > General > Tessel CLI) ---------------------------
// cliServer.js: the pipe (current user only, served by the askpass helper), its
// token and the checks; cliBridge.js: what the window answers; cliInstall.js:
// tessel.cmd and the user PATH. What the command can do is listed in cliServer.js.
// The command's files with a secret (token, runtime file): this user only,
// with a Medium integrity label that refuses reads from low-integrity
// processes too (the helper's --protect mode; icacls as a fallback).
function restrictToUser(file) {
  if (process.platform !== 'win32') return
  const helper = askpassExePath(__dirname)
  const icacls = () =>
    execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [file, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], { windowsHide: true, timeout: 15000 }, (err) => {
      if (err) log.warn('cli', `icacls: ${err.message}`)
    })
  if (!helper) return icacls()
  execFile(helper, ['--protect', file], { windowsHide: true, timeout: 15000, env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows' } }, (err) => {
    if (!err) return
    log.warn('cli', `protect: ${err.code || err.message}`)
    icacls()
  })
}
const cliBridge = createCliBridge({ send })
ipcMain.handle('cli:ready', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false
  cliBridge.setReady(true)
  return true
})
ipcMain.handle('cli:reply', (event, msg) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false
  return cliBridge.reply(msg)
})
function cliFocusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) throw new CliError('no_window', t('main.cli.noWindow', 'Tessel’s window is not open.'))
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  // Windows keeps a background program from taking the focus: on top for a
  // moment brings the window to the front all the same.
  mainWindow.setAlwaysOnTop(true)
  mainWindow.focus()
  mainWindow.setAlwaysOnTop(false)
}
const cliHandlers = {
  ping: async () => ({ version: app.getVersion(), pid: process.pid }),
  focus: async () => {
    cliFocusWindow()
    return { focused: true }
  },
  open: async ({ path, line, col }) => {
    let st
    try {
      st = await fs.promises.stat(path)
    } catch {
      throw new CliError('not_found', t('main.cli.notFound', 'Not found: {{path}}', { path }))
    }
    const result = st.isDirectory()
      ? await cliBridge.ask('openProject', { path })
      : await cliBridge.ask('openFile', { path, line, col })
    cliFocusWindow()
    return result
  },
  new: async (params) => {
    if (params.cwd) {
      const st = await fs.promises.stat(params.cwd).catch(() => null)
      if (!st || !st.isDirectory()) params = { ...params, cwd: null }
    }
    const result = await cliBridge.ask('newPane', params)
    cliFocusWindow()
    return result
  },
  status: async () => ({ version: app.getVersion(), ...(await cliBridge.ask('status', {})) }),
  'task.add': async (params) => cliBridge.ask('addTask', params),
  usage: async () => accountUsage.usage(),
  browser: async (params) => agentBrowser.handle(params)
}
const cliServer = createCliServer({
  userData: app.getPath('userData'),
  netApi: createAskpassPipeHost({ exePath: () => askpassExePath(__dirname) }),
  handlers: cliHandlers,
  log,
  restrict: restrictToUser,
  info: () => ({ appVersion: app.getVersion(), locale: currentLocale() }),
  onDown: () => scheduleCliStart(5000)
})
let cliStartTimer = null
let cliStartTries = 0
function scheduleCliStart(delay) {
  if (process.platform !== 'win32' || appQuitting || cliStartTimer) return
  cliStartTimer = setTimeout(() => {
    cliStartTimer = null
    cliServer.start().then((ok) => {
      if (ok) cliStartTries = 0
      // The helper may still be building (dev) or blocked: try a few more times.
      else if (++cliStartTries < 10) scheduleCliStart(Math.min(60000, 3000 * cliStartTries))
    })
  }, delay)
}
app.on('will-quit', () => {
  if (cliStartTimer) clearTimeout(cliStartTimer)
  cliServer.stop()
})
// The runtime file tells the command the interface's language.
// A registered command gets it too, for its messages while Tessel is closed.
onLanguageChange(() => {
  cliServer.refreshInfo()
  try {
    cliInstaller.refresh()
  } catch {
    /* kept as it was */
  }
})

const cliInstaller = createCliInstaller({
  binDir: cliBinDir(process.env, os.homedir()),
  name: cliCommandName(app.isPackaged),
  launcher: () => cliLauncherPath(__dirname),
  config: () =>
    iniText({
      execPath: process.execPath,
      scriptPath: cliScriptPath(__dirname),
      userData: app.getPath('userData'),
      // The installed app is started by the command when needed; the dev
      // build is not (it needs electron-vite).
      appPath: app.isPackaged ? process.execPath : '',
      name: cliCommandName(app.isPackaged),
      lang: currentLocale()
    }),
  registry: createUserPathRegistry()
})
const fromWindow = (event) => !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
ipcMain.handle('cli:installStatus', async (event) => {
  if (!fromWindow(event)) return null
  try {
    return { ok: true, status: await cliInstaller.status() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
// Register / Remove: the window asks first (a confirmation dialog).
for (const [channel, fn] of [
  ['cli:install', () => cliInstaller.install()],
  ['cli:uninstall', () => cliInstaller.uninstall()]
]) {
  ipcMain.handle(channel, async (event) => {
    if (!fromWindow(event)) return { ok: false }
    try {
      const status = await fn()
      log.info('cli', `${channel === 'cli:install' ? 'registered' : 'removed'} ${cliInstaller.commandPath}`)
      return { ok: true, status }
    } catch (err) {
      log.warn('cli', `${channel}: ${err.message}`)
      return { ok: false, error: err.message }
    }
  })
}
ipcMain.handle('cli:reveal', (event) => {
  if (!fromWindow(event)) return false
  if (fs.existsSync(cliInstaller.commandPath)) shell.showItemInFolder(cliInstaller.commandPath)
  return true
})

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
  // The tessel command's pipe; a registered command follows this Tessel.
  if (process.platform === 'win32') {
    scheduleCliStart(0)
    try {
      if (cliInstaller.refresh()) log.info('cli', `updated ${cliInstaller.commandPath}`)
    } catch (err) {
      log.warn('cli', `command not updated: ${err.message}`)
    }
  }
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
  Promise.allSettled([accounts.close(), usageStats.close(), shutdownTerminals(), chatSessions.closeAll({ kill: true })]).finally(() => app.quit())
})
