// "Sleep" from the sidebar (a pane's or a workspace's menu): agents and
// terminals on this computer stop their terminal; the pane you are in, a
// terminal on an SSH host and an agent that cannot be resumed stay awake, and
// the toast says why. Run on App.vue's own code (sleepPanes, putToSleep).
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

function load(leaves, { active = null, screen = 'PS C:\\p> dir\nfile.txt' } = {}) {
  const byId = Object.fromEntries(leaves.map((l) => [l.id, l]))
  const toasts = []
  const watchers = []
  const ctx = {
    t: (k, en, vars) => en.replace(/\{\{(\w+)\}\}/g, (_, n) => (vars && vars[n] != null ? vars[n] : '')),
    watch: (getter, cb) => watchers.push({ getter, cb }),
    wakeLeaf: vi.fn(),
    findLeaf: (id) => byId[id] || null,
    wsOfLeaf: () => ({ id: 'ws1' }),
    currentWsId: { value: 'ws1' },
    activeId: { value: active },
    restartingLeaves: new Set(),
    sleptWhileOpen: new Set(),
    liveShare: { isGuestLeaf: () => false },
    paneLabel: (l) => l.paneName || l.id,
    sessionKind: ({ id }) => (id === 'claude' ? 'claude' : null),
    safeSessionId: (s) => typeof s === 'string' && s.length > 0,
    getPane: () => ({ screenText: () => screen }),
    showToast: (text) => toasts.push(text),
    settings: { agentSleepMinutes: 30 },
    window: { shellApi: { killPty: vi.fn(), log: vi.fn() } }
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('function sleepPanes(ids)', 'function copyText(') +
      slice('function putToSleep(leaf', '// Opening a sleeping pane') +
      // The watches that wake the pane you open (and forget one you left).
      slice('// A sleeping pane you open wakes up.', 'const sleepTimer'),
    ctx
  )
  return { ctx, toasts, watchers }
}

describe("the sidebar's Sleep", () => {
  it('a terminal goes to sleep too: its terminal stopped, what it showed kept for the new shell', () => {
    const shell = { id: 'pane-1', kind: 'shell', paneName: 'PowerShell' }
    const { ctx, toasts } = load([shell])
    ctx.sleepPanes(['pane-1'])
    expect(shell.sleeping).toEqual({ at: expect.any(Number) })
    expect(ctx.window.shellApi.killPty).toHaveBeenCalledWith('pane-1')
    expect(shell.restoredText).toBe('PS C:\\p> dir\r\nfile.txt')
    expect(toasts).toEqual(['1 pane asleep. Open it to wake it.'])
    expect(ctx.window.shellApi.log).toHaveBeenCalledWith('info', 'agent sleep: PowerShell asleep (from the sidebar)')
  })

  it("a workspace's Sleep: agents and terminals together; the agents' own toast when only agents", () => {
    const agent = { id: 'pane-a', kind: 'agent', agentId: 'claude', sessionId: 's1' }
    const shell = { id: 'pane-s', kind: 'shell' }
    const { ctx, toasts } = load([agent, shell])
    ctx.sleepPanes(['pane-a', 'pane-s'])
    expect(agent.sleeping && shell.sleeping).toBeTruthy()
    expect(toasts).toEqual(['2 panes asleep. Open one to wake it.'])
    const only = load([{ id: 'pane-b', kind: 'agent', agentId: 'claude', sessionId: 's2' }])
    only.ctx.sleepPanes(['pane-b'])
    expect(only.toasts).toEqual(['1 agent asleep. Open a pane to wake it.'])
  })

  it('stays awake, and says why: the pane you are in, a terminal on an SSH host, an agent that cannot be resumed', () => {
    const here = { id: 'pane-here', kind: 'shell', paneName: 'Here' }
    const remote = { id: 'pane-ssh', kind: 'shell', paneName: 'Box', remoteHostId: 'box' }
    const fresh = { id: 'pane-new', kind: 'agent', agentId: 'claude', paneName: 'New', sessionId: null }
    const { ctx, toasts } = load([here, remote, fresh], { active: 'pane-here' })
    ctx.sleepPanes(['pane-here', 'pane-ssh', 'pane-new'])
    expect(here.sleeping || remote.sleeping || fresh.sleeping).toBeFalsy()
    expect(ctx.window.shellApi.killPty).not.toHaveBeenCalled()
    expect(toasts).toEqual([
      'Stays awake: Here (the pane you are in), Box (a terminal on an SSH host), New (its conversation cannot be resumed).'
    ])
  })

  it('the pane you are in, asked for by itself (its own menu): it sleeps and stays asleep on screen until you leave it and come back', () => {
    const here = { id: 'pane-here', kind: 'agent', agentId: 'claude', sessionId: 's1', paneName: 'Lovelace' }
    const { ctx, toasts, watchers } = load([here], { active: 'pane-here' })
    ctx.sleepPanes(['pane-here'])
    expect(here.sleeping).toEqual({ at: expect.any(Number) })
    expect(ctx.window.shellApi.killPty).toHaveBeenCalledWith('pane-here')
    expect(toasts).toEqual(['1 agent asleep. Open a pane to wake it.'])
    const [opened, left] = watchers
    // The watch sees the pane on screen asleep: it leaves it asleep.
    opened.cb(opened.getter())
    expect(ctx.wakeLeaf).not.toHaveBeenCalled()
    // You go to another pane, then come back to it: it wakes.
    ctx.activeId.value = 'pane-other'
    left.cb('pane-other', 'pane-here')
    ctx.activeId.value = 'pane-here'
    opened.cb(opened.getter())
    expect(ctx.wakeLeaf).toHaveBeenCalledWith('pane-here')
  })

  it('an editor, a browser or a pane already asleep: nothing done', () => {
    const editor = { id: 'pane-e', kind: 'editor' }
    const asleep = { id: 'pane-z', kind: 'shell', sleeping: { at: 1 } }
    const { ctx, toasts } = load([editor, asleep])
    ctx.sleepPanes(['pane-e', 'pane-z'])
    expect(ctx.window.shellApi.killPty).not.toHaveBeenCalled()
    expect(toasts).toEqual([])
  })
})
