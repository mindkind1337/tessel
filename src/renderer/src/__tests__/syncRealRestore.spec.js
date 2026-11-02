// A copy all the way to the panes on screen, with the window's real code and nothing of it stubbed:
// the strict rebuild, this computer's fit, the layering at the next start, then App.vue's own restore
// with its real chat, editor and browser panes, its real Files and Changes root, and its real start
// line. What would reach a terminal is recorded, and nothing is run. A share here is a made-up name.
import { describe, it, expect, vi } from 'vitest'
import { computed, reactive } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { localizeLayout } from '../../../main/settingsBackup'
import { finishLayout } from '../../../main/syncSchema'
import { chosenRootsOfLayout } from '../../../main/worktreeList'
import { effectiveAgent, launchIsYolo, launchPermissions, launchSessionValues, launchSignature } from '../../../shared/agentPrefs'
import { validPaneSessionOptions } from '../../../shared/agentSessionOptions'
import { allowedBrowserUrl, BLANK_URL } from '../../../shared/browserUrl'
import { isRemotePath, parseRemotePath, remoteRoot } from '../../../shared/remotePath'
import { sleepsAtStart } from '../../../shared/agentSleep'
import { FOUND_IN_FILES, OWN_ID_AGENTS, resumeArgs, resumeLine, safeSessionId } from '../agentResumeLine'
import { samePath, validSavedFiles } from '../editor/editorTabs'
import { leafViewPath, viewKey } from '../paneViews'
import { claudeStartChoice, codexResumes, hasClaudeYoloFlag, hostCodexNoDaemon, remoteCodexNoDaemon, rootSafeClaudeArgs } from '../remoteAgentLaunch'
import { prefetchAttaches, terminalLeafIds } from '../restoreAttach'

const APP = readFileSync(join(__dirname, '../App.vue'), 'utf8').replace(/\r\n/g, '\n')
function slice(from, to) {
  const a = APP.indexOf(from)
  const b = APP.indexOf(to, a + from.length)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return APP.slice(a, b)
}
const CODE = [
  slice('function makeEditorLeaf(id = null)', 'function openInTesselEditor('),
  slice('function makeBrowserLeaf(id = null, url = BLANK_URL)', '// A page opens in the workspace'),
  slice('const CHAT_AGENTS =', '// Each chat pane'),
  slice('function sessionKind(agent)', 'function newUuid()'),
  slice('function newUuid()', '// The command that starts an agent'),
  slice('async function agentStartLine(', '// Codex, OpenCode, Cline and Copilot pick'),
  slice('async function createLeaf(', 'function replaceNode('),
  slice('function validViewPath(v)', 'let persistReady = false'),
  slice('async function wakeShell(leafId)', '// A sleeping pane you open wakes up'),
  slice('const sideRoot = computed(() => {', '// The folders commit links may ask git about'),
  slice('function automationWorkspace(a)', 'function automationAgent(id)'),
  slice('async function restartInPlaceNow(leafId, opts)', '// --- Chat <-> terminal'),
  slice('async function switchToTerminal(leafId)', 'async function switchToChat(leafId)'),
  slice('async function switchToChat(leafId)', 'const switchingLeaves = new Set()'),
  slice('async function restartWithPermissions(leafId, mode)', '// The folders a pane counts as working'),
  slice('async function chatOpen(leaf, {', 'async function chatSetOption'),
  slice('function firstLeafId(node)', '// The pane a restored workspace opens on'),
  slice('function firstAwakeLeafId(node)', '// --- Workspace persistence'),
  slice('async function restoreOrSeedLayout()', '// Startup that never finishes leaves teams off')
].join('\n')

const SHARE = '\\\\evil.invalid\\share'
const HERE = 'C:\\here'
const AGENTS = new Map([
  ['claude', { command: 'claude', name: 'Claude Code', available: true }],
  ['codex', { command: 'codex', name: 'Codex', available: true }]
])

