import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ReviewPanel from '../components/ReviewPanel.vue'

const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,3 +1,3 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  ' export { a, b }',
  ''
].join('\n')

function setup() {
  window.shellApi = {
    review: {
      info: vi.fn(async () => ({
        ok: true,
        head: 'h1',
        branch: 'agent/x',
        target: 'main',
        rootBranch: 'main',
        files: [{ path: 'src/app.js', status: 'M', added: 1, removed: 1, blob: 'b1' }],
        commits: [],
        uncommitted: [],
        conflicts: [],
        dirtyOverlap: [],
        behind: 0,
        merging: false,
        blocker: null
      })),
      diff: vi.fn(async () => ({ ok: true, text: DIFF }))
    }
  }
  const requestChanges = vi.fn()
  const task = { id: `t-${Math.random()}`, title: 'Task', worktree: { root: 'C:/p', path: 'C:/p.worktrees/x', branch: 'agent/x', baseBranch: 'main' } }
  const w = mount(ReviewPanel, {
    props: { task, agentLabel: '#1 Codex', actions: { requestChanges, merge: vi.fn(), discard: vi.fn(), markDone: vi.fn(), focusAgent: vi.fn(), resolveConflicts: vi.fn() } },
    attachTo: document.body
  })
  return { w, requestChanges }
}

describe('review: comments on diff lines', () => {
  it('a comment on a line goes to the agent with Request changes, tied to its file and line', async () => {
    const { w, requestChanges } = setup()
    await flushPromises()
    await flushPromises()
    const added = w.findAll('tr.rv-line').find((r) => r.classes('add'))
    await added.findAll('.rv-num-click')[1].trigger('click')
    await w.find('.rv-comment-input').setValue('Why 3?')
    await w.findAll('.rv-comment-draft .confirm-btn.primary')[0].trigger('click')
    expect(w.findAll('[data-test="line-comment"]').map((c) => c.find('.rv-comment-text').text())).toEqual(['Why 3?'])
    expect(w.find('[data-test="comment-count"]').text()).toBe('1')
    // A comment on the removed line points at the old file.
    const removed = w.findAll('tr.rv-line').find((r) => r.classes('del'))
    await removed.findAll('.rv-num-click')[0].trigger('click')
    await w.find('.rv-comment-input').setValue('Keep this?')
    await w.findAll('.rv-comment-draft .confirm-btn.primary')[0].trigger('click')
    // Request changes with no general text: the comments alone are enough.
    await w.findAll('.rv-foot .confirm-btn').find((b) => b.text().startsWith('Request changes')).trigger('click')
    await w.findAll('.rv-feedback .confirm-btn.primary')[0].trigger('click')
    expect(requestChanges).toHaveBeenCalledTimes(1)
    const msg = requestChanges.mock.calls[0][0]
    expect(msg).toMatch(/src\/app\.js:2 \(removed line\): Keep this\?/)
    expect(msg).toMatch(/src\/app\.js:2: Why 3\?\n {2}> const b = 3/)
    // Sent: the comments are cleared.
    expect(w.find('[data-test="comment-count"]').exists()).toBe(false)
    w.unmount()
  })
})
