// Chat <-> terminal (App.vue switchToTerminal / switchToChat), run on
// App.vue's own code (as appSettingsBehavior.spec.js does): the same pane id,
// conversation, folder, model and effort; the old side stopped first; never
// more permissions.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { reactive } from 'vue'
import { isPastedImageCopy } from '../chat/terminalChatBridge'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

function load(leaf) {
  const ws = { id: 'ws1', cwd: 'C:\\proj', tree: leaf }
  const calls = []
  const ctx = {
    t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : '')),
    reactive,
    newId: () => 'x',
    findLeaf: (id) => (ws.tree && ws.tree.id === id ? ws.tree : null),
    wsOfLeaf: (id) => (ws.tree && ws.tree.id === id ? ws : null),
    replaceNode: (tree, id, make) => (tree.id === id ? make(tree) : tree),
    agentById: (id) => ({ id, name: id, command: id, available: true }),
    validPaneSessionOptions: (o) => (o && o.model ? o : null),
    selectedShell: { value: 'pwsh' },
    createLeaf: vi.fn(async (shell, agent, cwd, worktree, opts) => ({ type: 'leaf', kind: 'agent', id: opts.id, agentId: agent.id, sessionId: opts.sessionId })),
    clearAgentStatus: () => calls.push('clearStatus'),
    dropBuffer: () => {},
    scheduleSave: () => {},
    showToast: vi.fn(),
    restartingLeaves: new Set(),
    CHAT_AGENTS: ['claude', 'codex'],
    settings: {},
    setTimeout: (fn) => fn(),
    Promise,
    Object,
    window: {
      shellApi: {
        chat: { close: vi.fn(async () => (calls.push('chat.close'), { ok: true })) },
        killPty: () => calls.push('killPty'),
        attachPty: vi.fn(async () => ({ ok: false }))
      }
    }
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('const CHAT_AGENTS', '// Opens (or resumes) a chat pane') +
      slice('async function switchToTerminal(leafId)', '// --- Agent sleep') +
      '\nthis.api = { switchToTerminal, switchToChat }',
    ctx
  )
  return { api: ctx.api, ctx, ws, calls }
}

describe('chat to terminal', () => {
  const chat = (extra = {}) => ({ type: 'leaf', kind: 'chat', id: 'pane-1', agentId: 'claude', cwd: 'C:\\proj\\copy', sessionId: 's-1', model: 'opus', effort: 'high', num: 3, team: 'team-1', ...extra })

  it('stops the chat first, then resumes the same conversation in the same pane', async () => {
    const { api, ctx, ws, calls } = load(chat({ chatPermissions: 'yolo' }))
    expect(await api.switchToTerminal('pane-1')).toBe(true)
    expect(calls.indexOf('chat.close')).toBeLessThan(calls.indexOf('clearStatus'))
    const [, agent, cwd, , opts] = ctx.createLeaf.mock.calls[0]
    expect(agent.id).toBe('claude')
    expect(cwd).toBe('C:\\proj\\copy')
    expect(opts).toMatchObject({ id: 'pane-1', sessionId: 's-1', resume: true, sessionOptions: { model: 'opus', effort: 'high' } })
    // A Yolo chat: no narrowing (the settings decide, as for any pane).
    expect(opts.permissions).toBeUndefined()
    expect(ws.tree).toMatchObject({ kind: 'agent', id: 'pane-1', num: 3, team: 'team-1' })
  })

  it('a chat that asked first (or a capped worker) asks first in the terminal; otherwise Settings decide', async () => {
    for (const extra of [{ chatPermissions: 'manual' }, { chatPermissions: 'yolo', maxPermissions: 'manual' }]) {
      const { api, ctx } = load(chat(extra))
      await api.switchToTerminal('pane-1')
      expect(ctx.createLeaf.mock.calls[0][4].permissions).toBe('manual')
    }
    for (const extra of [{}, { chatPermissions: 'yolo' }]) {
      const { api, ctx } = load(chat(extra))
      await api.switchToTerminal('pane-1')
      expect(ctx.createLeaf.mock.calls[0][4].permissions).toBeUndefined()
    }
  })

  it('no conversation yet: nothing done, said so', async () => {
    const { api, ctx } = load(chat({ sessionId: null }))
    expect(await api.switchToTerminal('pane-1')).toBe(false)
    expect(ctx.createLeaf).not.toHaveBeenCalled()
    expect(ctx.showToast).toHaveBeenCalled()
  })
})

