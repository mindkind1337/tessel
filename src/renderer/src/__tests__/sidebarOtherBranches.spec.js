// A project's git worktrees in the left sidebar: the ones with a task or a
// pane keep their card; all the others stay behind one folded line, "N other
// branches", that unfolds into a compact list.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import WorkspaceSidebar from '../components/WorkspaceSidebar.vue'
import { settings, resetSettings, loadSettings } from '../settings'
import { buildProjectCards, buildSidebarRows, projectOtherBranches, otherBranchesLabel, neighborCard, portProbes } from '../sidebarModel'
import { setUiLanguage } from '../i18n'
import { _resetFeedsForTest } from '../agentChildrenFeed'

const NOW = 1_000_000_000
const pane = (id, extra = {}) => ({ id, num: 1, kind: 'agent', title: id, agentId: 'claude', state: 'ready', ...extra })
const wt = (path, branch, extra = {}) => ({ path, branch, head: 'abcdef1234567890', isMain: false, locked: false, prunable: false, ...extra })

function project(extra = {}) {
  return {
    id: 'ws1',
    name: 'Shop',
    cwd: 'C:\\repo',
    branch: 'main',
    panes: [
      pane('a', { state: 'working' }),
      pane('p', { num: 2, copyPath: 'C:\\repo-panes', copyBranch: 'claude/with-panes' })
    ],
    copies: [{ path: 'C:\\repo.worktrees\\fix-login', branch: '', title: 'Fix the login', taskId: 'T1' }],
    worktrees: [
      wt('C:/repo', 'main', { isMain: true }),
      wt('c:/REPO.worktrees/fix-login/', 'agent/fix-login'),
      wt('C:\\repo-panes', 'claude/with-panes'),
      wt('C:\\repo-zeta', 'zeta'),
      wt('C:\\repo-alpha', 'claude/alpha', { locked: true }),
      wt('C:\\repo-detached', ''),
      wt('C:\\repo-gone', 'gone', { prunable: true }),
      wt('C:\\repo-zeta\\', 'zeta')
    ],
    ...extra
  }
}

describe('other branches: the model', () => {
  it('a task copy keeps its card and its task title (its branch from git); a worktree with panes keeps its card', () => {
    const cards = buildProjectCards(project(), NOW)
    expect(cards.map((c) => c.title)).toEqual(['repo', 'Fix the login', 'claude/with-panes'])
    expect(cards[1]).toMatchObject({ taskId: 'T1', branch: 'agent/fix-login', path: 'C:\\repo.worktrees\\fix-login' })
    expect(cards[2].panes.map((r) => r.id)).toEqual(['p'])
  })

  it('the rest is one list: no card, no project folder, no folder that is gone, no duplicate, sorted by branch', () => {
    const others = projectOtherBranches(project())
    expect(others.map((o) => [o.label, o.folder, o.path])).toEqual([
      ['abcdef1', 'repo-detached', 'C:\\repo-detached'],
      ['claude/alpha', 'repo-alpha', 'C:\\repo-alpha'],
      ['zeta', 'repo-zeta', 'C:\\repo-zeta']
    ])
    expect(others[1].locked).toBe(true)
    expect(others.every((o) => o.projectId === 'ws1')).toBe(true)
    expect(projectOtherBranches(project({ worktrees: undefined }))).toEqual([])
  })

  it('a project opened on a linked worktree lists the main checkout among its other branches', () => {
    const others = projectOtherBranches(project({ cwd: 'C:\\repo-zeta', panes: [], copies: [] }))
    expect(others.map((o) => o.path)).toContain('C:/repo')
    expect(others.map((o) => o.path)).not.toContain('C:\\repo-zeta')
  })

  it('72 worktrees make no card: one folded line under the project, its rows only once unfolded', () => {
    const many = Array.from({ length: 72 }, (_, i) => wt(`C:\\repo-${i}`, `b${String(i).padStart(2, '0')}`))
    const p = project({ panes: [pane('a')], copies: [], worktrees: [wt('C:\\repo', 'main', { isMain: true }), ...many] })
    const folded = buildSidebarRows([p], {}, NOW)
    expect(folded.map((r) => r.type)).toEqual(['header', 'card', 'others'])
    expect(folded[2]).toMatchObject({ key: 'repo:ws1:others', groupKey: 'repo:ws1', count: 72, open: false, items: [] })
    expect(folded[0].count).toBe(1)
    const open = buildSidebarRows([p], { expandedBranches: ['repo:ws1'] }, NOW)
    expect(open[2].open).toBe(true)
    expect(open[2].items).toHaveLength(72)
    expect(open[2].items[0].label).toBe('b00')
    // Cards, arrow keys and the port scan see no more than before.
    expect(buildProjectCards(p, NOW)).toHaveLength(1)
    expect(neighborCard(open, null, 'down').key).toBe('ws1::')
    expect(portProbes([p])).toHaveLength(1)
  })

  it('no line without other worktrees, under a collapsed project, for a filtered-out project or without grouping', () => {
    const p = project()
    const q = { id: 'ws2', name: 'Docs', cwd: 'C:\\docs', branch: 'main', panes: [], copies: [], worktrees: [wt('C:\\docs', 'main', { isMain: true })] }
    const has = (rows) => rows.filter((r) => r.type === 'others').map((r) => r.project.id)
    expect(has(buildSidebarRows([p, q], {}, NOW))).toEqual(['ws1'])
    expect(has(buildSidebarRows([p, q], { collapsedGroups: ['repo:ws1'] }, NOW))).toEqual([])
    expect(has(buildSidebarRows([p, q], { filterRepoIds: ['ws2'] }, NOW))).toEqual([])
    expect(has(buildSidebarRows([p, q], { groupBy: 'none' }, NOW))).toEqual([])
  })

  it('the card filters still hide cards and still say so, with the line kept', () => {
    const p = project({ panes: [] })
    const rows = buildSidebarRows([p], { hideDefaultBranchWorkspace: true, showSleepingWorkspaces: false, alwaysShowDefaultBranchWorkspace: false }, NOW)
    expect(rows.map((r) => r.type)).toEqual(['header', 'hidden', 'others'])
    expect(rows[1].count).toBe(2)
    expect(rows[2].count).toBe(4)
  })

  it('says how many, in English', () => {
    expect(otherBranchesLabel(1)).toBe('1 other branch')
    expect(otherBranchesLabel(72)).toBe('72 other branches')
  })
})

