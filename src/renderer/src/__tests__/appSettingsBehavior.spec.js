// App-level behavior of the Orca settings, run on App.vue's own functions
// (as externalIssueWorkspace.spec.js does): notifications (Enable
// Notifications, Terminal Bell, Suppress While Focused, Volume, the test
// notification), Confirm before closing running terminals, Ask Before
// Deleting Workspaces.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { t } from '../i18n'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '../settings'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('notifications', () => {
  let ctx, focused
  beforeEach(() => {
    focused = false
    const ws = { id: 'ws1', name: 'Main' }
    ctx = {
      settings: { ...DEFAULT_SETTINGS },
      addNotification: vi.fn(),
      playAlertSound: vi.fn(),
      showToast: vi.fn(),
      focusPane: vi.fn(),
      wsOfLeaf: () => ws,
      workspaces: { value: [ws] },
      currentWsId: { value: 'ws1' },
      document: { hasFocus: () => focused },
      window: { shellApi: { notify: vi.fn() } },
      Map,
      Date
    }
    vm.createContext(Object.assign(ctx, { t })) // App.vue's interface text goes through t()
    vm.runInContext(
      slice('// An entry in the notification inbox', '// Alt+Arrow: move focus') +
        '\nthis.api = { inboxNote, notifyAgentDone, terminalBell, sendTestNotification }',
      ctx
    )
  })

  it('an agent finishing in the background: a Windows notification and the sound at its volume', () => {
    ctx.settings.alertSound = 'chime'
    ctx.settings.notificationVolume = 40
    ctx.api.notifyAgentDone({ id: 'p', title: 'Claude' })
    expect(ctx.window.shellApi.notify).toHaveBeenCalledTimes(1)
    expect(ctx.playAlertSound).toHaveBeenCalledWith('chime', 40)
  })

  it('Enable Notifications off: no Windows notification, no sound (the inbox still lists it)', () => {
    ctx.settings.notificationsEnabled = false
    ctx.api.notifyAgentDone({ id: 'p', title: 'Claude' })
    expect(ctx.window.shellApi.notify).not.toHaveBeenCalled()
    expect(ctx.playAlertSound).not.toHaveBeenCalled()
    expect(ctx.addNotification).toHaveBeenCalled()
  })

  it('Suppress While Focused off: a Windows notification even while Tessel is in front', () => {
    focused = true
    ctx.api.notifyAgentDone({ id: 'p', title: 'Claude' })
    expect(ctx.window.shellApi.notify).not.toHaveBeenCalled()
    ctx.settings.notifySuppressWhenFocused = false
    ctx.api.notifyAgentDone({ id: 'p', title: 'Claude' })
    expect(ctx.window.shellApi.notify).toHaveBeenCalledTimes(1)
  })

  it('Terminal Bell: off by default; on, "Bell in <workspace>", once per 5 s, not when visible', () => {
    const node = { id: 'p', title: 'PowerShell' }
    ctx.api.terminalBell(node)
    expect(ctx.addNotification).not.toHaveBeenCalled()
    ctx.settings.notifyTerminalBell = true
    ctx.api.terminalBell(node)
    expect(ctx.window.shellApi.notify).toHaveBeenCalledWith({
      title: 'Bell in Main',
      body: 'PowerShell · Attention requested',
      paneId: 'p'
    })
    ctx.api.terminalBell(node)
    expect(ctx.window.shellApi.notify).toHaveBeenCalledTimes(1)
    // Its workspace on screen and Tessel in front: nothing.
    focused = true
    ctx.api.terminalBell({ id: 'q', title: 'Other' })
    expect(ctx.addNotification).toHaveBeenCalledTimes(1)
  })

  it('Send Test Notification always shows one', () => {
    focused = true
    ctx.api.sendTestNotification()
    expect(ctx.window.shellApi.notify).toHaveBeenCalledWith({
      title: 'Tessel notifications are on',
      body: 'This is a test notification from Tessel.'
    })
    expect(ctx.showToast).toHaveBeenCalledWith('Test notification sent', expect.anything())
  })
})