function makeWindow({ running = [], settings = {}, layout = null, held = false } = {}) {
  const writes = []
  const creates = []
  const chatOpens = []
  let counter = 0
  const shellApi = {
    attachPty: vi.fn(async (id) => (running.includes(id) ? { ok: true, shell: { id: 'powershell', name: 'PowerShell' }, backend: 'conpty', pid: 7, buffer: '', cwd: HERE } : { ok: false })),
    createPty: vi.fn(async (o) => {
      creates.push(o)
      return { ok: true, shell: { id: o.shellId || 'powershell', name: 'PowerShell' }, backend: 'conpty', pid: 100 + creates.length, cwd: o.cwd }
    }),
    writePty: (id, data) => writes.push({ id, data }),
    prepareAgentStatus: async () => ({}),
    accounts: { launchEnv: async () => ({ ok: true, env: {}, unsetEnv: [], accountId: null }) },
    claudeSessionExists: async () => true,
    agentResumeTarget: async () => ({}),
    log: () => {},
    killPty: () => {},
    loadLayout: async () => layout,
    layoutHeld: async () => held,
    loadScrollback: async () => ({}),
    chat: {
      open: async (o) => {
        chatOpens.push(o)
        return { ok: true }
      },
      close: async () => ({ ok: true })
    }
  }
  const current = { value: null }
  const tree = { value: null }
  const scope = {
    window: { shellApi, crypto: globalThis.crypto },
    reactive,
    computed,
    settings: { restoreWorkspaces: true, resumeAgents: true, yoloFolders: [], agentPermissions: 'manual', agentPrefs: {}, agentSessionOptions: {}, ...settings },
    effectiveAgent,
    launchSessionValues,
    launchPermissions,
    launchSignature,
    launchIsYolo,
    validPaneSessionOptions,
    claudeStartChoice,
    codexResumes,
    hasClaudeYoloFlag,
    rootSafeClaudeArgs,
    hostCodexNoDaemon,
    remoteCodexNoDaemon,
    safeSessionId,
    resumeArgs,
    resumeLine,
    sleepsAtStart,
    connectorsOffWords: async () => '',
    RESUMABLE: ['claude', 'openclaude', 'codex', 'gemini', 'qwen', ...OWN_ID_AGENTS],
    FOUND_AFTER_START: ['codex', ...FOUND_IN_FILES],
    savedOutput: {},
    t: (key, def, vars = {}) => String(def ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]),
    newId: (prefix) => `${prefix}-${++counter}`,
    modelsFor: () => null,
    hostShared: () => true,
    hostAccountChoice: () => undefined,
    defaultHostAccount: () => undefined,
    HOST_ACCOUNT_AGENTS: ['claude', 'codex'],
    MANUAL_CLAUDE_MODES: ['acceptEdits', 'plan'],
    teamToolsReady: false,
    teamToolsVersion: null,
    showToast: () => {},
    agents: { value: [] },
    remoteAgentCommand: async (_h, _a, command) => command,
    readDrafts: () => ({}),
    userDraft: {},
    draftUnknown: {},
    isRemotePath,
    parseRemotePath,
    validSavedFiles,
    samePath,
    allowedBrowserUrl,
    BLANK_URL,
    seedBuffer: () => {},
    scheduleSave: () => {},
    setDraft: () => {},
    savedPaneModel: () => null,
    exitOf: () => null,
    performance,
    currentWs: current,
    viewKey,
    leafViewPath,
    findLeafIn: (node, id) => {
      let hit = null
      const walk = (n) => {
        if (!n || hit) return
        if (n.type === 'leaf') {
          if (n.id === id) hit = n
        } else (n.children || []).forEach(walk)
      }
      walk(node)
      return hit
    },
    remoteRoot,
    lshareRoot: () => null,
    logPaneOpened: () => {},
    askConversationEarly: () => {},
    noteRemoteToolsMissing: () => {},
    watchFoundSession: () => {},
    workerLaunchArgs: () => '',
    quoteGlobArgs: (x) => x,
    wakeLaunchArgs: () => '',
    automationLaunchArgs: () => '',
    agyContinueLaunchArgs: () => '',
    remoteAgentTools: {},
    remoteHostLabel: () => 'Box',
    remoteAgentName: () => 'Agent',
    remoteHostIsRoot: () => false,
    restartingLeaves: new Set(),
    findLeaf: (id) => scope.findLeafIn(tree.value, id),
    wsOfLeaf: () => current.value,
    replaceNode: (node, id, make) => (node && node.id === id ? make(node) : node),
    Promise,
    Object,
    Number,
    Date,
    Math,
    setTimeout: (fn) => fn(),
    wsById: () => null,
    console,
    agentById: (id) => ({ id, name: id, command: id, available: true }),
    switchingLeaves: new Set(),
    validHostAccount: () => false,
    dropBuffer: () => {},
    clearAgentStatus: () => {},
    restartInPlace: (id, opts) => api.restartInPlaceNow(id, opts || {}),
    // What the real restore needs around it.
    loadUnlocked: (load) => load(),
    shells: { value: [{ id: 'powershell', name: 'PowerShell' }] },
    selectedShell: { value: null },
    broadcast: { value: false },
    sidebarCollapsed: { value: false },
    taskPanelOpen: { value: false },
    sideBrowsers: { value: [] },
    sideTab: { value: null },
    taskPanelWidth: { value: 0 },
    sidebarWidth: { value: 0 },
    placement: { value: 'right' },
    teams: { value: [] },
    workspaces: { value: [] },
    currentWsId: { value: null },
    TASK_PANEL_MIN: 100,
    sidebarMaxWidth: () => 500,
    loadSettings: () => {},
    isTeam: () => true,
    dedupeTeamNumbers: (x) => x,
    restoreSideBrowsers: () => [],
    restoredSideTab: () => null,
    makeWorkspace: (name) => reactive({ id: `ws-made-${++counter}`, name, tree: null, activeId: null, cwd: null, remote: null, group: null }),
    defaultWorkspaceName: (n) => `Project ${n}`,
    nextWorkspaceName: () => 'Project',
    savedRemote: (raw) => raw || null,
    savedGroup: (raw) => raw || null,
    savedGridModes: () => ({}),
    prefetchAttaches,
    terminalLeafIds,
    forEachLeaf: (node, fn) => {
      if (!node) return
      if (node.type === 'leaf') fn(node)
      else node.children.forEach((child) => scope.forEachLeaf(child, fn))
    },
    waitForHostAgain: () => {},
    wsLeafOpts: (_ws, opts = {}) => opts,
    restoreReport: {},
    buildGrid: async () => {},
    layoutLocked: false
  }
  const api = {}
  vm.createContext(scope)
  scope.__api = api
  vm.runInContext(`${CODE}\nObject.assign(__api, { deserializeNode, createLeaf, holdRestore, restoresTerminal, firstStartPermissions, wakeShell, sideRoot, automationWorkspace, restoreOrSeedLayout, restartInPlaceNow, switchToTerminal, switchToChat, chatOpen, restartWithPermissions })`, scope)
  return { api, scope, writes, creates, chatOpens, shellApi, current, tree }
}

