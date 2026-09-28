// The right side panel (SidePanel.vue): its tab bar switches between Files,
// Changes and Tasks; a tab is created when first shown, then kept.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import SidePanel from '../components/SidePanel.vue'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import { setTasks, addTask } from '../taskBoardStore'

const ROOT = 'C:\\proj'
let calls
beforeEach(() => {
  setTasks([])
  calls = []
  const rec = (name, value) => (q) => {
    calls.push([name, q])
    return Promise.resolve(typeof value === 'function' ? value(q) : value)
  }
  window.shellApi = {
    explorer: {
      list: rec('list', (q) =>
        q.dir === ROOT
          ? {
              ok: true,
              entries: [
                { name: 'dist', path: ROOT + '\\dist', dir: true },
                { name: 'a.js', path: ROOT + '\\a.js', dir: false },
                { name: 'new.md', path: ROOT + '\\new.md', dir: false }
              ]
            }
          : { ok: true, entries: [] }
      ),
      status: rec('status', (q) => ({
        ok: true,
        repo: true,
        files: q.ignored
          ? { [ROOT + '\\a.js']: 'M', [ROOT + '\\new.md']: 'U', [ROOT + '\\dist']: '!' }
          : { [ROOT + '\\a.js']: 'M', [ROOT + '\\new.md']: 'U', [ROOT + '\\gone.txt']: 'D' }
      })),
      searchNames: rec('searchNames', {
        ok: true,
        results: [{ name: 'deep.js', path: ROOT + '\\src\\deep.js', rel: 'src\\deep.js', dir: false }],
        truncated: false
      }),
      searchContent: rec('searchContent', {
        ok: true,
        results: [{ path: ROOT + '\\a.js', rel: 'a.js', line: 3, text: 'const needle = 1' }],
        truncated: false
      }),
      watch: rec('watch', { ok: true }),
      unwatch: rec('unwatch', { ok: true }),
      onChanged: () => () => {}
    },
    scm: {
      status: rec('scm.status', (q) =>
        q.root === ROOT
          ? {
              ok: true,
              repo: true,
              top: ROOT,
              branch: 'main',
              hasUpstream: false,
              ahead: 0,
              behind: 0,
              remotes: [],
              entries: [
                { path: 'a.js', area: 'unstaged', status: 'modified', added: 2, removed: 1 },
                { path: 'gone.txt', area: 'unstaged', status: 'deleted' },
                { path: 'new.md', area: 'untracked', status: 'untracked' }
              ]
            }
          : { ok: true, repo: true, top: q.root, branch: 'tessel/fix', hasUpstream: false, remotes: [], entries: [] }
      )
    }
  }
})
afterEach(() => {
  vi.useRealTimers()
  delete window.shellApi
})

const make = (tab) => mount(SidePanel, { props: { tab, root: ROOT, workspaceId: 'ws1' }, attachTo: document.body })

