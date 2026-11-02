// One rule, for a layout that came from elsewhere (an applied copy or backup): nothing starts by
// itself. App.vue's own restore and start code, in a sandbox: what would be typed into a terminal is
// recorded, and nothing is run. The panes below are what a hostile copy or file tried.
import { describe, it, expect, vi } from 'vitest'
import { reactive } from 'vue'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { safeSessionId } from '../agentResumeLine'

const read = (path) => readFileSync(join(__dirname, path), 'utf8').replace(/\r\n/g, '\n')
const source = read('../App.vue')
const terminalPane = read('../components/TerminalPane.vue')
const chatPane = read('../components/chat/ChatPane.vue')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

function load({ held = false, running = {} } = {}) {
  const shellApi = {
    attachPty: vi.fn(async (id) => (running[id] ? { ok: true, buffer: '', pid: 5, shell: { id: 'pwsh', name: 'PowerShell' }, backend: 'conpty' } : { ok: false })),
    createPty: vi.fn(async (o) => ({ ok: true, shell: { id: 'pwsh', name: 'PowerShell' }, backend: 'conpty', pid: 9, cwd: o.cwd })),
    killPty: vi.fn(),
    writePty: vi.fn()
  }
  let counter = 0
  const ctx = {
    reactive,
    t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : '')),
    newId: (prefix) => `${prefix}-${++counter}`,
    safeSessionId,
    savedOutput: {},
    validPaneSessionOptions: () => null,
    validSavedFiles: () => [],
    savedPaneModel: () => null,
    settings: { resumeAgents: true, yoloFolders: [], agentPermissions: 'yolo', agentPrefs: {}, agentSessionOptions: {} },
    launchPermissions: () => 'yolo',
    launchSessionValues: () => null,
    effectiveAgent: (agent) => ({ ...agent, args: '--dangerously-skip-permissions', env: {} }),
    launchSignature: () => 'sig',
    launchIsYolo: () => true,
    modelsFor: () => null,
    hostAccountChoice: () => undefined,
    defaultHostAccount: () => undefined,
    HOST_ACCOUNT_AGENTS: [],
    MANUAL_CLAUDE_MODES: [],
    hostShared: () => true,
    remoteHostLabel: () => 'Box',
    remoteAgentName: () => 'Agent',
    remoteHostIsRoot: () => false,
    hasClaudeYoloFlag: () => false,
    agents: { value: [] },
    FOUND_AFTER_START: [],
    RESUMABLE: [],
    sessionKind: () => null,
    seedBuffer: () => {},
    exitOf: () => null,
    performance,
    teamToolsReady: false,
    teamToolsVersion: null,
    showToast: () => {},
    readDrafts: () => ({}),
    userDraft: {},
    draftUnknown: {},
    logPaneOpened: () => {},
    agentStartLine: async (agent, sessionId) => ({ line: `${agent.command}${sessionId ? ` --resume ${sessionId}` : ''}`, sessionId: sessionId || 'new', resumed: !!sessionId }),
    workerLaunchArgs: () => '',
    quoteGlobArgs: (x) => x,
    wakeLaunchArgs: () => '',
    automationLaunchArgs: () => '',
    agyContinueLaunchArgs: () => '',
    askConversationEarly: () => {},
    remoteAgentCommand: async (_h, _a, command) => command,
    noteRemoteToolsMissing: () => {},
    watchFoundSession: () => {},
    hostCodexNoDaemon: () => null,
    remoteAgentTools: {},
    sleepsAtStart: () => false,
    makeChatLeaf: (o) => reactive({ type: 'leaf', kind: 'chat', ...o }),
    CHAT_AGENTS: ['claude'],
    OLD_CHAT_TITLE: /^$/,
    isRemotePath: () => false,
    Promise,
    Object,
    Number,
    Date,
    setTimeout: (fn) => fn(),
    window: { shellApi }
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('async function deserializeNode(snap, cwd = null, attaching = null, startAsleep = false)', 'let persistReady') +
      slice('async function createLeaf(shellId, agent = null', 'function replaceNode(') +
      slice('const wakesWhenOpened = ', 'watch(\n') +
      '\nthis.api = { deserializeNode, createLeaf, restoresAsleep, restoresTerminal, holdRestore, wakesWhenOpened, serializeLeafOnly: (leaf) => leaf }',
    ctx
  )
  ctx.api.holdRestore(held)
  return { api: ctx.api, shellApi, attaching: { get: (id) => (running[id] ? shellApi.attachPty(id) : undefined) } }
}

const base = { type: 'leaf', id: 'pane-a', kind: 'agent', agentId: 'claude', agentCommand: 'claude', shellId: 'powershell' }
const SAFE = 'abcdef-123456'