// A copy received: rebuilt strictly, made ready, and laid over this computer's file at the next start.
function received(layout, { current = null, running = [], folderExists = (f) => String(f).toLowerCase().startsWith('c:\\here'), addresses } = {}) {
  const looked = []
  const { body } = localizeLayout(JSON.stringify(layout), {
    agents: AGENTS,
    now: () => 5,
    folderExists: (f) => {
      looked.push(f)
      return folderExists(f)
    }
  })
  return { onDisk: JSON.parse(finishLayout(body, current ? JSON.stringify(current) : null, { running, addresses })), looked }
}

async function restored(onDisk, options = {}) {
  const win = makeWindow(options)
  win.api.holdRestore(options.held !== false)
  const attaching = prefetchAttaches(onDisk.workspaces.flatMap((w) => terminalLeafIds(w.tree, win.api.restoresTerminal)), { attach: (id) => win.shellApi.attachPty(id), seed: () => {}, limit: 6 })
  const out = []
  for (const w of onDisk.workspaces) out.push({ ...w, tree: await win.api.deserializeNode(w.tree, w.cwd, attaching) })
  win.spaces = out
  return win
}
const copyOf = (tree, extra = {}) => ({ version: 2, settings: {}, workspaces: [{ id: 'ws-1', name: 'Project', cwd: HERE, tree, ...extra }] })
const leavesOf = (win) => {
  const found = []
  const walk = (n) => {
    if (!n) return
    if (n.type === 'leaf') found.push(n)
    else (n.children || []).forEach(walk)
  }
  win.spaces.forEach((w) => walk(w.tree))
  return found
}
const sideRootOf = (win, w = win.spaces[0]) => {
  win.current.value = reactive({ ...w, activeId: w.tree && w.tree.id })
  return win.api.sideRoot.value
}