describe('terminal to chat', () => {
  const term = (extra = {}) => ({ type: 'leaf', kind: 'agent', id: 'pane-2', agentId: 'codex', sessionId: 'thread-1', startDir: 'C:\\proj', num: 2, team: 'team-1', launchYolo: false, modelChoice: { model: 'gpt-6', effort: 'low' }, ...extra })

  it('stops the terminal (and waits until it is gone), then the chat takes the same conversation', async () => {
    const { api, ws, calls } = load(term())
    expect(await api.switchToChat('pane-2')).toBe(true)
    expect(calls[0]).toBe('killPty')
    expect(ws.tree).toMatchObject({ kind: 'chat', id: 'pane-2', agentId: 'codex', sessionId: 'thread-1', cwd: 'C:\\proj', num: 2, team: 'team-1', model: 'gpt-6', effort: 'low' })
  })

  it('the chat follows Settings like a new one; only a pane set to ask first (or a capped worker) stays capped', async () => {
    const a = load(term())
    await a.api.switchToChat('pane-2')
    expect(a.ws.tree.maxPermissions).toBeUndefined()
    const pinned = load(term({ permissions: 'manual' }))
    await pinned.api.switchToChat('pane-2')
    expect(pinned.ws.tree.maxPermissions).toBe('manual')
    const worker = load(term({ launchYolo: true, maxPermissions: 'manual' }))
    await worker.api.switchToChat('pane-2')
    expect(worker.ws.tree.maxPermissions).toBe('manual')
    const b = load(term({ launchYolo: true }))
    await b.api.switchToChat('pane-2')
    expect(b.ws.tree.maxPermissions).toBeUndefined()
  })

  it('OpenCode too, with its own session id (ses_…); another id is refused', async () => {
    const ok = load(term({ agentId: 'opencode', sessionId: 'ses_' + 'a'.repeat(26), modelChoice: null }))
    expect(await ok.api.switchToChat('pane-2')).toBe(true)
    expect(ok.ws.tree).toMatchObject({ kind: 'chat', agentId: 'opencode', sessionId: 'ses_' + 'a'.repeat(26) })
    // No Yolo switch in OpenCode's terminal: its chat follows Settings.
    expect(ok.ws.tree.maxPermissions).toBeUndefined()
    const bad = load(term({ agentId: 'opencode', sessionId: 'not-a-session' }))
    expect(await bad.api.switchToChat('pane-2')).toBe(false)
  })

  it('a terminal that does not stop: the pane is left as it is', async () => {
    const { api, ctx, ws } = load(term())
    ctx.window.shellApi.attachPty.mockResolvedValue({ ok: true })
    expect(await api.switchToChat('pane-2')).toBe(false)
    expect(ws.tree.kind).toBe('agent')
  })

  it('only Claude or Codex with a known conversation, on this computer', async () => {
    for (const extra of [{ agentId: 'gemini' }, { sessionId: null }, { remoteHostId: 'ssh-1' }, { detected: true }]) {
      const { api, ws } = load(term(extra))
      expect(await api.switchToChat('pane-2')).toBe(false)
      expect(ws.tree.kind).toBe('agent')
    }
  })
})

describe('a switch asked while the agent works waits for the end of its turn', () => {
  it('chat to terminal: nothing stopped while it works, done when it is idle; asked again: cancelled', async () => {
    const leaf = { type: 'leaf', kind: 'chat', id: 'pane-1', agentId: 'claude', sessionId: 's1', cwd: 'C:\proj', paneName: 'Ada' }
    let tick = null
    let state = 'working'
    const done = []
    const ctx = {
      t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : '')),
      reactive,
      findLeaf: (id) => (id === leaf.id ? leaf : null),
      chatPaneState: () => state,
      paneState: () => state,
      showToast: vi.fn(),
      setInterval: (fn) => ((tick = fn), 1),
      clearInterval: () => {},
      onBeforeUnmount: () => {},
      switchToTerminal: (id) => done.push(['terminal', id]),
      switchToChat: (id) => done.push(['chat', id]),
      Object
    }
    vm.createContext(ctx)
    vm.runInContext(slice('// Chat <-> terminal while the agent works', 'async function switchToTerminal(leafId)') + '\nthis.requestSwitch = requestSwitch; this.pendingSwitch = pendingSwitch', ctx)
    expect(ctx.requestSwitch('pane-1', 'terminal')).toBe(false)
    tick()
    expect(done).toEqual([])
    expect(ctx.pendingSwitch['pane-1']).toBe('terminal')
    state = 'ready'
    tick()
    expect(done).toEqual([['terminal', 'pane-1']])
    // Asked twice while working: cancelled, nothing happens.
    state = 'working'
    ctx.requestSwitch('pane-1', 'terminal')
    ctx.requestSwitch('pane-1', 'terminal')
    state = 'ready'
    tick()
    expect(done).toHaveLength(1)
    // Idle: at once.
    ctx.requestSwitch('pane-1', 'terminal')
    expect(done).toHaveLength(2)
  })
})

