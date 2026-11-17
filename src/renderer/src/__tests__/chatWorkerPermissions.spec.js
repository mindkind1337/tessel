// A chat worker (orchestration) never runs with more than its coordinator:
// App.vue's coordinatorPermissions and chatOpen's narrowing, run on App.vue's
// own code (as appSettingsBehavior.spec.js does). It never asks to trust a
// folder either.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { validHostAccount, hostAccountChoice, defaultHostAccount } from '../hostAccounts'
import { isRemotePath, parseRemotePath } from '../../../shared/remotePath'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

function load(settingsMode, open = vi.fn(async () => ({ ok: true, sessionId: 's', launchToken: 'tok' }))) {
  const showToast = vi.fn()
  const setOption = vi.fn(async (q) => ({ ok: true, permissionMode: q.permissionMode, permissions: q.permissionMode === 'bypassPermissions' ? 'yolo' : 'manual' }))
  const ctx = {
    isRemotePath,
    parseRemotePath,
    showToast,
    remoteHostLabel: (id) => id,
    t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : '')),
    validHostAccount,
    hostAccountChoice,
    defaultHostAccount,
    CHAT_AGENTS: ['claude', 'codex'],
    settings: { yoloFolders: [], agentPermissions: settingsMode, agentSessionOptions: {}, agentPrefs: {} },
    launchPermissions: () => settingsMode,
    launchSessionValues: () => null,
    effectiveAgent: () => ({ args: settingsMode === 'yolo' ? '--dangerously-skip-permissions --permission-mode dontAsk' : '--permission-mode acceptEdits', env: {} }),
    agentById: (id) => ({ id }),
    modelsFor: () => null,
    paneModelsFor: () => null,
    sentModelId: (m, id) => id,
    scheduleSave: () => {},
    window: { shellApi: { chat: { open, setOption } } }
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('function coordinatorPermissions(coord)', 'async function openWorkerChat(') +
      slice('async function chatOpen(leaf', '// A message for a chat agent') +
      '\nthis.api = { coordinatorPermissions, chatOpen, chatSetOption }',
    ctx
  )
  return { api: ctx.api, open, setOption, showToast }
}

describe('a chat on an SSH host', () => {
  it('opens on the account folder its pane runs on there (checked in main); never one on this PC', async () => {
    const { api, open } = load('manual')
    await api.chatOpen({ id: 'p1', kind: 'chat', agentId: 'claude', cwd: 'ssh://ssh-box1/srv/app', hostAccount: 'abc123' })
    expect(open.mock.calls[0][0]).toMatchObject({ hostAccount: 'abc123' })
    await api.chatOpen({ id: 'p2', kind: 'chat', agentId: 'claude', cwd: 'C:\\proj', hostAccount: 'abc123' })
    expect(open.mock.calls[1][0]).not.toHaveProperty('hostAccount')
    expect(open.mock.calls[0][0]).not.toHaveProperty('hostAccountSignedIn')
  })

  it('on the host’s default account: only if signed in there; signed out, started again on the host’s own sign-in, said', async () => {
    const open = vi.fn(async (q) => (q.hostAccount ? { ok: false, code: 'account', error: 'signed out there' } : { ok: true, sessionId: 's', launchToken: 'tok' }))
    const { api, showToast } = load('manual', open)
    const leaf = { id: 'p1', kind: 'chat', agentId: 'claude', cwd: 'ssh://ssh-box1/srv/app', hostAccount: 'abc123', hostAccountFromDefault: true }
    const res = await api.chatOpen(leaf)
    expect(open.mock.calls[0][0]).toMatchObject({ hostAccount: 'abc123', hostAccountSignedIn: true })
    expect(open.mock.calls[1][0]).not.toHaveProperty('hostAccount')
    expect(res.ok).toBe(true)
    expect(leaf.hostAccount).toBeNull()
    expect(showToast.mock.calls[0][0]).toContain('signed out there')
  })
})

describe('chat worker permissions', () => {
  it("the coordinator's mode: a Yolo terminal agent or Yolo chat, else manual", () => {
    const { api } = load('yolo')
    expect(api.coordinatorPermissions({ kind: 'agent', launchYolo: true })).toBe('yolo')
    expect(api.coordinatorPermissions({ kind: 'agent', launchYolo: false })).toBe('manual')
    expect(api.coordinatorPermissions({ kind: 'chat', chatPermissions: 'yolo' })).toBe('yolo')
    expect(api.coordinatorPermissions({ kind: 'chat' })).toBe('manual')
    expect(api.coordinatorPermissions(null)).toBe('manual')
  })

  it('narrowed to manual: Yolo settings and a permissive --permission-mode are not used', async () => {
    const { api, open } = load('yolo')
    await api.chatOpen({ id: 'p1', kind: 'chat', agentId: 'claude', cwd: 'C:\\w', projectDir: 'C:\\p', maxPermissions: 'manual', worker: true })
    const q = open.mock.calls[0][0]
    expect(q.permissions).toBe('manual')
    expect(q.permissionMode).toBeNull()
    expect(q.askTrust).toBe(false)
    // Main enforces the cap too, and knows it is a worker (trust of its copy).
    expect(q).toMatchObject({ maxPermissions: 'manual', worker: true })
  })

  it("a coordinator's permissions follow each successful mode switch, not only its launch", async () => {
    const { api, open, setOption } = load('yolo')
    const coord = { id: 'c1', kind: 'chat', agentId: 'claude', cwd: 'C:\\w' }
    await api.chatOpen(coord)
    expect(open.mock.calls[0][0]).toMatchObject({ worker: false })
    expect(open.mock.calls[0][0]).not.toHaveProperty('maxPermissions')
    expect(api.coordinatorPermissions(coord)).toBe('yolo')
    await api.chatSetOption(coord, { permissionMode: 'default' })
    expect(setOption).toHaveBeenCalledWith({ paneId: 'c1', permissionMode: 'default' })
    expect(api.coordinatorPermissions(coord)).toBe('manual')
    await api.chatSetOption(coord, { permissionMode: 'bypassPermissions' })
    expect(api.coordinatorPermissions(coord)).toBe('yolo')
    // A refused switch or a model change leaves it as it is.
    setOption.mockResolvedValueOnce({ ok: false, permissions: 'manual' })
    await api.chatSetOption(coord, { permissionMode: 'default' })
    expect(api.coordinatorPermissions(coord)).toBe('yolo')
    await api.chatSetOption(coord, { model: 'opus' })
    expect(api.coordinatorPermissions(coord)).toBe('yolo')
  })

  it('not narrowed: the settings apply as for any chat; a worker still never asks to trust', async () => {
    const { api, open } = load('yolo')
    await api.chatOpen({ id: 'p1', kind: 'chat', agentId: 'claude', cwd: 'C:\\w', worker: true })
    expect(open.mock.calls[0][0]).toMatchObject({ permissions: 'yolo', askTrust: false })
    await api.chatOpen({ id: 'p2', kind: 'chat', agentId: 'claude', cwd: 'C:\\w' })
    expect(open.mock.calls[1][0]).toMatchObject({ askTrust: true })
  })

  it('never widened: a manual user with a Yolo coordinator stays manual', async () => {
    const { api, open } = load('manual')
    await api.chatOpen({ id: 'p1', kind: 'chat', agentId: 'codex', cwd: 'C:\\w', worker: true })
    expect(open.mock.calls[0][0].permissions).toBe('manual')
  })
})
