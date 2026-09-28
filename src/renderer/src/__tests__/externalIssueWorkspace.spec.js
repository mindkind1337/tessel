import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'

// Exercise the real App workflow with an asynchronous Git copy, before any
// terminal is started. The workspace can change while main is preparing it.
const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const start = source.indexOf('async function startTask(')
const end = source.indexOf('// An agent printed the task signal:', start)

function fixture() {
  const ws = { id: 'ws-1', cwd: 'C:/original' }
  const task = { id: 'task-1' }
  let finishCopy
  const ctx = {
    newTaskOpen: { value: true },
    currentWs: { value: ws },
    workspaces: { value: [ws] },
    addTask: vi.fn(() => task),
    updateTask: vi.fn((id, patch) => Object.assign(task, patch)),
    agentById: () => ({ id: 'codex' }),
    worktreeSettings: () => ({ branchPrefix: 'custom', branchPrefixCustom: 'agent', workspaceDir: '' }),
    showToast: vi.fn(),
    splitLeaf: vi.fn(),
    createLeaf: vi.fn(),
    window: {
      shellApi: {
        createWorktree: vi.fn(
          () =>
            new Promise((resolve) => {
              finishCopy = resolve
            })
        )
      }
    }
  }
  vm.createContext(ctx)
  vm.runInContext(source.slice(start, end), ctx)
  const spec = { title: 'Linked issue', isolated: true, agent: { kind: 'new', id: 'codex' } }
  return {
    ws,
    ctx,
    task,
    run: () => ctx.startTask(spec, { ws, expectedCwd: 'C:/original' }),
    finish: () =>
      finishCopy({
        ok: true,
        path: 'C:/prepared',
        branch: 'tessel/issue',
        baseBranch: 'main',
        root: 'C:/original'
      })
  }
}

describe('external issue workspace during worktree preparation', () => {
  it('does not create a task when its project already changed', async () => {
    const f = fixture()
    f.ws.cwd = 'C:/another'
    expect(await f.run()).toMatchObject({ error: expect.stringContaining('folder changed') })
    expect(f.ctx.addTask).not.toHaveBeenCalled()
    expect(f.ctx.window.shellApi.createWorktree).not.toHaveBeenCalled()
  })
  it.each(['changed', 'closed'])(
    'preserves the prepared copy without starting an agent if the workspace is %s',
    async (mode) => {
      const f = fixture()
      const pending = f.run()
      if (mode === 'changed') f.ws.cwd = 'C:/another'
      else f.ctx.workspaces.value = []
      f.finish()
      expect(await pending).toMatchObject({
        error: expect.stringContaining('no agent was started')
      })
      expect(f.task).toMatchObject({
        column: 'todo',
        worktree: { path: 'C:/prepared', root: 'C:/original' }
      })
      expect(f.ctx.createLeaf).not.toHaveBeenCalled()
      expect(f.ctx.splitLeaf).not.toHaveBeenCalled()
    }
  )
})
