import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { t } from '../i18n'
import { join } from 'path'

// A card given to an agent already open (App.vue startTask, agent kind
// 'pane'): an agent working in a copy of the project does the card there
// (the card keeps that copy, its prompt says it); a card that has its own
// copy goes only to the agent in that copy; a card taken back (a lead's
// revive) stays on the board when its agent cannot take it.
const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const start = source.indexOf('function taskPrompt(')
const end = source.indexOf('// An agent printed the task signal:', start)

function fixture({ leaf, cards = [], busy = '' }) {
  const ws = { id: 'ws-1', cwd: 'C:/proj' }
  const board = [...cards]
  let n = 0
  const ctx = {
    newTaskOpen: { value: true },
    currentWs: { value: ws },
    workspaces: { value: [ws] },
    boardTasks: board,
    addTask: vi.fn(({ title, wsId }) => {
      const task = { id: `task-${++n}`, title, wsId, column: 'todo' }
      board.push(task)
      return task
    }),
    updateTask: vi.fn((id, patch) => Object.assign(board.find((x) => x.id === id), patch)),
    removeTask: vi.fn((id) => board.splice(board.findIndex((x) => x.id === id), 1)),
    findLeaf: (id) => (leaf && leaf.id === id ? leaf : null),
    busyReason: () => busy,
    busyReasonText: () => busy,
    paneLabel: (l) => l.title,
    showToast: vi.fn(),
    recordActivity: vi.fn(),
    agentInfo: () => ({}),
    shellEnterAt: {},
    deliverToAgent: vi.fn(),
    taskPanelOpen: { value: true },
    showSideTab: vi.fn(),
    teamById: () => null,
    teamLead: () => null,
    channelBoxes: {}
  }
  vm.createContext(Object.assign(ctx, { t }))
  vm.runInContext(source.slice(start, end), ctx)
  return { ws, ctx, board }
}
const agentLeaf = (worktree) => ({ id: 'pane-1', title: 'Ada', ...(worktree ? { worktree } : {}) })
const take = (f, extra = {}) => f.ctx.startTask({ title: 'Fix it', agent: { kind: 'pane', id: 'pane-1' }, ...extra }, { ws: f.ws })

describe('a card given to an agent already open', () => {
  it('in a copy of the project: the card keeps that copy, and the agent is told to work there', async () => {
    const f = fixture({ leaf: agentLeaf({ path: 'C:/copies/ada', branch: 'tessel/ada', baseBranch: 'main', root: 'C:/proj' }) })
    const res = await take(f)
    expect(res.error).toBeUndefined()
    expect(res.task.worktree).toEqual({ path: 'C:/copies/ada', branch: 'tessel/ada', baseBranch: 'main', root: 'C:/proj' })
    const prompt = f.ctx.deliverToAgent.mock.calls[0][1]
    expect(prompt).toContain('your own copy of the project: C:/copies/ada (git branch tessel/ada')
    expect(prompt).not.toContain('directly in the project folder')
  })

  it('a copy known without its branch: said so, never an empty branch name', async () => {
    const f = fixture({ leaf: agentLeaf({ path: 'C:/copies/ada', branch: '' }) })
    const res = await take(f)
    expect(res.task.worktree).toMatchObject({ path: 'C:/copies/ada', root: 'C:/proj' })
    expect(f.ctx.deliverToAgent.mock.calls[0][1]).toContain('(its own git branch, made from')
  })

  it('in the project folder: as before', async () => {
    const f = fixture({ leaf: agentLeaf(null) })
    const res = await take(f)
    expect(res.task.worktree).toBeUndefined()
    expect(f.ctx.deliverToAgent.mock.calls[0][1]).toContain('You work directly in the project folder C:/proj')
  })

  it('a card taken back with its own copy: only by the agent in that copy (any case, slashes)', async () => {
    const card = () => ({ id: 'card-1', title: 'Old', wsId: 'ws-1', column: 'doing', worktree: { path: 'C:\\copies\\old', branch: 'tessel/old' } })
    let f = fixture({ leaf: agentLeaf(null), cards: [card()] })
    let res = await take(f, { cardId: 'card-1' })
    expect(res.error).toMatch(/another folder than the card's copy/)
    expect(f.board).toHaveLength(1)
    expect(f.board[0]).toMatchObject({ column: 'todo', worktree: { path: 'C:\\copies\\old' } })
    expect(f.ctx.deliverToAgent).not.toHaveBeenCalled()
    f = fixture({ leaf: agentLeaf({ path: 'C:/copies/other', branch: 'x' }), cards: [card()] })
    res = await take(f, { cardId: 'card-1' })
    expect(res.error).toBeTruthy()
    f = fixture({ leaf: agentLeaf({ path: 'c:/Copies/Old/', branch: 'tessel/old' }), cards: [card()] })
    res = await take(f, { cardId: 'card-1' })
    expect(res.error).toBeUndefined()
    expect(res.task.worktree.path).toBe('C:\\copies\\old')
    expect(f.board).toHaveLength(1)
  })

  it('a busy agent: a new card goes, a card taken back stays in To do', async () => {
    let f = fixture({ leaf: agentLeaf(null), busy: 'working' })
    expect((await take(f)).error).toBeTruthy()
    expect(f.board).toHaveLength(0)
    f = fixture({ leaf: agentLeaf(null), busy: 'working', cards: [{ id: 'card-1', title: 'Old', wsId: 'ws-1', column: 'doing' }] })
    expect((await take(f, { cardId: 'card-1' })).error).toBeTruthy()
    expect(f.board).toEqual([expect.objectContaining({ id: 'card-1', column: 'todo' })])
  })
})
