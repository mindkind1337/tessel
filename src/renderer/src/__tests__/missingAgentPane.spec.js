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
import { savedPaneModel } from '../paneLastModel'
import { HOST_ACCOUNT_AGENTS, validHostAccount, hostAccountChoice, defaultHostAccount } from '../hostAccounts'
import { needsRemoteAgentCheck, remoteAgentLine, hasClaudeYoloFlag, rootSafeClaudeArgs, hostCodexNoDaemon, remoteCodexNoDaemon, withoutNoDaemon, codexNoDaemonRefusalWatcher } from '../remoteAgentLaunch'
import { remoteInstallLine, remoteInstallPlan } from '../remoteAgentInstalls'
import { NVM_INSTALL_URL } from '../shellChain'
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
// The agents list (main's presets, as the window gets them).
const AGENTS = [
  { id: 'claude', name: 'Claude Code', command: 'claude', install: ['npm install -g @anthropic-ai/claude-code'] },
  { id: 'codex', name: 'Codex CLI', command: 'codex', install: ['npm install -g @openai/codex'] },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', install: ['npm install -g @google/gemini-cli'] },
  { id: 'antigravity', name: 'Antigravity', command: 'agy', install: ['irm https://antigravity.google/cli/install.ps1 | iex'], installShell: 'powershell', installConfirm: true },
  { id: 'opencode2', name: 'OpenCode 2', command: 'opencode2', install: null, docsUrl: 'https://opencode.ai/v2/docs/' }
]

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
    HOST_ACCOUNT_AGENTS,
    validHostAccount,
    hostAccountChoice,
    defaultHostAccount,
    refreshHostAccounts: () => {},
    t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : '')),
    reactive,
    watch: () => {},
    newId: () => `pane-new${++paneNo}`,
    seedBuffer: () => {},
    exitOf: () => null,
    performance,
    validPaneSessionOptions: (o) => (o && o.model ? o : null),
    savedPaneModel,
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
    remoteAgentName: (id) => (AGENTS.find((a) => a.id === id) || { name: id }).name,
    agentById: (id) => AGENTS.find((a) => a.id === id) || null,
    openExternalUrl: vi.fn(),
    NVM_INSTALL_URL,
    safeSessionId: (v) => (typeof v === 'string' ? v : null),
    savedOutput: {},
    readDrafts: () => ({}),
    userDraft: {},
    draftUnknown: {},
    agents: { value: [] },
    settings: { resumeAgents: true, yoloFolders: [], agentPermissions: 'manual' },
    FOUND_AFTER_START: [],
    sessionKind: (a) => (a && ['claude', 'codex'].includes(a.id) ? a.id : null),
    // Its conversation on the host, asked ahead (App.vue hostSessionAhead): not asked here.
    hostSessionAhead: () => null,
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
    remoteInstallLine,
    remoteInstallPlan,
    hasClaudeYoloFlag,
    rootSafeClaudeArgs,
    hostCodexNoDaemon,
    remoteCodexNoDaemon,
    withoutNoDaemon,
    codexNoDaemonRefusalWatcher,
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
      slice('async function deserializeNode(snap, cwd = null, attaching = null)', 'let persistReady') +
      slice('async function createLeaf(shellId, agent = null', 'function replaceNode(') +
      slice('const connectingLeaves = new Set()', '// Replace a pane with a fresh process') +
      slice('const REMOTE_CHECK_MS =', 'let offMissingAgentExit = null') +
      '\nthis.api = { serializeNode, deserializeNode, createLeaf, connectLeaf, remoteAgentCommand, installMissingAgent, recheckMissingAgent, missingAgentInstallExit, missingAgentShell, missingAgentInstalls, missingAgentInstallable }',
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
    // A check that did not say where npm installs: into ~/.local, never sudo.
    const command = 'npm install -g --prefix "$HOME/.local" @openai/codex && exit'
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
    // The host itself, never an answer of a few seconds ago.
    expect(env.shellApi.remoteAgents.check).toHaveBeenLastCalledWith(HOST, { fresh: true })
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