describe('other branches: the sidebar', () => {
  let mounted = []
  function mountSidebar(projects = [project()]) {
    const w = mount(WorkspaceSidebar, { props: { projects, currentId: 'ws1', ports: {}, now: NOW, teams: [] }, attachTo: document.body })
    mounted.push(w)
    return w
  }
  beforeEach(() => {
    resetSettings()
    settings.sidebarSortBy = 'manual'
    window.shellApi = {}
  })
  afterEach(async () => {
    for (const w of mounted) w.unmount()
    mounted = []
    document.body.innerHTML = ''
    _resetFeedsForTest()
    delete window.shellApi
    await setUiLanguage('en')
  })

  it('shows one folded line, not a card per worktree', () => {
    const w = mountSidebar()
    expect(w.findAll('[data-card-key]')).toHaveLength(3)
    const toggle = w.get('[data-test="sidebar-others-toggle"]')
    expect(toggle.text()).toBe('3 other branches')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(w.findAll('[data-test="sidebar-other-branch"]')).toHaveLength(0)
  })

  it('a click unfolds a compact list: branch, short folder name, the path in the tooltip', async () => {
    const w = mountSidebar()
    await w.get('[data-test="sidebar-others-toggle"]').trigger('click')
    expect(settings.sidebarExpandedBranches).toEqual(['repo:ws1'])
    expect(w.get('[data-test="sidebar-others-toggle"]').attributes('aria-expanded')).toBe('true')
    const rows = w.findAll('[data-test="sidebar-other-branch"]')
    expect(rows).toHaveLength(3)
    expect(rows[1].find('.osb-others-branch').text()).toBe('claude/alpha')
    expect(rows[1].find('.osb-others-folder').text()).toBe('repo-alpha')
    expect(rows[1].attributes('title')).toBe('C:\\repo-alpha\nLocked')
    expect(rows[2].attributes('title')).toBe('C:\\repo-zeta')
    // Still no card for them.
    expect(w.findAll('[data-card-key]')).toHaveLength(3)
    await w.get('[data-test="sidebar-others-toggle"]').trigger('click')
    expect(settings.sidebarExpandedBranches).toEqual([])
    expect(w.findAll('[data-test="sidebar-other-branch"]')).toHaveLength(0)
  })

  it('a click on a row opens that folder like a copy card with no pane does', async () => {
    settings.sidebarExpandedBranches = ['repo:ws1']
    const w = mountSidebar()
    await w.findAll('[data-test="sidebar-other-branch"]')[2].trigger('click')
    expect(w.emitted('open-card')).toEqual([[{ wsId: 'ws1', path: 'C:\\repo-zeta', isMain: false }]])
    expect(w.emitted('focus-pane')).toBeUndefined()
  })

  it('the fold is kept per project and with the settings', async () => {
    const other = { ...project(), id: 'ws2', name: 'Docs', cwd: 'C:\\docs', panes: [], copies: [], worktrees: [wt('C:\\docs-x', 'x')] }
    settings.sidebarExpandedBranches = ['repo:ws2']
    const w = mountSidebar([project(), other])
    const toggles = w.findAll('[data-test="sidebar-others-toggle"]')
    expect(toggles.map((b) => b.attributes('aria-expanded'))).toEqual(['false', 'true'])
    expect(toggles[1].text()).toBe('1 other branch')
    loadSettings({ sidebarExpandedBranches: ['repo:ws1', 7] })
    expect(settings.sidebarExpandedBranches).toEqual(['repo:ws1'])
    resetSettings()
    expect(settings.sidebarExpandedBranches).toEqual([])
  })

  it('the filters and Clear filters still work with the line there', async () => {
    settings.hideDefaultBranchWorkspace = true
    settings.showSleepingWorkspaces = false
    settings.alwaysShowDefaultBranchWorkspace = false
    const w = mountSidebar([project({ panes: [] })])
    expect(w.findAll('[data-card-key]')).toHaveLength(0)
    expect(w.find('[data-test="sidebar-hidden-row"]').exists()).toBe(true)
    expect(w.find('[data-test="sidebar-others-toggle"]').exists()).toBe(true)
    await w.get('[data-test="sidebar-clear-filters"]').trigger('click')
    await nextTick()
    expect(w.findAll('[data-card-key]')).toHaveLength(2)
    expect(w.find('[data-test="sidebar-hidden-row"]').exists()).toBe(false)
    expect(w.get('[data-test="sidebar-others-toggle"]').text()).toBe('4 other branches')
  })

  it('in French', async () => {
    await setUiLanguage('fr')
    const w = mountSidebar()
    expect(w.get('[data-test="sidebar-others-toggle"]').text()).toBe('3 autres branches')
    expect(otherBranchesLabel(1)).toBe('1 autre branche')
  })
})