describe('finding 1: a share never reaches a real pane, or the Files and Changes root', () => {
  it.each([
    ['a browser pane\u2019s grid', { type: 'leaf', id: 'pane-1', kind: 'browser', viewPath: SHARE }],
    ['an editor pane\u2019s grid', { type: 'leaf', id: 'pane-1', kind: 'editor', files: [{ path: `${HERE}\\f.txt` }], viewPath: SHARE }],
    ['a terminal\u2019s grid', { type: 'leaf', id: 'pane-1', kind: 'shell', viewPath: SHARE }],
    ['a chat in a share, with a copy of it here', { type: 'leaf', id: 'pane-1', kind: 'chat', agentId: 'claude', cwd: SHARE, worktree: { path: HERE } }],
    ['a chat on a host, with a copy of it in a share', { type: 'leaf', id: 'pane-1', kind: 'chat', agentId: 'claude', cwd: 'ssh://ssh-1/home/me', worktree: { path: SHARE } }],
    ['a chat with its project in a share', { type: 'leaf', id: 'pane-1', kind: 'chat', agentId: 'claude', cwd: HERE, projectDir: SHARE }],
    ['a chat in a share', { type: 'leaf', id: 'pane-1', kind: 'chat', agentId: 'claude', cwd: SHARE }],
    ['an editor on a share', { type: 'leaf', id: 'pane-1', kind: 'editor', files: [{ path: `${SHARE}\\f.txt` }], activePath: `${SHARE}\\f.txt` }],
    ['an agent in a share', { type: 'leaf', id: 'pane-1', kind: 'agent', agentId: 'claude', worktree: { path: SHARE, branch: 'b' } }],
    ['an agent on a host, its copy in a share', { type: 'leaf', id: 'pane-1', kind: 'agent', agentId: 'claude', remoteHostId: 'ssh-1', worktree: { path: SHARE, branch: 'b' } }],
    ['a terminal in a share', { type: 'leaf', id: 'pane-1', kind: 'shell', worktree: { path: SHARE, branch: 'b' } }]
  ])('%s', async (_what, pane) => {
    const { onDisk, looked } = received(copyOf(pane))
    expect(JSON.stringify(onDisk)).not.toContain('evil.invalid')
    expect(looked.join()).not.toContain('evil.invalid')
    const win = await restored(onDisk)
    expect(JSON.stringify(leavesOf(win))).not.toContain('evil.invalid')
    expect(String(sideRootOf(win))).not.toContain('evil.invalid')
    expect(JSON.stringify(win.creates)).not.toContain('evil.invalid')
  })

  it('the rebuild alone would have let it reach the root: the window really reads viewPath', async () => {
    const win = await restored({ workspaces: [{ id: 'ws-1', cwd: HERE, tree: { type: 'leaf', id: 'pane-1', kind: 'browser', viewPath: 'C:\\here\\wt' } }] })
    expect(sideRootOf(win)).toBe('C:\\here\\wt')
  })

  it('what is fine stays: a real chat, a real editor, a real page', async () => {
    const { onDisk } = received(copyOf({ type: 'split', dir: 'row', sizes: [1, 1, 1], children: [
      { type: 'leaf', id: 'pane-c', kind: 'chat', agentId: 'claude', cwd: HERE, sessionId: '0123456789abcdef' },
      { type: 'leaf', id: 'pane-e', kind: 'editor', files: [{ path: `${HERE}\\f.txt` }] },
      { type: 'leaf', id: 'pane-b', kind: 'browser' }
    ] }))
    const win = await restored(onDisk)
    expect(leavesOf(win).map((l) => l.kind)).toEqual(['chat', 'editor', 'browser'])
    expect(leavesOf(win)[0]).toMatchObject({ held: true, cwd: HERE, sessionId: '0123456789abcdef' })
    expect(leavesOf(win)[1].files[0].path).toBe(`${HERE}\\f.txt`)
    expect(leavesOf(win)[2].url).toBe(BLANK_URL)
    expect(win.writes).toEqual([])
    expect(win.creates).toEqual([])
  })
})