describe('H1: a layout from elsewhere: nothing is typed, whatever the pane says', () => {
  it.each([
    ['no conversation', { sessionId: null }],
    ['a numeric conversation id', { sessionId: 123456789 }],
    ['a conversation id with a command', { sessionId: 'x; calc.exe #' }],
    ['sleeping with no time', { sessionId: SAFE, sleeping: { at: null } }],
    ['sleeping as text', { sessionId: SAFE, sleeping: 'x' }],
    ['a pane id the window refuses', { id: 'not a pane id', sessionId: SAFE }],
    ['no pane id', { id: undefined, sessionId: SAFE }],
    ['a Yolo pin', { sessionId: SAFE, permissions: 'yolo', launchYolo: true }],
    ['awake, as an ordinary pane is', { sessionId: SAFE }],
    ['on an SSH host, its connection up', { sessionId: SAFE, remoteHostId: 'ssh-abc' }],
    ['a team member', { sessionId: SAFE, team: 'team-1' }]
  ])('%s', async (_what, over) => {
    const { api, shellApi } = load({ held: true })
    const leaf = await api.deserializeNode({ ...base, ...over })
    expect(shellApi.writePty).not.toHaveBeenCalled()
    expect(shellApi.createPty).not.toHaveBeenCalled()
    expect(leaf).toMatchObject({ kind: 'agent', sleeping: { held: true } })
    expect(Number.isFinite(leaf.sleeping.at)).toBe(true)
    expect(leaf.id).toMatch(/^pane-[\w-]+$/)
  })

  it('its conversation id is kept only if it could never add to a command line', async () => {
    const { api } = load({ held: true })
    expect((await api.deserializeNode({ ...base, sessionId: SAFE })).sessionId).toBe(SAFE)
    expect((await api.deserializeNode({ ...base, sessionId: 'x; calc.exe #' })).sessionId).toBeNull()
  })

  it('a terminal waits for its click too: nothing starts, in the folder or the shell a copy names', async () => {
    const { api, shellApi } = load({ held: true })
    const leaf = await api.deserializeNode({ type: 'leaf', id: 'pane-s', kind: 'shell', shellId: 'cmd', agentCommand: 'calc.exe' })
    expect(leaf).toMatchObject({ kind: 'shell', sleeping: { held: true } })
    expect(shellApi.createPty).not.toHaveBeenCalled()
    expect(shellApi.writePty).not.toHaveBeenCalled()
  })

  it('a command that is not text is no agent at all', async () => {
    const { api, shellApi } = load({ held: true })
    const leaf = await api.deserializeNode({ ...base, agentCommand: ['calc.exe'] })
    expect(leaf.kind).toBe('shell')
    expect(leaf.sleeping.held).toBe(true)
    expect(shellApi.createPty).not.toHaveBeenCalled()
    expect(shellApi.writePty).not.toHaveBeenCalled()
  })

  it('a terminal that still runs here comes back running, and still nothing is typed', async () => {
    const { api, shellApi, attaching } = load({ held: true, running: { 'pane-a': true } })
    const leaf = await api.deserializeNode({ ...base, sessionId: SAFE }, null, attaching)
    expect(leaf.sleeping).toBeUndefined()
    expect(leaf.attached).toBe(true)
    expect(shellApi.createPty).not.toHaveBeenCalled()
    expect(shellApi.writePty).not.toHaveBeenCalled()
  })

  it('a terminal gone since it was looked at does not start either', async () => {
    const { api, shellApi, attaching } = load({ held: true })
    const leaf = await api.deserializeNode({ ...base, sessionId: SAFE }, null, attaching)
    expect(leaf.sleeping.held).toBe(true)
    expect(shellApi.writePty).not.toHaveBeenCalled()
  })

  it('a chat waits too: main\'s word, or what was saved', async () => {
    const chat = { type: 'leaf', kind: 'chat', id: 'pane-c', cwd: 'C:/p', agentId: 'claude', sessionId: '0123456789abcdef' }
    const held = load({ held: true })
    expect((await held.api.deserializeNode(chat)).held).toBe(true)
    const saved = load()
    expect((await saved.api.deserializeNode({ ...chat, held: true })).held).toBe(true)
    expect((await saved.api.deserializeNode(chat)).held).toBeUndefined()
  })
})

