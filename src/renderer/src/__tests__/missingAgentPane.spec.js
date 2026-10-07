// An agent missing on its SSH host (App.vue createLeaf): nothing is typed;
// the pane stays (name, number, team, conversation id) and shows its card
// (TerminalPane): Install, Check again, Open a shell instead. Kept with the
// layout: after a restart the same card, never a failing command typed.
// Run on App.vue's own code, as remotePaneRestore.spec.js does.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { reactive } from 'vue'
import { needsRemoteAgentCheck, remoteAgentLine, remoteInstallCommand, remotePaneInstallCommand } from '../remoteAgentLaunch'
import { remoteAgentFound } from '../projectLauncher'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

const HOST = 'ssh-box'
const SESSION = '22222222-3333-4444-8555-666666666666'

function load({ shared = true, status = null, tree = null } = {}) {
  const states = reactive({ [HOST]: shared ? { status: 'connected', shared: true } : { status: 'disconnected' } })
  const ws = reactive({ id: 'ws1', cwd: null, remote: { hostId: HOST, path: '/srv/app' }, tree })
  let paneNo = 0
  const shellApi = {
    attachPty: vi.fn(async () => ({ ok: false })),
    createPty: vi.fn(async (o) => ({ ok: true, shell: { id: 'pwsh', name: 'PowerShell' }, backend: 'ssh', pid: null, cwd: '/srv/app', remoteHost: { id: o.remoteHostId, label: 'Box' } })),
    killPty: vi.fn(),
    writePty: vi.fn(),
    remoteAgents: { check: vi.fn(async () => status) }
  }
  const findLeafIn = (node, id) => {
    if (!node) return null
    if (node.type === 'leaf') return node.id === id ? node : null
    for (const c of node.children) {
      const f = findLeafIn(c, id)
      if (f) return f
    }
    return null
  }
  const ctx = {
    t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : '')),
    reactive,
    watch: () => {},
    newId: () => `pane-new${++paneNo}`,
    seedBuffer: () => {},
    validPaneSessionOptions: (o) => (o && o.model ? o : null),
    validSavedFiles: () => [],
    launchSessionValues: () => null,
    modelsFor: () => null,
    effectiveAgent: (a) => ({ command: a.command, args: '', env: {} }),
    launchSignature: () => 'sig',
    launchIsYolo: () => false,
    MANUAL_CLAUDE_MODES: [],
    launchPermissions: () => 'manual',
    hostShared: (id) => !!(states[id] && states[id].shared),
    remoteHostLabel: () => 'Box',
    remoteAgentName: (id) => (id === 'codex' ? 'Codex CLI' : 'Claude Code'),
    safeSessionId: (v) => (typeof v === 'string' ? v : null),
    savedOutput: {},
    readDrafts: () => ({}),
    userDraft: {},
    draftUnknown: {},
    agents: { value: [] },
    settings: { resumeAgents: true, yoloFolders: [], agentPermissions: 'manual' },
    FOUND_AFTER_START: [],
    sessionKind: (a) => (a && ['claude', 'codex'].includes(a.id) ? a.id : null),
    teamToolsReady: false,
    teamToolsVersion: null,
    showToast: vi.fn(),
    initError: { value: '' },
    setDraft: vi.fn(),
    findLeaf: (id) => findLeafIn(ws.tree, id),
    wsOfLeaf: (id) => (findLeafIn(ws.tree, id) ? ws : null),
    forEachWsLeaf: () => {},
    replaceNode: (tree, id, make) => (tree.id === id ? make(tree) : tree),
    workspaces: { value: [ws] },
    selectedShell: { value: 'pwsh' },
    askConfirm: vi.fn(async () => true),
    splitLeaf: vi.fn(async () => ({ id: 'pane-install' })),
    openPaneBelow: vi.fn(async () => ({ id: 'pane-below' })),
    restartInPlace: vi.fn(async () => true),
    pendingMessages: {},
    failDelivery: vi.fn(),
    remoteAgentTools: reactive({}),
    needsRemoteAgentCheck,
    remoteAgentLine,
    remoteAgentFound,
    remoteInstallCommand,
    remotePaneInstallCommand,
    setTimeout,
    clearTimeout,
    Promise,
    Object,
    Number,
    window: { shellApi }
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('function serializeNode(node)', '// Rebuild a live tree') +
      slice('async function deserializeNode(snap, cwd = null)', 'let persistReady') +
      slice('async function createLeaf(shellId, agent = null', 'function replaceNode(') +
      slice('const connectingLeaves = new Set()', '// Replace a pane with a fresh process') +
      slice('const REMOTE_CHECK_MS =', 'let offMissingAgentExit = null') +
      '\nthis.api = { serializeNode, deserializeNode, createLeaf, connectLeaf, remoteAgentCommand, installMissingAgent, recheckMissingAgent, missingAgentInstallExit, missingAgentShell, missingAgentInstalls }',
    ctx
  )
  return { api: ctx.api, ctx, ws, shellApi, states }
}