describe('finding 6: nothing starts by itself, terminals included', () => {
  const shell = { type: 'leaf', id: 'pane-s', kind: 'shell', shellId: 'cmd', worktree: { path: 'C:\\here\\planted', branch: 'x' } }

  it('a plain terminal does not start at the first start', async () => {
    const { onDisk } = received(copyOf(shell))
    const win = await restored(onDisk)
    expect(win.creates).toEqual([])
    expect(win.writes).toEqual([])
    expect(leavesOf(win)[0]).toMatchObject({ kind: 'shell', sleeping: { held: true } })
  })

  it('nor at the next one, from what was saved, without main saying anything', async () => {
    const { onDisk } = received(copyOf(shell))
    const win = await restored(onDisk, { held: false })
    expect(win.creates).toEqual([])
    expect(leavesOf(win)[0].sleeping.held).toBe(true)
  })

  it('a backup with an ordinary terminal: main says so, and it waits too', async () => {
    const win = await restored({ workspaces: [{ id: 'ws-1', cwd: HERE, tree: { type: 'leaf', id: 'pane-s', kind: 'shell', shellId: 'cmd' } }] })
    expect(win.creates).toEqual([])
    expect(leavesOf(win)[0].sleeping.held).toBe(true)
  })

  it('on a signed-in host too: it does not connect by itself', async () => {
    const { onDisk } = received(copyOf({ type: 'leaf', id: 'pane-r', kind: 'shell', remoteHostId: 'ssh-1', remotePath: '/srv/x' }))
    const win = await restored(onDisk)
    expect(win.creates).toEqual([])
    expect(leavesOf(win)[0]).toMatchObject({ remoteHostId: 'ssh-1', remotePath: '/srv/x', sleeping: { held: true } })
  })

  it('a click starts it, in that folder, on its host, with nothing typed', async () => {
    const { onDisk } = received(copyOf({ type: 'leaf', id: 'pane-r', kind: 'shell', remoteHostId: 'ssh-1', remotePath: '/srv/x' }))
    const win = await restored(onDisk)
    win.tree.value = win.spaces[0].tree
    win.current.value = reactive({ ...win.spaces[0] })
    expect(await win.api.wakeShell('pane-r')).toBe(true)
    expect(win.creates).toHaveLength(1)
    expect(win.creates[0]).toMatchObject({ id: 'pane-r', remoteHostId: 'ssh-1', remotePath: '/srv/x' })
    expect(win.writes).toEqual([])
  })

  it('one still running comes back running', async () => {
    const own = { type: 'leaf', id: 'pane-s', kind: 'shell', shellId: 'powershell', title: 'Mine' }
    const { onDisk } = received(copyOf(shell), { running: ['pane-s'], current: { workspaces: [{ id: 'ws-1', cwd: HERE, tree: own }] } })
    const win = await restored(onDisk, { running: ['pane-s'] })
    expect(leavesOf(win)[0].sleeping).toBeUndefined()
    expect(leavesOf(win)[0].attached).toBe(true)
    expect(win.creates).toEqual([])
  })

  it('an ordinary start, with no layout from elsewhere, is as it always was', async () => {
    const win = await restored({ workspaces: [{ id: 'ws-1', cwd: HERE, tree: { type: 'leaf', id: 'pane-s', kind: 'shell', shellId: 'powershell' } }] }, { held: false })
    expect(win.creates).toHaveLength(1)
    expect(leavesOf(win)[0].sleeping).toBeUndefined()
  })
})

describe('the whole start: what the window really does with a layout from elsewhere', () => {
  const full = async (layout, held) => {
    const win = makeWindow({ layout, held })
    await win.api.restoreOrSeedLayout()
    return { ...win, spaces: win.scope.workspaces.value }
  }

  it('it asks main, and holds everything; main says no, and an ordinary layout starts', async () => {
    const layout = { version: 2, settings: {}, workspaces: [{ id: 'ws-1', cwd: HERE, tree: { type: 'split', dir: 'row', sizes: [50, 50], children: [{ type: 'leaf', id: 'pane-a', kind: 'agent', agentId: 'claude', agentCommand: 'claude', sessionId: 'abcdef-123456' }, { type: 'leaf', id: 'pane-s', kind: 'shell', shellId: 'powershell' }] } }] }
    const held = await full(layout, true)
    expect(held.writes).toEqual([])
    expect(held.creates).toEqual([])
    expect(leavesOf(held).map((l) => l.sleeping && l.sleeping.held)).toEqual([true, true])
    const ordinary = await full(layout, false)
    expect(ordinary.creates).toHaveLength(2)
    expect(ordinary.writes).toHaveLength(1)
  })

  it('a project whose panes cannot come back: the terminal it gets instead waits too', async () => {
    const layout = { version: 2, settings: {}, workspaces: [{ id: 'ws-1', cwd: HERE, tree: { type: 'leaf', id: 'pane-e', kind: 'editor', files: [] } }] }
    const held = await full(layout, true)
    expect(held.creates).toEqual([])
    expect(leavesOf(held)[0]).toMatchObject({ kind: 'shell', sleeping: { held: true } })
    expect(held.spaces[0].cwd).toBe(HERE)
    const ordinary = await full(layout, false)
    expect(ordinary.creates).toHaveLength(1)
  })

  it('the same on an SSH project: it waits, on its host', async () => {
    const layout = { version: 2, settings: {}, workspaces: [{ id: 'ws-1', remote: { hostId: 'ssh-1', path: '/srv/x' }, tree: { type: 'leaf', id: 'pane-e', kind: 'editor', files: [] } }] }
    const held = await full(layout, true)
    expect(held.creates).toEqual([])
    expect(leavesOf(held)[0]).toMatchObject({ remoteHostId: 'ssh-1', remotePath: '/srv/x', sleeping: { held: true } })
  })

  it('the pane a project opens on is asleep and stays so: being shown wakes nothing', async () => {
    const { onDisk } = received(copyOf({ type: 'leaf', id: 'pane-a', kind: 'agent', agentId: 'claude' }))
    const held = await full(onDisk, true)
    expect(held.spaces[0].activeId).toBe('pane-a')
    expect(leavesOf(held)[0].sleeping.held).toBe(true)
    expect(APP).toContain('const wakesWhenOpened = (leaf) => !!leaf && !!leaf.sleeping && leaf.sleeping.held !== true')
  })
})

