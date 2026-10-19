// Review: "Open in editor" on each changed file of the agent's copy, at its
// first change when its diff is the one shown; never for a deleted file nor
// a Live Share host's task (read only).
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ReviewPanel from '../components/ReviewPanel.vue'

const DIFF = ['diff --git a/src/app.js b/src/app.js', '--- a/src/app.js', '+++ b/src/app.js', '@@ -4,3 +4,3 @@', ' const a = 1', '-const b = 2', '+const b = 3', ' export { a, b }', ''].join('\n')

function setup({ source = null } = {}) {
  const info = {
    ok: true,
    head: 'h1',
    branch: 'agent/x',
    target: 'main',
    rootBranch: 'main',
    files: [
      { path: 'src/app.js', status: 'M', added: 1, removed: 1, blob: 'b1' },
      { path: 'old.txt', status: 'D', added: 0, removed: 3, blob: 'b2' }
    ],
    commits: [],
    uncommitted: [],
    conflicts: [],
    dirtyOverlap: [],
    behind: 0,
    merging: false,
    blocker: null
  }
  window.shellApi = { review: { info: vi.fn(async () => info), diff: vi.fn(async () => ({ ok: true, text: DIFF })) } }
  const openInEditor = vi.fn(() => true)
  const task = { id: `t-${Math.random()}`, title: 'Task', worktree: { root: 'C:/p', path: 'C:\\p.worktrees\\x', branch: 'agent/x', baseBranch: 'main' } }
  const actions = { requestChanges: vi.fn(), merge: vi.fn(), discard: vi.fn(), markDone: vi.fn(), focusAgent: vi.fn(), resolveConflicts: vi.fn(), openInEditor }
  const w = mount(ReviewPanel, {
    props: { task, agentLabel: '#1 Codex', actions, ...(source ? { source: { ...source, info: async () => info, diff: async () => ({ ok: true, text: DIFF }) } } : {}) },
    attachTo: document.body
  })
  return { w, openInEditor }
}

describe('review: open in editor', () => {
  it("opens the selected file of the agent's copy at its first change", async () => {
    const { w, openInEditor } = setup()
    await flushPromises()
    await flushPromises()
    await w.find('[data-test="rv-open-editor"]').trigger('click')
    expect(openInEditor).toHaveBeenCalledWith({ file: 'C:\\p.worktrees\\x\\src\\app.js', line: 5 })
    // One button per file that still exists.
    expect(w.findAll('[data-test="rv-open-file"]')).toHaveLength(1)
    w.unmount()
  })

  it("a Live Share host's task offers nothing to open", async () => {
    const { w } = setup({ source: { host: 'Ana', key: 'k' } })
    await flushPromises()
    await flushPromises()
    expect(w.find('[data-test="rv-open-editor"]').exists()).toBe(false)
    expect(w.find('[data-test="rv-open-file"]').exists()).toBe(false)
    w.unmount()
  })
})