describe('Confirm before closing running terminals', () => {
  let ctx, leaf, ws
  beforeEach(() => {
    leaf = { id: 'p', kind: 'shell', title: 'PowerShell' }
    ws = { id: 'ws1', tree: leaf, activeId: 'p' }
    ctx = {
      settings: { ...DEFAULT_SETTINGS },
      wsOfLeaf: () => ws,
      findLeaf: (id) => (ws.tree && ws.tree.id === id ? ws.tree : null),
      findLeafIn: (tree, id) => (tree && tree.id === id ? tree : null),
      askConfirm: vi.fn(() => Promise.resolve(false)),
      dirtyEditorPaths: () => [],
      releaseOwner: vi.fn(),
      dropBuffer: vi.fn(),
      clearAgentStatus: vi.fn(),
      maximizedId: { value: null },
      removeLeaf: () => null,
      firstLeafId: () => null,
      createLeaf: () => Promise.resolve(null),
      wsLeafOpts: (_ws, opts = {}) => opts,
      selectedShell: { value: 'pwsh' },
      window: { shellApi: { killPty: vi.fn(), ptyRunningWork: vi.fn() } },
      setTimeout,
      Promise,
      Array
    }
    vm.createContext(Object.assign(ctx, { t })) // App.vue's interface text goes through t()
    vm.runInContext(
      slice('// Asks the main process what runs under a terminal', '// Arrange the workspace as an even grid') +
        '\nthis.closeLeaf = closeLeaf',
      ctx
    )
  })

  it('an idle shell closes without a question', async () => {
    ctx.window.shellApi.ptyRunningWork.mockResolvedValue({ running: false, names: [] })
    ctx.closeLeaf('p')
    await flush()
    expect(ctx.askConfirm).not.toHaveBeenCalled()
    expect(ctx.window.shellApi.killPty).toHaveBeenCalledWith('p')
  })

  it('a running command asks first, naming it', async () => {
    ctx.window.shellApi.ptyRunningWork.mockResolvedValue({ running: true, names: ['node.exe'] })
    ctx.closeLeaf('p')
    await flush()
    expect(ctx.askConfirm).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('node.exe is still running') }))
    expect(ctx.window.shellApi.killPty).not.toHaveBeenCalled()
  })

  it('a probe that cannot tell asks too', async () => {
    ctx.window.shellApi.ptyRunningWork.mockRejectedValue(new Error('x'))
    ctx.closeLeaf('p')
    await flush()
    expect(ctx.askConfirm).toHaveBeenCalled()
  })

  it('off: closes at once, without probing', () => {
    ctx.settings.confirmCloseAgent = false
    ctx.closeLeaf('p')
    expect(ctx.window.shellApi.ptyRunningWork).not.toHaveBeenCalled()
    expect(ctx.window.shellApi.killPty).toHaveBeenCalledWith('p')
  })

  it('an agent pane still always asks', () => {
    leaf.kind = 'agent'
    ctx.closeLeaf('p')
    expect(ctx.askConfirm).toHaveBeenCalled()
    expect(ctx.window.shellApi.ptyRunningWork).not.toHaveBeenCalled()
  })
})

describe('Ask Before Deleting Workspaces', () => {
  function run(settingOn) {
    const ws = { id: 'ws1', name: 'Main', tree: { id: 'p', kind: 'shell' } }
    const ctx = {
      settings: { ...DEFAULT_SETTINGS, confirmDeleteWorkspace: settingOn },
      workspaces: { value: [ws, { id: 'ws2', name: 'Other', tree: null }] },
      currentWsId: { value: 'ws2' },
      boardTasks: [],
      forEachLeaf: (tree, fn) => tree && fn(tree),
      dirtyEditorPaths: () => [],
      askConfirm: vi.fn(() => Promise.resolve(false)),
      askEditorClose: vi.fn(),
      removeTask: vi.fn(),
      releaseOwner: vi.fn(),
      dropBuffer: vi.fn(),
      clearAgentStatus: vi.fn(),
      createWorkspace: vi.fn(),
      selectWorkspace: vi.fn(),
      window: { shellApi: { killPty: vi.fn() } },
      Math
    }
    vm.createContext(Object.assign(ctx, { t })) // App.vue's interface text goes through t()
    vm.runInContext(slice('function removeWorkspace(', 'function cycleWorkspace(') + '\nthis.removeWorkspace = removeWorkspace', ctx)
    ctx.removeWorkspace('ws1')
    return ctx
  }
  it('asks by default; off, deletes at once', () => {
    const on = run(true)
    expect(on.askConfirm).toHaveBeenCalled()
    expect(on.workspaces.value).toHaveLength(2)
    const off = run(false)
    expect(off.askConfirm).not.toHaveBeenCalled()
    expect(off.workspaces.value.map((w) => w.id)).toEqual(['ws2'])
  })
})
