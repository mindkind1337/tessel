// Each project's git worktrees, read for the sidebar: only while the window
// is visible, and again once for a project the main process does not know yet.
import { describe, it, expect, vi } from 'vitest'
import { createProjectWorktrees } from '../projectWorktrees'

const wt = (path, branch) => ({ path, branch, head: 'abc', isMain: false, locked: false, prunable: false })

describe('project worktrees', () => {
  it('fills the list of each project folder and forgets a folder that is no longer a project', async () => {
    const store = {}
    const list = vi.fn(async (cwd) => ({ ok: true, worktrees: [wt(`${cwd}-x`, 'x')] }))
    const w = createProjectWorktrees({ list, store, visible: () => true })
    await w.refresh(['C:\\a', 'C:\\b', 'C:\\a', null])
    expect(list).toHaveBeenCalledTimes(2)
    expect(Object.keys(store)).toEqual(['C:\\a', 'C:\\b'])
    const same = store['C:\\a']
    await w.refresh(['C:\\a'])
    expect(store['C:\\a']).toBe(same) // unchanged: not written again
    expect(store['C:\\b']).toBeUndefined()
  })

  it('does nothing while the window is hidden, then runs when it is shown', async () => {
    const store = {}
    let visible = false
    const list = vi.fn(async () => ({ ok: true, worktrees: [wt('C:\\a-x', 'x')] }))
    const w = createProjectWorktrees({ list, store, visible: () => visible })
    await w.refresh(['C:\\a'])
    await w.shown()
    expect(list).not.toHaveBeenCalled()
    visible = true
    await w.shown()
    expect(list).toHaveBeenCalledTimes(1)
    expect(store['C:\\a']).toHaveLength(1)
    await w.shown() // nothing waiting any more
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('a project just added is asked again once; not a repository is empty; a failure keeps what was shown', async () => {
    const store = {}
    const timers = []
    const answers = [
      { ok: false, error: 'unknown-folder' },
      { ok: false, error: 'unknown-folder' }
    ]
    const list = vi.fn(async () => answers.shift() || { ok: true, worktrees: [wt('C:\\a-x', 'x')] })
    const w = createProjectWorktrees({ list, store, visible: () => true, setTimer: (fn) => timers.push(fn) })
    await w.refresh(['C:\\a'])
    expect(timers).toHaveLength(1)
    await timers[0]()
    expect(timers).toHaveLength(1) // once only
    await w.refresh(['C:\\a'])
    expect(store['C:\\a']).toHaveLength(1)

    const failing = createProjectWorktrees({ list: async () => ({ ok: false, error: 'failed' }), store, visible: () => true })
    await failing.refresh(['C:\\a'])
    expect(store['C:\\a']).toHaveLength(1)
    const throwing = createProjectWorktrees({
      list: async () => {
        throw new Error('x')
      },
      store,
      visible: () => true
    })
    await throwing.refresh(['C:\\a'])
    expect(store['C:\\a']).toHaveLength(1)
    const notRepo = createProjectWorktrees({ list: async () => ({ ok: false, error: 'not-repo' }), store, visible: () => true })
    await notRepo.refresh(['C:\\a'])
    expect(store['C:\\a']).toEqual([])
  })
})