describe('finding 10: a pane said to run here, gone by the start', () => {
  const RUN = 'pane-77-123456'
  it.each([
    ['an editor on a share', { type: 'leaf', id: RUN, kind: 'editor', files: [{ path: `${SHARE}\\f.txt` }] }],
    ['a chat in a share', { type: 'leaf', id: RUN, kind: 'chat', agentId: 'claude', cwd: SHARE, projectDir: SHARE }],
    ['a terminal in a share', { type: 'leaf', id: RUN, kind: 'shell', worktree: { path: SHARE, branch: 'b' } }],
    ['an agent nobody knows', { type: 'leaf', id: RUN, kind: 'agent', agentId: 'whatever', sessionId: 'abcdef-123456' }]
  ])('%s comes back as any other: filtered, and held', async (_what, pane) => {
    const { onDisk } = received(copyOf(pane), { running: [RUN] })
    expect(JSON.stringify(onDisk)).not.toContain('evil.invalid')
    const gone = await restored(onDisk, { running: [] })
    expect(JSON.stringify(leavesOf(gone))).not.toContain('evil.invalid')
    expect(gone.writes).toEqual([])
    expect(gone.creates).toEqual([])
    const stillThere = await restored(onDisk, { running: [RUN] })
    expect(stillThere.writes).toEqual([])
  })
})

describe('finding 4: a first Wake never starts in Yolo', () => {
  const PLANTED = 'C:\\here\\planted'
  const pinned = (over = {}) => ({ type: 'leaf', id: 'pane-3-555555', kind: 'agent', agentId: 'claude', agentCommand: 'claude', shellId: 'powershell', sessionId: 'abcdef-111111', permissions: 'yolo', launchYolo: true, launchSig: 'sig', startDir: HERE, ...over })
  // restartInPlaceNow's own arguments, as App.vue gives them.
  const wake = async (win, leaf) => {
    const agent = { id: leaf.agentId, name: leaf.title, command: leaf.agentCommand, accent: leaf.accent }
    await win.api.createLeaf(leaf.shellId, agent, leaf.startDir || win.spaces[0].cwd, leaf.worktree, {
      id: leaf.id,
      sessionId: leaf.sessionId,
      permissions: win.api.firstStartPermissions(leaf),
      permissionMode: leaf.sleeping && leaf.sleeping.held === true ? undefined : leaf.permissionMode,
      resume: !!leaf.sessionId,
      restart: true
    })
    return win.writes.at(-1).data
  }

  it('restartInPlaceNow uses the rule', () => {
    const body = slice('async function restartInPlaceNow(leafId, opts)', 'function wakeLeaf')
    expect(body).toContain('permissions: firstStartPermissions(old)')
    expect(body).toContain('permissionMode: heldFirstStart(old) ? undefined : old.permissionMode')
    expect(body).toContain('firstStart: heldFirstStart(old)')
  })

  it.each([
    ['its own pin, the copy moves it to a folder of its choice', copyOf({ type: 'leaf', id: 'pane-3-555555', kind: 'agent', agentId: 'claude', sessionId: 'abcdef-222222', worktree: { path: PLANTED, branch: 'x' } }), { current: { workspaces: [{ id: 'ws-1', cwd: HERE, tree: pinned() }] } }, {}],
    ['its own pin, the copy changes the agent too', copyOf({ type: 'leaf', id: 'pane-3-555555', kind: 'agent', agentId: 'codex', sessionId: 'abcdef-222222', worktree: { path: PLANTED, branch: 'x' } }), { current: { workspaces: [{ id: 'ws-1', cwd: HERE, tree: pinned() }] } }, {}],
    ['Yolo in Settings, a folder only the copy names', copyOf({ type: 'leaf', id: 'pane-1', kind: 'agent', agentId: 'claude', sessionId: 'abcdef-222222' }, { cwd: PLANTED }), {}, { agentPermissions: 'yolo' }],
    ['a Yolo folder, a folder inside it', copyOf({ type: 'leaf', id: 'pane-1', kind: 'agent', agentId: 'claude', sessionId: 'abcdef-222222' }, { cwd: PLANTED }), {}, { yoloFolders: [HERE] }],
    ['its own pin, nothing changed: the rule is the rule', copyOf({ type: 'leaf', id: 'pane-3-555555', kind: 'agent', agentId: 'claude', sessionId: 'abcdef-111111' }), { current: { workspaces: [{ id: 'ws-1', cwd: HERE, tree: pinned() }] } }, {}]
  ])('%s', async (_what, copy, options, settings) => {
    const { onDisk } = received(copy, options)
    const win = await restored(onDisk, { settings })
    expect(win.writes).toEqual([])
    const line = await wake(win, leavesOf(win)[0])
    expect(line).not.toMatch(/dangerously|bypass|--yolo/i)
  })

  it('a pin the copy re-aimed is gone from the file, not only from the first start', () => {
    const { onDisk } = received(copyOf({ type: 'leaf', id: 'pane-3-555555', kind: 'agent', agentId: 'claude', sessionId: 'abcdef-222222', worktree: { path: PLANTED, branch: 'x' } }), { current: { workspaces: [{ id: 'ws-1', cwd: HERE, tree: pinned() }] } })
    for (const key of ['permissions', 'permissionMode', 'launchYolo', 'launchSig']) expect(onDisk.workspaces[0].tree).not.toHaveProperty(key)
  })

  it('a folder only the copy names is never one main would pre-trust', () => {
    const { onDisk } = received(copyOf({ type: 'leaf', id: 'pane-1', kind: 'agent', agentId: 'claude' }, { cwd: PLANTED }))
    expect(onDisk.workspaces[0].fromCopy).toBe(true)
    expect(chosenRootsOfLayout(onDisk)).toEqual([])
  })

  it('the person chooses Yolo from its menu: that is what it starts with', () => {
    const body = slice('async function restartWithPermissions(leafId, mode)', '// The folders a pane counts as working in')
    expect(body).toContain('if (leaf.sleeping && leaf.sleeping.held === true) leaf.sleeping = { at: leaf.sleeping.at }')
    const win = makeWindow()
    expect(win.api.firstStartPermissions({ sleeping: { at: 1 }, permissions: 'yolo' })).toBe('yolo')
    expect(win.api.firstStartPermissions({ sleeping: { at: 1, held: true }, permissions: 'yolo' })).toBe('manual')
    expect(win.api.firstStartPermissions({ permissions: 'yolo' })).toBe('yolo')
  })

  it('a held chat: its first message asks first too', () => {
    const chatPane = readFileSync(join(__dirname, '../components/chat/ChatPane.vue'), 'utf8').replace(/\r\n/g, '\n')
    expect(chatPane).toContain("delete props.node.held\n    // ...and it asks first, whatever Settings or a Yolo folder say: as a held agent's first Wake.\n    props.node.maxPermissions = 'manual'")
    expect(APP).toContain("const narrowed = leaf.maxPermissions === 'manual'")
  })
})