// Found on a server (user fivem2 on a Linux host): Antigravity picked in an
// SSH project, `agy --dangerously-skip-permissions` typed, and the shell
// said "Command 'agy' not found, but can be installed with: snap install
// antigravity-cli". Every agent is now looked for on the host first.
describe('any agent missing on its SSH host (Antigravity)', () => {
  const agy = AGENTS[3]
  const linux = (over = {}) => ({ node: null, nodeMajor: null, npm: null, npmPrefix: null, npmWritable: null, snap: '/usr/bin/snap', curl: '/usr/bin/curl', wget: null, os: 'Linux', ...over })
  const missingAgy = (over = {}) => ({ hostId: HOST, claude: null, codex: null, vscodeClaude: null, agents: { claude: null, codex: null, antigravity: null, gemini: null, opencode2: null }, host: linux(over) })

  it('nothing typed: its card, the pane and its conversation kept', async () => {
    const env = load({ status: missingAgy() })
    const leaf = await env.api.createLeaf('pwsh', agy, null, null, { remoteHostId: HOST, remotePath: '/srv/app', sessionId: SESSION })
    env.ws.tree = leaf
    expect(leaf.agentMissing).toEqual({ agent: 'antigravity', name: 'Antigravity', resume: false })
    expect(leaf.sessionId).toBe(SESSION)
    expect(env.shellApi.writePty).not.toHaveBeenCalled()
    expect(env.api.missingAgentInstallable(leaf.id)).toBe(true)
  })

  it("Install: Antigravity's official script shown first (no sudo); snap offered as a second choice, said to need sudo", async () => {
    const env = load({ status: missingAgy() })
    env.ws.tree = await env.api.createLeaf('pwsh', agy, null, null, { remoteHostId: HOST, remotePath: '/srv/app' })
    await env.api.installMissingAgent('pane-new1')
    const asked = env.ctx.askConfirm.mock.calls[0][0]
    expect(asked).toMatchObject({ title: 'Install Antigravity on Box?', code: 'curl -fsSL https://antigravity.google/cli/install.sh | bash && exit', altLabel: 'Install with snap (sudo)' })
    expect(asked.details).toEqual([
      { label: 'Source', value: 'https://antigravity.google/docs/getting-started' },
      { label: 'Or with snap', value: expect.stringContaining('sudo snap install antigravity-cli: a community package') }
    ])
    expect(env.shellApi.writePty).toHaveBeenCalledWith('pane-install', 'curl -fsSL https://antigravity.google/cli/install.sh | bash && exit\r')
  })

  it('the snap choice: that command, typed in the pane under it', async () => {
    const env = load({ status: missingAgy() })
    env.ws.tree = await env.api.createLeaf('pwsh', agy, null, null, { remoteHostId: HOST, remotePath: '/srv/app' })
    env.ctx.askConfirm.mockResolvedValueOnce('alt')
    await env.api.installMissingAgent('pane-new1')
    expect(env.shellApi.writePty).toHaveBeenCalledWith('pane-install', 'sudo snap install antigravity-cli && exit\r')
    // No snap on the host: no such choice.
    const plain = load({ status: missingAgy({ snap: null }) })
    plain.ws.tree = await plain.api.createLeaf('pwsh', agy, null, null, { remoteHostId: HOST, remotePath: '/srv/app' })
    plain.ctx.askConfirm.mockResolvedValueOnce('alt')
    expect(await plain.api.installMissingAgent('pane-new1')).toBe(null)
    expect(plain.ctx.askConfirm.mock.calls[0][0].altLabel).toBe('')
    expect(plain.shellApi.writePty).not.toHaveBeenCalled()
  })

  it('installed: the host checked again (fresh), and the agent started in its pane as first asked; its path there typed', async () => {
    const env = load({ status: missingAgy() })
    env.ws.tree = await env.api.createLeaf('pwsh', agy, null, null, { remoteHostId: HOST, remotePath: '/srv/app', sessionId: SESSION })
    await env.api.installMissingAgent('pane-new1')
    const found = { ...missingAgy(), agents: { ...missingAgy().agents, antigravity: '/home/fivem2/.local/bin/agy' } }
    env.shellApi.remoteAgents.check.mockResolvedValue(found)
    expect(env.api.missingAgentInstallExit('pane-install', 0)).toBe(true)
    await vi.waitFor(() => expect(env.ctx.restartInPlace).toHaveBeenCalledWith('pane-new1', { resume: false }))
    expect(env.shellApi.remoteAgents.check).toHaveBeenLastCalledWith(HOST, { fresh: true })
    // What its restart types: its path there (~/.local/bin may not be on PATH yet).
    expect(await env.api.remoteAgentCommand(HOST, 'antigravity', 'agy')).toBe("'/home/fivem2/.local/bin/agy'")
  })

  it('an npm agent on a host without npm: Node.js with nvm first, said before it runs', async () => {
    const env = load({ status: missingAgy() })
    env.ws.tree = await env.api.createLeaf('pwsh', AGENTS[2], null, null, { remoteHostId: HOST, remotePath: '/srv/app' })
    await env.api.installMissingAgent('pane-new1')
    const asked = env.ctx.askConfirm.mock.calls[0][0]
    expect(asked.code).toBe(`export NVM_DIR="$HOME/.nvm" && { [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL ${NVM_INSTALL_URL} | bash; } && . "$NVM_DIR/nvm.sh" && nvm install --lts && npm install -g @google/gemini-cli && exit`)
    expect(asked.details[1]).toEqual({ label: 'Node.js', value: expect.stringContaining(NVM_INSTALL_URL) })
  })

  it('Check again, the host too slow (a partial answer): unknown, said so, never started; the card stays', async () => {
    const env = load({ status: missingAgy() })
    const leaf = await env.api.createLeaf('pwsh', agy, null, null, { remoteHostId: HOST, remotePath: '/srv/app' })
    env.ws.tree = leaf
    env.shellApi.remoteAgents.check.mockResolvedValue({ ...missingAgy(), partial: true })
    expect(await env.api.recheckMissingAgent('pane-new1')).toBe(false)
    expect(leaf.agentMissing).toMatchObject({ unsure: true, notFound: false, checking: false })
    expect(env.ctx.restartInPlace).not.toHaveBeenCalled()
    // A pane already missing it starts only on a sure answer.
    expect(await env.api.remoteAgentCommand(HOST, 'antigravity', 'agy', { strict: true })).toBe(null)
    // Missing for sure: said so.
    env.shellApi.remoteAgents.check.mockResolvedValue(missingAgy())
    expect(await env.api.recheckMissingAgent('pane-new1')).toBe(false)
    expect(leaf.agentMissing).toMatchObject({ unsure: false, notFound: true })
  })

  it('no automatic install known: its install page opens, nothing runs on the host', async () => {
    const env = load({ status: missingAgy() })
    env.ws.tree = await env.api.createLeaf('pwsh', AGENTS[4], null, null, { remoteHostId: HOST, remotePath: '/srv/app' })
    expect(env.ws.tree.agentMissing).toMatchObject({ agent: 'opencode2' })
    expect(env.api.missingAgentInstallable('pane-new1')).toBe(false)
    expect(await env.api.installMissingAgent('pane-new1')).toBe(null)
    expect(env.ctx.openExternalUrl).toHaveBeenCalledWith('https://opencode.ai/v2/docs/')
    expect(env.ctx.askConfirm).not.toHaveBeenCalled()
    expect(env.shellApi.writePty).not.toHaveBeenCalled()
  })

  it('neither curl nor wget on the host: said, nothing runs', async () => {
    const env = load({ status: missingAgy({ curl: null, wget: null }) })
    env.ws.tree = await env.api.createLeaf('pwsh', agy, null, null, { remoteHostId: HOST, remotePath: '/srv/app' })
    expect(await env.api.installMissingAgent('pane-new1')).toBe(null)
    expect(env.ctx.showToast).toHaveBeenCalledWith(expect.stringContaining('Neither curl nor wget is installed on Box'), expect.objectContaining({ kind: 'error' }))
    expect(env.ctx.askConfirm).not.toHaveBeenCalled()
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