describe("a terminal agent's chat view (App.vue sendFromChatView / chatViewEnded)", () => {
  function loadView(leaf) {
    const ctx = {
      ...load(leaf).ctx,
      deliverToAgent: vi.fn(),
      isPastedImageCopy
    }
    ctx.findLeaf = (id) => (id === leaf.id ? leaf : null)
    vm.createContext(ctx)
    vm.runInContext(slice('async function switchToTerminal(leafId)', '// --- Agent sleep') + '\nthis.view = { sendFromChatView, chatViewEnded, switchingLeaves }', ctx)
    return ctx
  }
  const agent = (extra = {}) => ({ type: 'leaf', kind: 'agent', id: 'pane-5', agentId: 'claude', chatView: true, ...extra })

  it('what is written there goes through the usual delivery to the terminal (from you)', () => {
    const ctx = loadView(agent())
    const onDelivered = vi.fn()
    expect(ctx.view.sendFromChatView('pane-5', 'hello', { onDelivered })).toBe(true)
    expect(ctx.deliverToAgent).toHaveBeenCalledWith('pane-5', 'hello', expect.objectContaining({ source: 'you', onDelivered }))
  })

  it('its images (Tessel\'s own copies only) and slash commands go with the message', () => {
    const copy = ['C:', 'Temp', 'tessel-paste', 'chat', 'img_0123456789abcdef01234567.png'].join(String.fromCharCode(92))
    const ctx = loadView(agent())
    expect(ctx.view.sendFromChatView('pane-5', 'look', { images: [copy] })).toBe(true)
    expect(ctx.deliverToAgent).toHaveBeenCalledWith('pane-5', 'look', expect.objectContaining({ images: [copy] }))
    expect(ctx.view.sendFromChatView('pane-5', '/compact', { command: 'paste' })).toBe(true)
    expect(ctx.deliverToAgent).toHaveBeenLastCalledWith('pane-5', '/compact', expect.objectContaining({ command: 'paste' }))
    const onFailed = vi.fn()
    expect(ctx.view.sendFromChatView('pane-5', 'look', { images: ['C:/Users/me/secret.png'], onFailed })).toBe(false)
    expect(ctx.view.sendFromChatView('pane-5', '/x', { command: 'raw', onFailed })).toBe(false)
    expect(onFailed).toHaveBeenCalledTimes(2)
    expect(ctx.deliverToAgent).toHaveBeenCalledTimes(2)
  })

  it('not shown as a chat, or asleep: nothing is typed, the message is given back', () => {
    for (const extra of [{ chatView: false }, { sleeping: { at: 1 } }, { kind: 'chat' }]) {
      const ctx = loadView(agent(extra))
      const onFailed = vi.fn()
      expect(ctx.view.sendFromChatView('pane-5', 'hello', { onFailed })).toBe(false)
      expect(ctx.deliverToAgent).not.toHaveBeenCalled()
      expect(onFailed).toHaveBeenCalled()
    }
  })

  it('the agent ending shows the terminal again, but not a restart, a sleep or a switch in progress', () => {
    const ended = agent()
    expect(loadView(ended).view.chatViewEnded('pane-5')).toBe(true)
    expect(ended.chatView).toBeUndefined()
    const restarting = agent()
    const r = loadView(restarting)
    r.restartingLeaves.add('pane-5')
    expect(r.view.chatViewEnded('pane-5')).toBe(false)
    expect(restarting.chatView).toBe(true)
    const asleep = agent({ sleeping: { at: 1 } })
    expect(loadView(asleep).view.chatViewEnded('pane-5')).toBe(false)
    expect(asleep.chatView).toBe(true)
  })
})
