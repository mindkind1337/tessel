// App.vue: going to another pane (sidebar, notifications, Send to, a new
// pane) while one is maximized keeps full screen, on the pane you go to; a
// pane opened in the background leaves the maximized one as it is.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'

const app = fs.readFileSync('src/renderer/src/App.vue', 'utf8').replace(/\r\n/g, '\n')
// A top-level function of App.vue, from its first line to its closing brace.
function fnSource(head) {
  const start = app.indexOf(head)
  const end = app.indexOf('\n}\n', start)
  if (start < 0 || end < 0) throw new Error(`Missing ${head} in App.vue`)
  return app.slice(start, end + 2)
}

function setup(maximized = null) {
  const a = { type: 'leaf', id: 'pane-a' }
  const b = { type: 'leaf', id: 'pane-b', worktree: { path: 'C:\\wt', branch: 'feature' } }
  const c = { type: 'leaf', id: 'pane-c' }
  const ws = { id: 'ws-1', cwd: 'C:\\project', activeId: a.id, tree: { type: 'split', children: [a, b] } }
  const other = { id: 'ws-2', cwd: 'C:\\other', activeId: c.id, tree: c }
  const leaves = [a, b, c]
  const wsOfLeaf = (id) => [ws, other].find((w) => w.tree.id === id || (w.tree.children || []).some((l) => l.id === id)) || null
  const ctx = {
    maximizedId: { value: maximized },
    currentWsId: { value: ws.id },
    workspaces: { value: [ws, other] },
    wsOfLeaf,
    findLeaf: (id) => leaves.find((l) => l.id === id) || null,
    findLeafIn: (_tree, id) => leaves.find((l) => l.id === id) || null,
    // Like the real one: another workspace comes up with no pane maximized.
    selectWorkspace: vi.fn((id) => {
      if (id === ctx.currentWsId.value) return
      ctx.maximizedId.value = null
      ctx.currentWsId.value = id
    }),
    clearAttention: vi.fn(),
    readForPane: vi.fn(),
    getEditorPane: () => null,
    nextTick: (fn) => fn(),
    getPane: () => ({ paste: vi.fn(), submit: vi.fn() }),
    showToast: vi.fn(),
    paneLabel: (leaf) => leaf.id,
    t: (_key, fallback) => fallback,
    numberPanes: vi.fn(),
    selectedShell: { value: 'pwsh' },
    largestLeaf: () => ({ id: 'pane-a', dir: 'row' }),
    // A split: the new pane goes in and is made the active one (showActive).
    splitLeaf: vi.fn(async () => {
      const leaf = { type: 'leaf', id: 'pane-new' }
      leaves.push(leaf)
      ws.tree.children.push(leaf)
      ctx.showActive(ws, leaf.id)
      return leaf
    }),
    // startTask's other steps (the card, the team, the prompt): stubbed.
    newTaskOpen: { value: false },
    currentWs: { value: ws },
    boardTasks: [],
    addTask: ({ title }) => {
      const task = { id: 'card-1', title }
      ctx.boardTasks.push(task)
      return task
    },
    updateTask: (id, patch) => Object.assign(ctx.boardTasks.find((x) => x.id === id), patch),
    agentById: (id) => ({ id }),
    teamById: () => null,
    recordActivity: vi.fn(),
    agentInfo: () => null,
    deliverToAgent: vi.fn(),
    taskPrompt: () => '',
    taskPanelOpen: { value: true }
  }
  ctx.boardTasks.value = ctx.boardTasks
  vm.createContext(ctx)
  for (const head of ['function showActive(ws, id) {', 'function focusPane(paneId) {', "function sendToPane(fromId, toId, mode, text = '') {", 'async function openBackgroundAgentPane(', 'async function startTask(spec, opts = {}) {'])
    vm.runInContext(fnSource(head), ctx)
  return { ctx, ws, other }
}

describe('focusPane with a maximized pane', () => {
  it('moves full screen to the pane you go to', () => {
    const { ctx, ws } = setup('pane-a')
    ctx.focusPane('pane-b')
    expect(ctx.maximizedId.value).toBe('pane-b')
    expect(ws.activeId).toBe('pane-b')
  })

  it('keeps full screen when the pane is in another workspace', () => {
    const { ctx, other } = setup('pane-a')
    ctx.focusPane('pane-c')
    expect(ctx.selectWorkspace).toHaveBeenCalledWith('ws-2')
    expect(ctx.maximizedId.value).toBe('pane-c')
    expect(other.activeId).toBe('pane-c')
  })

  it('maximizes nothing when no pane was maximized', () => {
    const { ctx, ws } = setup(null)
    ctx.focusPane('pane-b')
    expect(ctx.maximizedId.value).toBe(null)
    expect(ws.activeId).toBe('pane-b')
    ctx.focusPane('pane-c')
    expect(ctx.maximizedId.value).toBe(null)
  })

  it('leaves the maximized pane as is when you go to it', () => {
    const { ctx, ws } = setup('pane-a')
    ctx.focusPane('pane-a')
    expect(ctx.maximizedId.value).toBe('pane-a')
    expect(ws.activeId).toBe('pane-a')
  })

  it('does nothing for a pane in no workspace', () => {
    const { ctx } = setup('pane-a')
    ctx.focusPane('pane-gone')
    expect(ctx.maximizedId.value).toBe('pane-a')
    expect(ctx.selectWorkspace).not.toHaveBeenCalled()
  })
})

