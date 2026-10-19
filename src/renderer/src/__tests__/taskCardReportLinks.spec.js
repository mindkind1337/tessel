// A task card's report (TaskCard.vue) read as the chat shows it: Markdown,
// its paths and the files it lists opened in the card's worktree copy (the
// chat's file link checks), its web links through the link router; another
// board's (a Live Share host's): no path is a link.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import TaskCard from '../components/TaskCard.vue'

const task = (extra = {}) => ({
  id: 'task-r-1',
  title: 'Add the tab',
  column: 'review',
  paneId: 'p1',
  worktree: { path: 'C:\\copies\\tab', branch: 'tessel/tab' },
  report: { outcome: 'succeeded', summary: 'Added **the tab** in `src/tab.js`, see [the issue](https://example.com/issues/7).', files: ['src/tab.js', 'docs/tab.md'] },
  ...extra
})
function make(t, props = {}) {
  window.shellApi = { chatFiles: { stat: vi.fn(async (paths) => Object.fromEntries(paths.map((p) => [p, 'file']))) } }
  const ctx = { findLeaf: () => ({ id: 'p1', cwd: 'C:\\proj' }), paneFolder: (leaf) => leaf.cwd, viewFile: vi.fn(async () => true), openTarget: vi.fn(async () => true), toast: vi.fn() }
  const w = mount(TaskCard, { props: { task: t, agentPanes: [], ...props }, global: { provide: { panelCtx: ctx, askConfirm: async () => true } }, attachTo: document.body })
  return { w, ctx }
}
const norm = (p) => p.replace(/\\/g, '/')

afterEach(() => {
  document.body.innerHTML = ''
  delete window.shellApi
})

describe('TaskCard.vue: the report', () => {
  it('renders Markdown; a listed file opens in the card’s worktree copy, a web link through the router', async () => {
    const { w, ctx } = make(task())
    await w.find('.task-report-head').trigger('click')
    const text = w.find('[data-test="task-report-text"]')
    expect(text.find('strong').text()).toBe('the tab')
    const files = w.findAll('[data-test="task-report-file"]')
    expect(files.map((f) => f.text())).toEqual(['src/tab.js', 'docs/tab.md'])
    await files[1].trigger('click')
    await flushPromises()
    expect(ctx.viewFile).toHaveBeenCalledTimes(1)
    expect(norm(ctx.viewFile.mock.calls[0][0].file)).toBe('C:/copies/tab/docs/tab.md')
    // A path in the summary: the copy's too.
    const code = text.findAll('a').find((a) => a.text().includes('src/tab.js'))
    await code.trigger('click')
    await flushPromises()
    expect(norm(ctx.viewFile.mock.calls[1][0].file)).toBe('C:/copies/tab/src/tab.js')
    await text.findAll('a').find((a) => a.text() === 'the issue').trigger('click')
    expect(ctx.openTarget).toHaveBeenCalledWith('https://example.com/issues/7', expect.any(Object))
    w.unmount()
  })

  it('without a copy: its agent pane’s folder', async () => {
    const { w, ctx } = make(task({ worktree: null }))
    await w.find('.task-report-head').trigger('click')
    await w.findAll('[data-test="task-report-file"]')[0].trigger('click')
    await flushPromises()
    expect(norm(ctx.viewFile.mock.calls[0][0].file)).toBe('C:/proj/src/tab.js')
    w.unmount()
  })

  it('another board’s card: its paths stay text', async () => {
    const source = { can: {}, cards: () => [], review: vi.fn() }
    const { w } = make(task(), { source })
    await w.find('.task-report-head').trigger('click')
    expect(w.findAll('[data-test="task-report-file"]')).toHaveLength(0)
    expect(w.find('[data-test="task-report-text"]').findAll('a').some((a) => a.text().includes('src/tab.js'))).toBe(false)
    w.unmount()
  })
})