describe('H1: the next start, with what was saved', () => {
  it('a pane held stays held after a save: no main word needed', async () => {
    const { api, shellApi } = load()
    const noConversation = { ...base, sleeping: { at: 5, held: true } }
    expect(api.restoresAsleep(noConversation)).toBe(true)
    const leaf = await api.deserializeNode(noConversation)
    expect(leaf.sleeping).toEqual({ at: 5, held: true })
    expect(shellApi.writePty).not.toHaveBeenCalled()
    expect(shellApi.createPty).not.toHaveBeenCalled()
  })

  it('a pane held is not asked for its terminal at the start', () => {
    const { api } = load()
    expect(api.restoresTerminal({ ...base, sleeping: { at: 5, held: true } })).toBe(false)
  })

  it('what a save writes keeps the mark, for an agent and for a chat', () => {
    expect(source).toContain('{ at: node.sleeping.at, ...(node.sleeping.held === true ? { held: true } : {}) }')
    expect(source).toContain("held: node.held === true ? true : undefined")
  })

  it('without the mark, an agent starts as it always did: this changes nothing for an ordinary start', async () => {
    const { api, shellApi } = load()
    await api.deserializeNode({ ...base, sessionId: SAFE })
    expect(shellApi.writePty).toHaveBeenCalledTimes(1)
    expect(shellApi.writePty.mock.calls[0][1]).toContain(`--resume ${SAFE}`)
  })

  it('a pane held stays asleep whatever its id says, and an id that could add to a command line goes', async () => {
    const { api, shellApi } = load()
    const leaf = await api.deserializeNode({ ...base, sessionId: 'x; calc.exe #', sleeping: { at: 5, held: true } })
    expect(leaf).toMatchObject({ sleeping: { at: 5, held: true }, sessionId: null })
    expect(shellApi.writePty).not.toHaveBeenCalled()
  })
})

describe('H1: a click is what wakes it', () => {
  it('being shown does not wake a held pane; an ordinary sleeping one still does', () => {
    const { api } = load()
    expect(api.wakesWhenOpened({ sleeping: { at: 1, held: true } })).toBe(false)
    expect(api.wakesWhenOpened({ sleeping: { at: 1 } })).toBe(true)
    expect(api.wakesWhenOpened({})).toBe(false)
    expect(api.wakesWhenOpened(null)).toBe(false)
    expect(source).toContain('return wakesWhenOpened(leaf) ? leaf.id : null')
  })

  it('its button says why it waits, and shows even in a chat view', () => {
    expect(terminalPane).toContain('node.sleeping && (!chatShown || node.sleeping.held === true)')
    expect(terminalPane).toContain("if (props.node.sleeping && props.node.sleeping.held === true) {")
    expect(terminalPane).toContain("t('pane.sleep.held'")
    expect(terminalPane).toContain("t('pane.sleep.heldShell'")
    expect(terminalPane).toContain('ctx.wakeLeaf && ctx.wakeLeaf(node.id)')
  })

  it('a held chat opens only from the person\'s first message', () => {
    expect(source).toContain("if (leaf.held === true) return { ok: false, code: 'held' }")
    expect(chatPane).toContain('if (props.node.held === true) {\n    delete props.node.held')
  })

  it('wakes on its own host, not on this computer', async () => {
    const { api } = load({ held: true })
    const leaf = await api.deserializeNode({ ...base, sessionId: SAFE, remoteHostId: 'ssh-abc', remotePath: '/srv/x' })
    expect(leaf).toMatchObject({ remoteHostId: 'ssh-abc', remotePath: '/srv/x', sleeping: { held: true } })
  })
})

describe('the window asks, and says when it is done', () => {
  it('asks main at the start; not knowing is the same as yes', () => {
    const body = slice('async function restoreOrSeedLayout()', 'let saved = null')
    expect(body).toContain('holdRestore(window.shellApi.layoutHeld ? await window.shellApi.layoutHeld() : false)')
    expect(body).toContain('holdRestore(true)')
  })

  it('tells main only once the panes are saved asleep', () => {
    const at = source.indexOf('window.shellApi.layoutHeldDone?.()')
    expect(at).toBeGreaterThan(-1)
    const before = source.slice(source.lastIndexOf('if (restoreHeld && persistReady)', at), at)
    expect(before).toContain('saveLayoutNow()')
  })
})

describe('C1: where the start line is built', () => {
  it('a conversation id goes through the check there too, so a backup import gets it', () => {
    const body = slice('async function agentStartLine(', '// Codex, OpenCode')
    expect(body).toContain('if (sessionId && !safeSessionId(sessionId)) sessionId = null')
  })
})

describe('H2: the project mark stays through a save', () => {
  it('restored and saved', () => {
    expect(source).toContain('if (snap.fromCopy === true) ws.fromCopy = true')
    expect(source).toContain('...(w.fromCopy === true ? { fromCopy: true } : {})')
  })
})