describe('showActive', () => {
  it('in the workspace on screen, moves full screen to the pane made active', () => {
    const { ctx, ws } = setup('pane-a')
    ctx.showActive(ws, 'pane-b')
    expect(ws.activeId).toBe('pane-b')
    expect(ctx.maximizedId.value).toBe('pane-b')
  })

  it('maximizes nothing when no pane was maximized', () => {
    const { ctx, ws } = setup(null)
    ctx.showActive(ws, 'pane-b')
    expect(ws.activeId).toBe('pane-b')
    expect(ctx.maximizedId.value).toBe(null)
  })

  it('in another workspace, leaves the full screen on screen as it is', () => {
    const { ctx, other } = setup('pane-a')
    ctx.showActive(other, 'pane-c')
    expect(other.activeId).toBe('pane-c')
    expect(ctx.maximizedId.value).toBe('pane-a')
  })

  it('Send to: the pane sent to comes up full screen', () => {
    const { ctx, ws } = setup('pane-a')
    ctx.sendToPane('pane-a', 'pane-b', 'send', 'hello')
    expect(ws.activeId).toBe('pane-b')
    expect(ctx.maximizedId.value).toBe('pane-b')
  })

  it('a pane opened in the background leaves the maximized and active panes as they are', async () => {
    const { ctx, ws } = setup('pane-a')
    const leaf = await ctx.openBackgroundAgentPane({ ws, agent: null, worktree: null, launchOptions: null })
    expect(leaf.id).toBe('pane-new')
    expect(ws.activeId).toBe('pane-a')
    expect(ctx.maximizedId.value).toBe('pane-a')
  })

  it('a pane opened in the background with nothing maximized maximizes nothing', async () => {
    const { ctx, ws } = setup(null)
    await ctx.openBackgroundAgentPane({ ws, agent: null, worktree: null, launchOptions: null })
    expect(ws.activeId).toBe('pane-a')
    expect(ctx.maximizedId.value).toBe(null)
  })

  it('a background pane whose maximized pane closed meanwhile ends full screen', async () => {
    const { ctx, ws } = setup('pane-a')
    const split = ctx.splitLeaf
    ctx.splitLeaf = async (...args) => {
      const leaf = await split(...args)
      ws.tree.children = ws.tree.children.filter((l) => l.id !== 'pane-b')
      ctx.findLeaf = ((find) => (id) => (id === 'pane-a' ? null : find(id)))(ctx.findLeaf)
      return leaf
    }
    await ctx.openBackgroundAgentPane({ ws, agent: null, worktree: null, launchOptions: null })
    expect(ctx.maximizedId.value).toBe(null)
  })
})

describe('startTask and full screen', () => {
  const spec = { title: 'Fix it', brief: '', agent: { kind: 'agent', id: 'claude' } }

  it("a lead's agent (teamId) starts in the background: the maximized and active panes stay", async () => {
    const { ctx, ws } = setup('pane-a')
    const res = await ctx.startTask(spec, { ws, roomy: true, teamId: 'team-1' })
    expect(res.leaf.id).toBe('pane-new')
    expect(ws.activeId).toBe('pane-a')
    expect(ctx.maximizedId.value).toBe('pane-a')
  })

  it("a lead's agent whose maximized pane closed meanwhile ends full screen", async () => {
    const { ctx, ws } = setup('pane-a')
    const split = ctx.splitLeaf
    ctx.splitLeaf = async (...args) => {
      const leaf = await split(...args)
      ctx.findLeaf = ((find) => (id) => (id === 'pane-a' ? null : find(id)))(ctx.findLeaf)
      return leaf
    }
    await ctx.startTask(spec, { ws, roomy: true, teamId: 'team-1' })
    expect(ctx.maximizedId.value).toBe(null)
  })

  it('a task you start comes up full screen in place of the maximized pane', async () => {
    const { ctx, ws } = setup('pane-a')
    await ctx.startTask(spec, { ws, roomy: true })
    expect(ws.activeId).toBe('pane-new')
    expect(ctx.maximizedId.value).toBe('pane-new')
  })
})