const codexAgent = { id: 'codex', name: 'Codex CLI', command: 'codex' }
// A Codex pane on the host whose Codex is missing: its card.
async function missingPane(env) {
  const leaf = await env.api.createLeaf('pwsh', codexAgent, null, null, { remoteHostId: HOST, remotePath: '/srv/app', sessionId: SESSION, resume: true })
  Object.assign(leaf, { num: 3, paneName: 'api', team: 'team-1' })
  env.ws.tree = leaf
  return leaf
}

describe('an agent missing on its SSH host', () => {
  it('the pane stays (name, number, team, conversation) with its card; nothing is typed', async () => {
    const env = load({ status: { hostId: HOST, claude: '/home/u/.local/bin/claude', codex: false } })
    const leaf = await missingPane(env)
    expect(leaf).toMatchObject({ kind: 'agent', agentId: 'codex', sessionId: SESSION, num: 3, paneName: 'api', team: 'team-1' })
    expect(leaf.agentMissing).toEqual({ agent: 'codex', name: 'Codex CLI', resume: true })
    expect(env.shellApi.writePty).not.toHaveBeenCalled()
    expect(env.ctx.showToast).not.toHaveBeenCalled()
  })

  it('Install: the same confirm with the exact command, run in a pane under it on the host', async () => {
    const env = load({ status: { hostId: HOST, codex: false } })
    await missingPane(env)
    const install = await env.api.installMissingAgent('pane-new1')
    expect(install).toEqual({ id: 'pane-install' })
    const command = remotePaneInstallCommand('codex')
    expect(env.ctx.askConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Install Codex CLI on Box?', code: command }))
    expect(env.ctx.splitLeaf).toHaveBeenCalledWith('pane-new1', 'col', null, 'pwsh', null, { remoteHostId: HOST, remotePath: '/srv/app' })
    expect(env.shellApi.writePty).toHaveBeenCalledWith('pane-install', command + '\r')
    expect(env.ws.tree.agentMissing.installing).toBe('pane-install')
  })

  it('Install cancelled: nothing opened, nothing typed', async () => {
    const env = load({ status: { hostId: HOST, codex: false } })
    await missingPane(env)
    env.ctx.askConfirm.mockResolvedValueOnce(false)
    expect(await env.api.installMissingAgent('pane-new1')).toBe(null)
    expect(env.ctx.splitLeaf).not.toHaveBeenCalled()
    expect(env.shellApi.writePty).not.toHaveBeenCalled()
  })

  it('after the install ends with 0: the host is checked again and the agent starts in this pane', async () => {
    const env = load({ status: { hostId: HOST, codex: false } })
    await missingPane(env)
    await env.api.installMissingAgent('pane-new1')
    env.shellApi.remoteAgents.check.mockResolvedValue({ hostId: HOST, codex: '/home/u/.local/bin/codex' })
    expect(env.api.missingAgentInstallExit('pane-install', 0)).toBe(true)
    await vi.waitFor(() => expect(env.ctx.restartInPlace).toHaveBeenCalledWith('pane-new1', { resume: true }))
    expect(env.shellApi.remoteAgents.check).toHaveBeenLastCalledWith(HOST)
    expect(env.api.missingAgentInstalls['pane-install']).toBeUndefined()
  })

  it('an install that failed (or a pane closed): no check, the card stays', async () => {
    const env = load({ status: { hostId: HOST, codex: false } })
    await missingPane(env)
    await env.api.installMissingAgent('pane-new1')
    const checks = env.shellApi.remoteAgents.check.mock.calls.length
    expect(env.api.missingAgentInstallExit('pane-install', 1)).toBe(false)
    expect(env.shellApi.remoteAgents.check.mock.calls.length).toBe(checks)
    expect(env.ws.tree.agentMissing.installing).toBe(null)
    expect(env.ctx.restartInPlace).not.toHaveBeenCalled()
    // Another pane ending: not ours.
    expect(env.api.missingAgentInstallExit('pane-other', 0)).toBe(false)
  })

  it('Check again: still missing says so; found starts it in this pane, its conversation resumed', async () => {
    const env = load({ status: { hostId: HOST, codex: false } })
    const leaf = await missingPane(env)
    expect(await env.api.recheckMissingAgent('pane-new1')).toBe(false)
    expect(leaf.agentMissing.notFound).toBe(true)
    expect(leaf.agentMissing.checking).toBe(false)
    expect(env.ctx.restartInPlace).not.toHaveBeenCalled()
    // A failed check (not signed in, an error): never started.
    env.shellApi.remoteAgents.check.mockResolvedValueOnce({ hostId: HOST, error: 'not connected' })
    expect(await env.api.recheckMissingAgent('pane-new1')).toBe(false)
    expect(env.ctx.restartInPlace).not.toHaveBeenCalled()
    env.shellApi.remoteAgents.check.mockResolvedValue({ hostId: HOST, codex: true })
    expect(await env.api.recheckMissingAgent('pane-new1')).toBe(true)
    expect(env.ctx.restartInPlace).toHaveBeenCalledWith('pane-new1', { resume: true })
  })

  it('Open a shell instead: a plain shell on the host; what waited for the agent is not typed', async () => {
    const env = load({ status: { hostId: HOST, codex: false } })
    const leaf = await missingPane(env)
    const item = { text: 'hi' }
    env.ctx.pendingMessages['pane-new1'] = [item]
    expect(env.api.missingAgentShell('pane-new1')).toBe(true)
    expect(leaf).toMatchObject({ kind: 'shell', agentId: null, agentCommand: null, sessionId: null, title: 'Box', remoteHostId: HOST, num: 3, paneName: 'api' })
    expect(leaf.agentMissing).toBeUndefined()
    expect(env.ctx.failDelivery).toHaveBeenCalledWith(item)
    expect(env.ctx.pendingMessages['pane-new1']).toBeUndefined()
    expect(env.shellApi.writePty).not.toHaveBeenCalled()
  })
})

describe('a missing-agent pane kept with the layout', () => {
  it('is saved with its card', async () => {
    const env = load({ status: { hostId: HOST, codex: false } })
    const leaf = await missingPane(env)
    expect(env.api.serializeNode(leaf)).toMatchObject({ kind: 'agent', agentId: 'codex', sessionId: SESSION, agentMissing: true, num: 3, team: 'team-1' })
    delete leaf.agentMissing
    expect(env.api.serializeNode(leaf).agentMissing).toBeUndefined()
  })

  const snap = { type: 'leaf', id: 'pane-m1', shellId: 'pwsh', kind: 'agent', agentId: 'codex', agentCommand: 'codex', title: 'Codex CLI', sessionId: SESSION, num: 2, remoteHostId: HOST, remotePath: '/srv/app', agentMissing: true }

  it('its shell still running (reload): re-attached with the same card, nothing typed', async () => {
    const env = load()
    env.shellApi.attachPty.mockResolvedValue({ ok: true, shell: { id: 'pwsh', name: 'PowerShell' }, backend: 'ssh', buffer: '', remoteHostId: HOST })
    const leaf = await env.api.deserializeNode(snap)
    expect(leaf.attached).toBe(true)
    expect(leaf.agentMissing).toEqual({ agent: 'codex', name: 'Codex CLI', resume: true })
    expect(leaf).toMatchObject({ sessionId: SESSION, num: 2 })
    expect(env.shellApi.writePty).not.toHaveBeenCalled()
  })

  it('a new terminal: the host asked again; a check that fails (or is not sure) never types it', async () => {
    for (const status of [null, { hostId: HOST, error: 'timeout' }, { hostId: HOST, codex: false }]) {
      const env = load({ status })
      const leaf = await env.api.deserializeNode(snap)
      expect(env.shellApi.remoteAgents.check).toHaveBeenCalledWith(HOST)
      expect(leaf.agentMissing).toMatchObject({ agent: 'codex', resume: true })
      expect(leaf.sessionId).toBe(SESSION)
      expect(env.shellApi.writePty).not.toHaveBeenCalled()
    }
  })

  it('the host not signed in: waits for Connect, then the same strict check', async () => {
    const env = load({ shared: false, status: { hostId: HOST, error: 'not connected' } })
    env.ws.tree = await env.api.deserializeNode(snap)
    expect(env.ws.tree.notConnected).toBeTruthy()
    expect(env.ws.tree.agentMissing).toMatchObject({ agent: 'codex', name: 'Codex CLI' })
    expect(await env.api.connectLeaf('pane-m1')).toBe(true)
    expect(env.ws.tree.agentMissing).toMatchObject({ agent: 'codex' })
    expect(env.ws.tree.notConnected).toBeFalsy()
    expect(env.shellApi.writePty).not.toHaveBeenCalled()
  })

  it('remoteAgentCommand strict: only a host that says it is there', async () => {
    const env = load({ status: null })
    expect(await env.api.remoteAgentCommand(HOST, 'codex', 'codex')).toBe('codex')
    expect(await env.api.remoteAgentCommand(HOST, 'codex', 'codex', { strict: true })).toBe(null)
    env.shellApi.remoteAgents.check.mockResolvedValue({ hostId: HOST, codex: '/home/u/.local/bin/codex' })
    expect(await env.api.remoteAgentCommand(HOST, 'codex', 'codex', { strict: true })).toBe("'/home/u/.local/bin/codex'")
  })
})
