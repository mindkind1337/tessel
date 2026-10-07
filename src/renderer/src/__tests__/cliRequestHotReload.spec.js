// The window's answers to the tessel command and to the agents' browser and
// terminal tools (App.vue startCliRequests): one listener, removed with the
// app. The main process takes the first answer (cliBridge.js), so a listener
// left by an earlier App (the dev server's hot reload of App.vue) answered
// with the old code: an agent on an SSH host kept hearing "The browser tools
// work in local projects only" from a window already running the code that
// allows it. Run on App.vue's own code.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}
const CODE = slice(
  '// Every listener below is removed when this window',
  'async function startAutomations()'
)

// What the preload gives (ipcRenderer.on / removeListener), shared by every
// App made in the same window.
function makeWindow() {
  const listeners = { request: new Set(), control: new Set(), log: new Set() }
  const replies = []
  const on = (set) => (cb) => {
    set.add(cb)
    return () => set.delete(cb)
  }
  const shellApi = {
    cli: {
      onRequest: on(listeners.request),
      reply: vi.fn(async (msg) => replies.push(msg)),
      ready: vi.fn(async () => true)
    },
    terminalAgent: { onControl: on(listeners.control), onLog: on(listeners.log) }
  }
  // As cliBridge.js: the first answer to an id wins.
  async function ask(method, params, id) {
    for (const cb of [...listeners.request]) cb({ id, method, params })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    return replies.find((m) => m.id === id)
  }
  return { shellApi, listeners, replies, ask }
}

// One App: its setup code, with the browser targets of a given version.
function makeApp(win, version) {
  const unmount = []
  const ctx = {
    window: { shellApi: win.shellApi },
    onBeforeUnmount: (fn) => unmount.push(fn),
    agentBrowserTargets: { handle: vi.fn(async () => ({ version })) },
    agentTerminalTargets: { handle: vi.fn(async () => ({ version })), cancelPane: vi.fn() },
    cliRequests: { handle: vi.fn(async () => ({ version })) },
    onTerminalControl: vi.fn(),
    onTerminalLog: vi.fn()
  }
  vm.runInNewContext(`${CODE}\n;this.startCliRequests = startCliRequests`, ctx)
  return { ctx, start: () => ctx.startCliRequests(), unmount: () => unmount.forEach((fn) => fn()) }
}

describe('App.vue: the cli requests listener and a hot reload', () => {
  it('the new App answers once the old one is gone', async () => {
    const win = makeWindow()
    const old = makeApp(win, 'old')
    old.start()
    expect((await win.ask('browserTarget', { agent: 'pane-1', op: 'list' }, 'r1')).result).toEqual({
      version: 'old'
    })
    // Hot reload: the old App unmounts, a new one mounts and starts.
    old.unmount()
    const fresh = makeApp(win, 'new')
    fresh.start()
    expect(win.listeners.request.size).toBe(1)
    const reply = await win.ask(
      'browserTarget',
      { agent: 'pane-1', op: 'open', url: 'https://example.com' },
      'r2'
    )
    expect(reply.result).toEqual({ version: 'new' })
    expect(old.ctx.agentBrowserTargets.handle).toHaveBeenCalledTimes(1)
    expect(win.replies.filter((m) => m.id === 'r2')).toHaveLength(1)
  })

  it('the terminal tools and the tessel command too', async () => {
    const win = makeWindow()
    const old = makeApp(win, 'old')
    old.start()
    old.unmount()
    const fresh = makeApp(win, 'new')
    fresh.start()
    expect((await win.ask('terminalTarget', { agent: 'pane-1', op: 'list' }, 't1')).result).toEqual(
      { version: 'new' }
    )
    expect((await win.ask('status', {}, 'c1')).result).toEqual({ version: 'new' })
    expect(old.ctx.agentTerminalTargets.handle).not.toHaveBeenCalled()
    expect(old.ctx.cliRequests.handle).not.toHaveBeenCalled()
  })

  it('starting twice keeps one listener', () => {
    const win = makeWindow()
    const app = makeApp(win, 'v')
    app.start()
    app.start()
    expect(win.listeners.request.size).toBe(1)
    app.unmount()
    expect(win.listeners.request.size).toBe(0)
  })

  it("the terminal tools' Stop and log listeners go with the App", () => {
    const win = makeWindow()
    const old = makeApp(win, 'old')
    expect(win.listeners.control.size).toBe(1)
    expect(win.listeners.log.size).toBe(1)
    old.unmount()
    expect(win.listeners.control.size).toBe(0)
    expect(win.listeners.log.size).toBe(0)
    makeApp(win, 'new')
    expect(win.listeners.control.size).toBe(1)
    for (const cb of win.listeners.control) cb({ stopped: true, paneId: 'pane-1' })
    expect(old.ctx.agentTerminalTargets.cancelPane).not.toHaveBeenCalled()
  })
})
