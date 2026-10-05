import { setSelectValue } from './selectTestUtils'
// The right side panel (SidePanel.vue): its tab bar switches between Files,
// Changes and Tasks; a tab is created when first shown, then kept.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import SidePanel from '../components/SidePanel.vue'
import ExplorerPanel from '../components/ExplorerPanel.vue'
import { setTasks, addTask } from '../taskBoardStore'
import { setTaskHistory } from '../taskHistory'
import { SIDE_TABS, restoredSideTab } from '../sideTabs'

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
    // No × of its own: the toolbar's right sidebar button hides it.
    expect(w.find('[data-test="side-close"]').exists()).toBe(false)
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

  it('Dashboard is the first tab; a card focuses its pane and leaves fullscreen', async () => {
    const projects = [{ id: 'ws1', name: 'proj', panes: [{ id: 'p1', kind: 'agent', agentId: 'claude', title: 'Claude Code', state: 'working' }] }]
    const w = mount(SidePanel, { props: { tab: 'dashboard', root: ROOT, workspaceId: 'ws1', projects, fullscreen: true }, attachTo: document.body })
    expect(w.findAll('.side-tab')[0].attributes('data-test')).toBe('side-tab-dashboard')
    expect(w.find('[data-test="side-tab-dashboard"]').classes()).toContain('on')
    await w.find('[data-test="adb-card"]').trigger('click')
    expect(w.emitted('update:fullscreen')).toEqual([[false]])
    expect(w.emitted('focus-pane')).toEqual([['p1']])
    w.unmount()
  })

  it('Task history: a tab of its own after Tasks, its rows open their pane (fullscreen left)', async () => {
    setTaskHistory([{ id: 'h1', title: 'Shipped it', wsId: 'ws1', agentName: 'Ada', agentKind: 'claude', project: 'proj', paneId: 'p1', doneAt: Date.now() - 1000, durationMs: 60000, cost: { status: 'ok', inputTokens: 10, outputTokens: 5, usd: 0.02, known: true, final: true, models: [] } }])
    const projects = [{ id: 'ws1', name: 'proj', panes: [{ id: 'p1', kind: 'agent', agentId: 'claude', title: 'Ada', state: 'idle' }] }]
    const w = mount(SidePanel, { props: { tab: 'tasks', root: ROOT, workspaceId: 'ws1', projects, fullscreen: true }, attachTo: document.body })
    const ids = w.findAll('.side-tab').map((x) => x.attributes('data-test'))
    expect(ids.indexOf('side-tab-taskHistory')).toBe(ids.indexOf('side-tab-tasks') + 1)
    expect(w.find('[data-test="side-tab-taskHistory"]').attributes('title')).toBe('Task history — time and cost')
    expect(w.find('[data-test="task-history"]').exists()).toBe(false) // created when first shown
    await w.find('[data-test="side-tab-taskHistory"]').trigger('click')
    expect(w.emitted('update:tab')).toEqual([['taskHistory']])
    await w.setProps({ tab: 'taskHistory' })
    expect(w.find('[data-test="task-history"]').isVisible()).toBe(true)
    await w.find('[data-test="history-row-h1"] button').trigger('click')
    await w.find('[data-test="history-open-pane"]').trigger('click')
    expect(w.emitted('update:fullscreen')).toEqual([[false]])
    expect(w.emitted('focus-pane')).toEqual([['p1']])
    w.unmount()
    setTaskHistory([])
  })

  it('a saved layout opens on its tab again, Task history included', () => {
    expect(SIDE_TABS).toContain('taskHistory')
    expect(restoredSideTab('taskHistory')).toBe('taskHistory')
    expect(restoredSideTab('history')).toBe('history')
    expect(restoredSideTab('web-abc', [{ id: 'web-abc' }])).toBe('web-abc')
    expect(restoredSideTab('web-gone', [])).toBe('dashboard')
    expect(restoredSideTab('nope')).toBe(null)
    expect(restoredSideTab(undefined)).toBe(null)
  })

  it('Fullscreen: the button toggles it, Esc leaves it', async () => {
    const w = make('tasks')
    await w.find('[data-test="side-fullscreen"]').trigger('click')
    expect(w.emitted('update:fullscreen')).toEqual([[true]])
    await w.setProps({ fullscreen: true })
    expect(w.find('[data-test="side-fullscreen"]').attributes('aria-pressed')).toBe('true')
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.emitted('update:fullscreen')).toEqual([[true], [false]])
    w.unmount()
  })

  // A page of the panel has the keyboard (its address bar, the page itself):
  // the window's Esc never reaches the panel, the page asks it to leave.
  it('Fullscreen: a web page of the panel can leave it (its Esc)', async () => {
    let side = null
    const w = mount(SidePanel, {
      props: { tab: 'web-a', root: ROOT, workspaceId: 'ws1', browsers: [{ id: 'web-a', url: 'https://example.com/', title: '' }], fullscreen: false },
      attachTo: document.body,
      global: {
        stubs: {
          SideBrowser: {
            props: ['node', 'active'],
            inject: ['sideFullscreen'],
            created() {
              side = this.sideFullscreen
            },
            template: '<div class="side-browser-stub"></div>'
          }
        }
      }
    })
    expect(side.exit()).toBe(false)
    expect(w.emitted('update:fullscreen')).toBeUndefined()
    await w.setProps({ fullscreen: true })
    expect(side.exit()).toBe(true)
    expect(w.emitted('update:fullscreen')).toEqual([[false]])
    w.unmount()
  })

  // A side panel wired like App's (v-model:tab, v-model:browsers).
  const makeWired = (tab, browsers = []) => {
    const w = mount(SidePanel, {
      props: {
        tab,
        root: ROOT,
        workspaceId: 'ws1',
        browsers,
        'onUpdate:tab': (v) => w.setProps({ tab: v }),
        'onUpdate:browsers': (v) => w.setProps({ browsers: v })
      },
      attachTo: document.body,
      global: { stubs: { SideBrowser: { props: ['node', 'active'], template: '<div class="side-browser-stub" :data-url="node.url"></div>' } } }
    })
    return w
  }

  it('+: a new web page in a tab of its own, shown; × goes back to the tab before', async () => {
    const w = makeWired('tasks')
    expect(w.find('[data-test="side-add"]').attributes('title')).toBe('New browser page')
    await w.find('[data-test="side-add"]').trigger('click')
    await nextTick()
    const pages = w.props('browsers')
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ url: '', title: '' })
    const id = pages[0].id
    expect(w.props('tab')).toBe(id)
    // After the fixed tabs, selected, its page shown.
    const tabs = w.findAll('.side-tab')
    expect(tabs[tabs.length - 1].attributes('data-test')).toBe('side-tab-' + id)
    expect(w.find('[data-test="side-tab-' + id + '"]').classes()).toContain('on')
    expect(w.find('[data-test="side-tab-' + id + '"]').attributes('title')).toBe('New page')
    expect(w.find('.side-browser-stub').isVisible()).toBe(true)
    expect(w.find('[data-test="add-task-form"]').isVisible()).toBe(false)
    // A second page; ×: back to the first one.
    await w.find('[data-test="side-add"]').trigger('click')
    await nextTick()
    expect(w.props('browsers')).toHaveLength(2)
    await w.findAll('[data-test="side-web-close"]')[1].trigger('click')
    await nextTick()
    expect(w.props('browsers').map((b) => b.id)).toEqual([id])
    expect(w.props('tab')).toBe(id)
    // The last one closed: the tab shown before it (Tasks).
    await w.find('[data-test="side-web-close"]').trigger('click')
    await nextTick()
    expect(w.props('browsers')).toEqual([])
    expect(w.props('tab')).toBe('tasks')
    expect(w.find('.side-browser-stub').exists()).toBe(false)
    w.unmount()
  })

  it('a restored page loads only when its tab is first shown; middle-click closes it', async () => {
    const w = makeWired('files', [{ id: 'web-a1', url: 'https://example.com/', title: 'Example' }])
    await flushPromises()
    const tab = w.find('[data-test="side-tab-web-a1"]')
    expect(tab.attributes('title')).toBe('Example')
    expect(w.find('.side-browser-stub').exists()).toBe(false)
    await tab.trigger('click')
    await nextTick()
    expect(w.find('.side-browser-stub').attributes('data-url')).toBe('https://example.com/')
    await w.find('[data-test="side-tab-web-a1"]').trigger('auxclick', { button: 1 })
    await nextTick()
    expect(w.props('browsers')).toEqual([])
    expect(w.props('tab')).toBe('files')
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
    await setSelectValue(w.find('[data-test="changes-target"]'), t.id)
    await flushPromises()
    await w.find('[data-test="review-changes"]').trigger('click')
    expect(w.emitted('review')).toEqual([[t.id]])
    w.unmount()
  })
})