describe('SidePanel.vue', () => {
  it('shows the tab asked for, and asks for another when one is clicked', async () => {
    const w = make('tasks')
    expect(w.find('[data-test="side-tab-tasks"]').classes()).toContain('on')
    expect(w.find('[data-test="add-task-form"]').exists()).toBe(true)
    expect(w.findComponent(ExplorerPanel).exists()).toBe(false) // not created before it is shown
    await w.find('[data-test="side-tab-files"]').trigger('click')
    expect(w.emitted('update:tab')).toEqual([['files']])
    await w.find('[data-test="side-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('keeps a tab once shown (hidden, not destroyed) when switching', async () => {
    const w = make('files')
    await flushPromises()
    expect(w.findComponent(ExplorerPanel).isVisible()).toBe(true)
    await w.setProps({ tab: 'tasks' })
    expect(w.findComponent(ExplorerPanel).exists()).toBe(true)
    expect(w.findComponent(ExplorerPanel).isVisible()).toBe(false)
    expect(w.find('[data-test="side-tab-tasks"]').attributes('aria-selected')).toBe('true')
    w.unmount()
  })

  it('Files: the tree with git letters, ignored entries dimmed with ⊘', async () => {
    const w = make('files')
    await flushPromises()
    expect(calls.find(([n, q]) => n === 'status' && q.ignored)).toBeTruthy()
    const rows = w.findAll('.explorer-row')
    expect(rows.map((r) => r.find('.explorer-name').text())).toEqual(['dist', 'a.js', 'new.md'])
    expect(rows[0].classes()).toContain('ignored')
    expect(rows[0].find('.explorer-ignored').attributes('title')).toBe('Ignored by .gitignore')
    expect(rows[1].find('.explorer-git').text()).toBe('M')
    expect(rows[2].classes()).toContain('git-U')
    w.unmount()
  })

  it('Files: searches by name, then by content (the line is passed on open)', async () => {
    vi.useFakeTimers()
    const w = make('files')
    await flushPromises()
    await w.find('[data-test="explorer-search"]').setValue('deep')
    vi.advanceTimersByTime(200)
    await flushPromises()
    expect(calls.find(([n]) => n === 'searchNames')[1]).toMatchObject({ root: ROOT, query: 'deep' })
    const hit = w.find('.explorer-hit')
    expect(hit.find('.explorer-name').text()).toBe('deep.js')
    expect(hit.find('.explorer-hit-dir').text()).toBe('src')
    await hit.trigger('click')
    expect(w.emitted('open')[0]).toEqual([ROOT + '\\src\\deep.js', undefined])

    await w.find('[data-test="explorer-mode-content"]').trigger('click')
    vi.advanceTimersByTime(100)
    await flushPromises()
    expect(calls.some(([n]) => n === 'searchContent')).toBe(false) // debounced
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(calls.find(([n]) => n === 'searchContent')[1]).toMatchObject({ query: 'deep' })
    const line = w.find('.explorer-line-hit')
    expect(line.find('.explorer-hit-loc').text()).toBe('a.js:3')
    expect(line.find('.explorer-hit-text').text()).toBe('const needle = 1')
    await line.trigger('click')
    expect(w.emitted('open')[1]).toEqual([ROOT + '\\a.js', 3])

    // Cleared: the tree again.
    await w.find('[data-test="explorer-search"]').setValue('')
    await flushPromises()
    expect(w.find('[data-test="explorer-results"]').exists()).toBe(false)
    expect(w.findAll('.explorer-row')).toHaveLength(3)
    w.unmount()
  })

  it('Files: the … menu has New file, New folder and Show dotfiles', async () => {
    const w = make('files')
    await flushPromises()
    await w.find('[data-test="explorer-more"]').trigger('click')
    expect(w.find('[data-test="explorer-new-file"]').exists()).toBe(true)
    expect(w.find('[data-test="explorer-new-folder"]').exists()).toBe(true)
    const dot = w.find('[data-test="explorer-dotfiles"]')
    expect(dot.attributes('aria-checked')).toBe('true')
    await dot.trigger('click')
    await flushPromises()
    expect(calls.filter(([n]) => n === 'list').pop()[1].dotfiles).toBe(false)
    w.unmount()
  })

  it("Changes: Orca's groups with letters and a count badge; a file opens its diff; a task copy opens the review", async () => {
    const t = addTask({ title: 'Fix it', wsId: 'ws1' })
    t.worktree = { path: 'C:\\copies\\fix', branch: 'tessel/fix' }
    t.column = 'review'
    const w = make('changes')
    await flushPromises()
    await nextTick()
    // The badge on the tab: every row listed.
    expect(w.find('[data-test="changes-badge"]').text()).toBe('3')
    const rows = w.findAll('[data-test="changes-row"]')
    expect(rows.map((r) => r.find('.explorer-name').text())).toEqual(['a.js', 'gone.txt', 'new.md'])
    expect(rows.map((r) => r.find('.sc-status').text())).toEqual(['M', 'D', 'U'])
    expect(w.findAll('[data-test="changes-count"]').map((c) => c.text())).toEqual(['2', '1'])
    await rows[0].trigger('click')
    await rows[1].trigger('click') // deleted: its diff (an empty right side)
    expect(w.emitted('open-diff').map(([r]) => [r.rel, r.area, r.file])).toEqual([
      ['a.js', 'unstaged', ROOT + '\\a.js'],
      ['gone.txt', 'unstaged', ROOT + '\\gone.txt']
    ])
    // A task's own copy: picked at the top, then Review & merge.
    await w.find('[data-test="changes-target"]').setValue(t.id)
    await flushPromises()
    await w.find('[data-test="review-changes"]').trigger('click')
    expect(w.emitted('review')).toEqual([[t.id]])
    w.unmount()
  })
})