describe('N1 and N3: every way a held pane can start, with Yolo everywhere it can be', () => {
  const YOLO = /dangerously|bypass|--yolo|--auto\b/i
  const yoloSettings = { agentPermissions: 'yolo', yoloFolders: [HERE] }
  const ready = async (copy, settings = yoloSettings) => {
    const { onDisk } = received(copy)
    const win = await restored(onDisk, { settings })
    win.tree.value = win.spaces[0].tree
    win.current.value = win.spaces[0]
    win.scope.findLeaf = (id) => win.scope.findLeafIn(win.current.value.tree, id)
    win.scope.wsOfLeaf = () => win.current.value
    win.scope.replaceNode = (node, id, make) => (node && node.id === id ? make(node) : node)
    return win
  }
  const chat = copyOf({ type: 'leaf', id: 'pane-c', kind: 'chat', agentId: 'claude', cwd: 'C:\\here\\planted', sessionId: 'abcdef12-3456' })
  const agent = copyOf({ type: 'leaf', id: 'pane-a', kind: 'agent', agentId: 'claude', sessionId: 'abcdef-444444' })

  it('a held chat > Continue in a terminal: no Yolo flag, and it asks first', async () => {
    const win = await ready(chat)
    expect(await win.api.chatOpen(leavesOf({ spaces: [win.current.value] })[0], { askTrust: true })).toEqual({ ok: false, code: 'held' })
    await win.api.switchToTerminal('pane-c')
    expect(win.writes).toHaveLength(1)
    expect(win.writes[0].data).not.toMatch(YOLO)
    expect(win.current.value.tree.permissions).toBe('manual')
  })

  it('a held chat > Continue in a terminal, with the flag in its own arguments: the same', async () => {
    const win = await ready(chat, { ...yoloSettings, agentPrefs: { claude: { args: '--dangerously-skip-permissions --verbose' } } })
    await win.api.switchToTerminal('pane-c')
    expect(win.writes[0].data).not.toMatch(YOLO)
    expect(win.writes[0].data).toContain('--verbose')
  })

  it('an ordinary chat > Continue in a terminal follows Settings, as it always did', async () => {
    const win = await ready(chat)
    delete win.current.value.tree.held
    await win.api.switchToTerminal('pane-c')
    expect(win.writes[0].data).toMatch(YOLO)
  })

  it('a held agent > Open as chat: what reaches chat.open is capped, with Yolo on', async () => {
    const win = await ready(agent)
    await win.api.switchToChat('pane-a')
    const leaf = win.current.value.tree
    expect(leaf).toMatchObject({ kind: 'chat', maxPermissions: 'manual' })
    await win.api.chatOpen(leaf, { askTrust: false })
    expect(win.chatOpens[0]).toMatchObject({ permissions: 'manual', maxPermissions: 'manual' })
  })

  it('an ordinary agent > Open as chat follows Settings, as it always did', async () => {
    const win = await ready(agent)
    win.current.value.tree.sleeping = { at: 1 }
    await win.api.switchToChat('pane-a')
    await win.api.chatOpen(win.current.value.tree, { askTrust: false })
    expect(win.chatOpens[0].permissions).toBe('yolo')
  })

  it('Wake: the real restart, with Yolo in Settings and in a Yolo folder', async () => {
    const win = await ready(agent)
    await win.api.restartInPlaceNow('pane-a', { resume: true })
    expect(win.writes).toHaveLength(1)
    expect(win.writes[0].data).not.toMatch(YOLO)
  })

  it.each([
    ['the flag alone', '--dangerously-skip-permissions', ''],
    ['the flag among others', '--verbose --dangerously-skip-permissions --model opus', '--verbose --model opus'],
    ['another way of saying it', '--permission-mode bypassPermissions', ''],
    ['with an equals sign', '--permission-mode=bypassPermissions --verbose', '--verbose'],
    ['the allow form', '--allow-dangerously-skip-permissions', '']
  ])('Wake, with %s in its own arguments: stripped, the rest stays', async (_what, args, rest) => {
    const win = await ready(agent, { agentPrefs: { claude: { args } } })
    await win.api.restartInPlaceNow('pane-a', { resume: true })
    expect(win.writes[0].data).not.toMatch(YOLO)
    if (rest) expect(win.writes[0].data).toContain(rest)
  })

  it('Wake, with the flag in its own command: stripped too', async () => {
    const win = await ready(agent, { agentPrefs: { claude: { command: 'claude --dangerously-skip-permissions' } } })
    await win.api.restartInPlaceNow('pane-a', { resume: true })
    expect(win.writes[0].data).not.toMatch(YOLO)
    expect(win.writes[0].data).toMatch(/^claude /)
  })

  it('the person\u2019s own choice from the menu: Restart in Yolo is Yolo, own arguments included', async () => {
    const win = await ready(agent, { agentPrefs: { claude: { args: '--dangerously-skip-permissions' } } })
    await win.api.restartWithPermissions('pane-a', 'yolo')
    expect(win.writes[0].data).toMatch(YOLO)
  })

  it('a pane that is not held keeps what your own arguments say: this changes nothing else', async () => {
    const win = await ready(agent, { agentPrefs: { claude: { args: '--dangerously-skip-permissions' } } })
    win.current.value.tree.sleeping = { at: 1 }
    await win.api.restartInPlaceNow('pane-a', { resume: true })
    expect(win.writes[0].data).toMatch(YOLO)
  })
})

describe('finding 5: a scheduled run and a project a copy moved', () => {
  const run = (spaces, auto) => {
    const win = makeWindow()
    win.scope.wsById = (id) => spaces.find((w) => w.id === id)
    return win.api.automationWorkspace(auto)
  }
  const onHost = { wsId: 'ws-r', remote: { hostId: 'ssh-1', path: '/home/me/app' } }

  it('the same host, another folder: not there', () => {
    expect(run([{ id: 'ws-r', remote: { hostId: 'ssh-1', path: '/tmp/planted' } }], onHost)).toBeNull()
  })
  it('another host: not there', () => {
    expect(run([{ id: 'ws-r', remote: { hostId: 'ssh-2', path: '/home/me/app' } }], onHost)).toBeNull()
  })
  it('where it was made for: there', () => {
    expect(run([{ id: 'ws-r', remote: { hostId: 'ssh-1', path: '/home/me/app' } }], onHost)).toBeTruthy()
  })
  it('a local one, as before', () => {
    const local = { wsId: 'ws-l', projectCwd: HERE }
    expect(run([{ id: 'ws-l', cwd: `${HERE}\\planted` }], local)).toBeNull()
    expect(run([{ id: 'ws-l', cwd: HERE }], local)).toBeTruthy()
  })
})
