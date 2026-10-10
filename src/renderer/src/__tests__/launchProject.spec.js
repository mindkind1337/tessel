import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'

// Execute the real launcher with a delayed worktree backend and user navigation.
const source = fs.readFileSync('src/renderer/src/App.vue', 'utf8')
const launcher = source.slice(source.indexOf('async function launch('), source.indexOf('// Agents: built-in list'))
function setup() {
  let finish
  const origin = { id: 'A', cwd: 'C:/project-A', tree: { id: 'pane-A' } }
  const other = { id: 'B', cwd: 'ssh://host-B/project-B', remote: { hostId: 'host-B', path: '/project-B' } }
  const ctx = {
    closeMenus() {}, activeId: { value: 'pane-A' }, placement: { value: 'workspace' },
    currentWs: { value: origin }, wsOfLeaf: () => origin,
    agentById: () => ({ id: 'claude', name: 'Claude Code' }), selectedShell: { value: 'pwsh' },
    useWorktree: { value: true }, worktreeState: { available: true },
    window: { shellApi: { createWorktree: () => new Promise(resolve => { finish = resolve }) } },
    worktreeSettings: () => ({}), showToast: vi.fn(), t: (_, english) => english,
    makeWorkspace: () => ({ id: 'new' }), workspaces: { value: [origin, other] },
    selectWorkspace: vi.fn(), wsLeafOpts: ws => ({ remote: ws.remote }),
    createLeaf: vi.fn(async () => ({ id: 'new-pane' })),
    showActive: (ws, id) => { ws.activeId = id }
  }
  vm.createContext(ctx)
  vm.runInContext(launcher + '\nthis.launch = launch', ctx)
  return { ctx, origin, other, finish: () => finish({ ok: true, path: 'C:/project-A-copy', branch: 'work' }) }
}
describe('launch project identity during worktree creation', () => {
  it('keeps the original project and local host after navigation to an SSH project', async () => {
    const { ctx, other, finish } = setup()
    const pending = ctx.launch({ kind: 'agent', id: 'claude' }, 'pane-A', 'workspace')
    ctx.currentWs.value = other
    finish()
    await pending
    expect(ctx.workspaces.value.at(-1)).toMatchObject({ cwd: 'C:/project-A', remote: null })
    expect(ctx.createLeaf.mock.calls[0][2]).toBe('C:/project-A')
    expect(ctx.selectWorkspace).not.toHaveBeenCalled()
  })
  it('still selects the new workspace when the user stayed at the origin', async () => {
    const { ctx, finish } = setup()
    const pending = ctx.launch({ kind: 'agent', id: 'claude' }, 'pane-A', 'workspace')
    finish()
    await pending
    expect(ctx.selectWorkspace).toHaveBeenCalledWith('new')
  })
})
