// A project's git worktrees in the left sidebar: the ones with a task or a
// pane keep their card; Tessel did not make the others, so they stay hidden
// behind one folded line, "Hiding N discovered worktrees", that unfolds into a
// preview by folder with a Show per worktree; Don't show again closes the line
// for good and the project menu's Hidden worktrees dialog still lists them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import WorkspaceSidebar from '../components/WorkspaceSidebar.vue'
import { settings, resetSettings, loadSettings } from '../settings'
import {
  buildProjectCards,
  buildSidebarRows,
  projectOtherBranches,
  projectWorktreeVisibility,
  hiddenWorktreesLabel,
  hiddenWorktreesPreview,
  worktreeParentPath,
  neighborCard,
  portProbes
} from '../sidebarModel'
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

describe('hidden worktrees: the model', () => {
  it('a task copy keeps its card and its task title (its branch from git); a worktree with panes keeps its card', () => {
    const cards = buildProjectCards(project(), NOW)
    expect(cards.map((c) => c.title)).toEqual(['repo', 'Fix the login', 'claude/with-panes'])
    expect(cards[1]).toMatchObject({ taskId: 'T1', branch: 'agent/fix-login', path: 'C:\\repo.worktrees\\fix-login' })
    expect(cards[2].panes.map((r) => r.id)).toEqual(['p'])
  })

  it('the other worktrees: no card, no project folder, no folder that is gone, no duplicate, sorted by branch', () => {
    const others = projectOtherBranches(project())
    expect(others.map((o) => [o.label, o.folder, o.path, o.detached])).toEqual([
      ['abcdef1', 'repo-detached', 'C:\\repo-detached', true],
      ['claude/alpha', 'repo-alpha', 'C:\\repo-alpha', false],
      ['zeta', 'repo-zeta', 'C:\\repo-zeta', false]
    ])
    expect(others[1].locked).toBe(true)
    expect(others.every((o) => o.projectId === 'ws1')).toBe(true)
    expect(projectOtherBranches(project({ worktrees: undefined }))).toEqual([])
  })

  it('a project opened on a linked worktree counts the main checkout among them', () => {
    const others = projectOtherBranches(project({ cwd: 'C:\\repo-zeta', panes: [], copies: [] }))
    expect(others.map((o) => o.path)).toContain('C:/repo')
    expect(others.map((o) => o.path)).not.toContain('C:\\repo-zeta')
  })

  it('all hidden by default; a detached one is hidden but left out of the line; Show matches the path loosely', () => {
    const v = projectWorktreeVisibility(project())
    expect(v.shown).toEqual([])
    expect(v.hidden.map((o) => o.label)).toEqual(['abcdef1', 'claude/alpha', 'zeta'])
    expect(v.inbox.map((o) => o.label)).toEqual(['claude/alpha', 'zeta'])
    const s = projectWorktreeVisibility(project(), ['c:/REPO-zeta/'])
    expect(s.shown.map((o) => o.label)).toEqual(['zeta'])
    expect(s.inbox.map((o) => o.label)).toEqual(['claude/alpha'])
    expect(projectWorktreeVisibility(project(), 'junk').shown).toEqual([])
  })

  it('72 worktrees make no card: one folded line under the project, its preview only once unfolded', () => {
    const many = Array.from({ length: 72 }, (_, i) => wt(`C:\\wt\\repo-${i}`, `b${String(i).padStart(2, '0')}`))
    const p = project({ panes: [pane('a')], copies: [], worktrees: [wt('C:\\repo', 'main', { isMain: true }), ...many] })
    const folded = buildSidebarRows([p], {}, NOW)
    expect(folded.map((r) => r.type)).toEqual(['header', 'card', 'others'])
    expect(folded[2]).toMatchObject({ key: 'repo:ws1:others', groupKey: 'repo:ws1', count: 72, open: false, groups: [], moreGroups: 0 })
    expect(folded[0].count).toBe(1)
    expect(folded[0].hiddenWorktrees).toHaveLength(72)
    const open = buildSidebarRows([p], { expandedBranches: ['repo:ws1'] }, NOW)
    expect(open[2].open).toBe(true)
    expect(open[2].groups).toHaveLength(1)
    expect(open[2].groups[0]).toMatchObject({ path: 'C:\\wt', count: 72, more: 69, full: false })
    expect(open[2].groups[0].items.map((i) => i.label)).toEqual(['b00', 'b01', 'b02'])
    const full = buildSidebarRows([p], { expandedBranches: ['repo:ws1'], openWorktreeGroups: { 'repo:ws1': ['c:/wt'] } }, NOW)
    expect(full[2].groups[0].items).toHaveLength(72)
    expect(full[2].groups[0].full).toBe(true)
    // Cards, arrow keys and the port scan see no more than before.
    expect(buildProjectCards(p, NOW)).toHaveLength(1)
    expect(neighborCard(open, null, 'down').key).toBe('ws1::')
    expect(portProbes([p])).toHaveLength(1)
  })

  it('the preview groups by parent folder: 5 folders at most, 3 each, then how many more', () => {
    const items = []
    for (let f = 0; f < 7; f++) for (let i = 0; i < 4; i++) items.push({ key: `${f}-${i}`, path: `/srv/f${f}/w${i}`, label: `w${i}` })
    const { groups, moreGroups } = hiddenWorktreesPreview(items)
    expect(groups.map((g) => g.path)).toEqual(['/srv/f0', '/srv/f1', '/srv/f2', '/srv/f3', '/srv/f4'])
    expect(groups.every((g) => g.items.length === 3 && g.more === 1)).toBe(true)
    expect(moreGroups).toBe(2)
    expect(worktreeParentPath('C:\\a\\b\\')).toBe('C:\\a')
    expect(worktreeParentPath('C:\\b')).toBe('C:\\')
    expect(worktreeParentPath('/b')).toBe('/')
    expect(worktreeParentPath('ssh://host/srv/app')).toBe('ssh://host/srv')
    expect(worktreeParentPath('x')).toBe('?')
  })

  it('a shown worktree is a row after the cards; Don\'t show again drops the line but not the list', () => {
    const p = project()
    const rows = buildSidebarRows([p], { shownWorktrees: { 'repo:ws1': ['C:\\repo-zeta'] } }, NOW)
    expect(rows.map((r) => r.type)).toEqual(['header', 'card', 'card', 'card', 'branch', 'others'])
    expect(rows[4]).toMatchObject({ key: 'repo:ws1:wt:C:\\repo-zeta', item: { label: 'zeta' } })
    expect(rows[5].count).toBe(1)
    const gone = buildSidebarRows([p], { dismissedWorktreeLines: ['repo:ws1'] }, NOW)
    expect(gone.map((r) => r.type)).toEqual(['header', 'card', 'card', 'card'])
    expect(gone[0].hiddenWorktrees).toHaveLength(3)
  })

  it('no line without other worktrees, under a collapsed project, for a filtered-out project or without grouping', () => {
    const p = project()
    const q = { id: 'ws2', name: 'Docs', cwd: 'C:\\docs', branch: 'main', panes: [], copies: [], worktrees: [wt('C:\\docs', 'main', { isMain: true })] }
    const r = project({ id: 'ws3', worktrees: [wt('C:\\repo', 'main', { isMain: true }), wt('C:\\repo-d', '')] })
    const has = (rows) => rows.filter((x) => x.type === 'others').map((x) => x.project.id)
    expect(has(buildSidebarRows([p, q, r], {}, NOW))).toEqual(['ws1'])
    expect(has(buildSidebarRows([p, q], { collapsedGroups: ['repo:ws1'] }, NOW))).toEqual([])
    expect(has(buildSidebarRows([p, q], { filterRepoIds: ['ws2'] }, NOW))).toEqual([])
    expect(has(buildSidebarRows([p, q], { groupBy: 'none' }, NOW))).toEqual([])
  })

  it('the card filters still hide cards and still say so, with the line kept', () => {
    const p = project({ panes: [] })
    const rows = buildSidebarRows([p], { hideDefaultBranchWorkspace: true, showSleepingWorkspaces: false, alwaysShowDefaultBranchWorkspace: false }, NOW)
    expect(rows.map((r) => r.type)).toEqual(['header', 'hidden', 'others'])
    expect(rows[1].count).toBe(2)
    expect(rows[2].count).toBe(3)
  })

  it('says how many, in English', () => {
    expect(hiddenWorktreesLabel(1)).toBe('Hiding 1 discovered worktree')
    expect(hiddenWorktreesLabel(72)).toBe('Hiding 72 discovered worktrees')
  })
})

describe('hidden worktrees: the sidebar', () => {
  let mounted = []
  function mountSidebar(projects = [project()]) {
    const w = mount(WorkspaceSidebar, { props: { projects, currentId: 'ws1', ports: {}, now: NOW, teams: [] }, attachTo: document.body })
    mounted.push(w)
    return w
  }
  const dialog = () => document.querySelector('[data-test="hidden-worktrees-dialog"]')
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

  it('shows one folded line, not a card or a row per worktree', () => {
    const w = mountSidebar()
    expect(w.findAll('[data-card-key]')).toHaveLength(3)
    const toggle = w.get('[data-test="sidebar-others-toggle"]')
    expect(toggle.text()).toBe('Hiding 2 discovered worktrees')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(w.findAll('[data-test="sidebar-hidden-worktree"]')).toHaveLength(0)
    expect(w.findAll('[data-test="sidebar-other-branch"]')).toHaveLength(0)
    expect(w.get('[data-test="sidebar-others-dismiss"]').attributes('title')).toBe("Don't show again")
  })

  it('a click unfolds a preview by folder: branch, short folder name, the path in the tooltip', async () => {
    const w = mountSidebar()
    await w.get('[data-test="sidebar-others-toggle"]').trigger('click')
    expect(settings.sidebarExpandedBranches).toEqual(['repo:ws1'])
    expect(w.get('[data-test="sidebar-others-toggle"]').attributes('aria-expanded')).toBe('true')
    const groups = w.findAll('[data-test="sidebar-worktree-group"]')
    expect(groups).toHaveLength(1)
    expect(groups[0].get('.osb-wt-group-path').text()).toBe('C:\\')
    expect(groups[0].get('.osb-wt-count').text()).toBe('2')
    const rows = w.findAll('[data-test="sidebar-hidden-worktree"]')
    expect(rows.map((r) => r.get('.osb-others-branch').text())).toEqual(['claude/alpha', 'zeta'])
    expect(rows[0].get('.osb-others-folder').text()).toBe('repo-alpha')
    expect(rows[0].get('.osb-others-branch').attributes('title')).toBe('C:\\repo-alpha\nLocked')
    expect(w.findAll('[data-card-key]')).toHaveLength(3)
    await w.get('[data-test="sidebar-others-toggle"]').trigger('click')
    expect(settings.sidebarExpandedBranches).toEqual([])
    expect(w.findAll('[data-test="sidebar-hidden-worktree"]')).toHaveLength(0)
  })

  it('a folder with more than 3 shows "Show N more", then "Show fewer"', async () => {
    const many = Array.from({ length: 5 }, (_, i) => wt(`C:\\wt\\r${i}`, `b${i}`))
    settings.sidebarExpandedBranches = ['repo:ws1']
    const w = mountSidebar([project({ worktrees: [wt('C:\\repo', 'main', { isMain: true }), ...many] })])
    expect(w.findAll('[data-test="sidebar-hidden-worktree"]')).toHaveLength(3)
    const more = w.get('[data-test="sidebar-worktree-group-more"]')
    expect(more.text()).toBe('Show 2 more')
    await more.trigger('click')
    expect(w.findAll('[data-test="sidebar-hidden-worktree"]')).toHaveLength(5)
    expect(w.get('[data-test="sidebar-worktree-group-more"]').text()).toBe('Show fewer')
  })

  it('Show makes it a row that opens its folder like before; Hide puts it back', async () => {
    settings.sidebarExpandedBranches = ['repo:ws1']
    const w = mountSidebar()
    await w.findAll('[data-test="sidebar-show-worktree"]')[1].trigger('click')
    expect(settings.sidebarShownWorktrees).toEqual({ 'repo:ws1': ['C:\\repo-zeta'] })
    const row = w.get('[data-test="sidebar-other-branch"]')
    expect(row.text()).toContain('zeta')
    expect(w.get('[data-test="sidebar-others-toggle"]').text()).toBe('Hiding 1 discovered worktree')
    await row.trigger('click')
    expect(w.emitted('open-card')).toEqual([[{ wsId: 'ws1', path: 'C:\\repo-zeta', isMain: false }]])
    expect(w.emitted('focus-pane')).toBeUndefined()
    await w.get('[data-test="sidebar-hide-worktree"]').trigger('click')
    expect(settings.sidebarShownWorktrees).toEqual({})
    expect(w.findAll('[data-test="sidebar-other-branch"]')).toHaveLength(0)
  })

  it("Don't show again closes the line for good; the project menu's dialog lists them, detached included, and shows one", async () => {
    const w = mountSidebar()
    await w.get('[data-test="sidebar-others-dismiss"]').trigger('click')
    expect(settings.sidebarDismissedWorktreeLines).toEqual(['repo:ws1'])
    expect(w.find('[data-test="sidebar-others"]').exists()).toBe(false)
    await w.findAll('.osb-header-action')[0].trigger('click')
    const item = [...document.querySelectorAll('.orca-menu [data-orca-menu-item]')].find((b) => b.textContent.trim() === 'Hidden Worktrees (3)…')
    expect(item).toBeTruthy()
    item.click()
    await flushPromises()
    expect(dialog().querySelector('[data-test="hidden-worktrees-title"]').textContent.trim()).toBe('Hidden worktrees (3)')
    const names = () => [...dialog().querySelectorAll('[data-test="hidden-worktrees-row"] .hwt-name')].map((e) => e.textContent.trim())
    expect(names()).toEqual(['abcdef1', 'claude/alpha', 'zeta'])
    const search = dialog().querySelector('[data-test="hidden-worktrees-search"]')
    search.value = 'ALPHA'
    search.dispatchEvent(new Event('input'))
    await nextTick()
    expect(names()).toEqual(['claude/alpha'])
    search.value = 'nothing'
    search.dispatchEvent(new Event('input'))
    await nextTick()
    expect(dialog().querySelector('[data-test="hidden-worktrees-empty"]').textContent).toContain('No matching worktrees')
    search.value = 'detached'
    search.dispatchEvent(new Event('input'))
    await nextTick()
    dialog().querySelector('[data-test="hidden-worktrees-show"]').click()
    await nextTick()
    expect(settings.sidebarShownWorktrees).toEqual({ 'repo:ws1': ['C:\\repo-detached'] })
    expect(w.get('[data-test="sidebar-other-branch"]').text()).toContain('abcdef1')
    expect(dialog().querySelector('[data-test="hidden-worktrees-title"]').textContent.trim()).toBe('Hidden worktrees (2)')
    dialog().querySelector('.hwt-card').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(dialog()).toBeNull()
  })

  it('no Hidden Worktrees item for a project without other worktrees', async () => {
    const w = mountSidebar([project({ worktrees: [] })])
    await w.findAll('.osb-header-action')[0].trigger('click')
    const labels = [...document.querySelectorAll('.orca-menu [data-orca-menu-item]')].map((b) => b.textContent.trim())
    expect(labels.some((l) => l.startsWith('Hidden Worktrees'))).toBe(false)
  })

  it('the choices are kept per project and with the settings', async () => {
    const other = { ...project(), id: 'ws2', name: 'Docs', cwd: 'C:\\docs', panes: [], copies: [], worktrees: [wt('C:\\docs-x', 'x')] }
    settings.sidebarExpandedBranches = ['repo:ws2']
    const w = mountSidebar([project(), other])
    const toggles = w.findAll('[data-test="sidebar-others-toggle"]')
    expect(toggles.map((b) => b.attributes('aria-expanded'))).toEqual(['false', 'true'])
    expect(toggles[1].text()).toBe('Hiding 1 discovered worktree')
    loadSettings({
      sidebarExpandedBranches: ['repo:ws1', 7],
      sidebarShownWorktrees: { 'repo:ws1': ['C:\\repo-zeta', 3, ''], 'repo:ws2': 'x', 'repo:ws3': [] },
      sidebarDismissedWorktreeLines: ['repo:ws2', null]
    })
    expect(settings.sidebarExpandedBranches).toEqual(['repo:ws1'])
    expect(settings.sidebarShownWorktrees).toEqual({ 'repo:ws1': ['C:\\repo-zeta'] })
    expect(settings.sidebarDismissedWorktreeLines).toEqual(['repo:ws2'])
    loadSettings({ sidebarShownWorktrees: [1] })
    expect(settings.sidebarShownWorktrees).toEqual({})
    resetSettings()
    expect(settings.sidebarExpandedBranches).toEqual([])
    expect(settings.sidebarShownWorktrees).toEqual({})
    expect(settings.sidebarDismissedWorktreeLines).toEqual([])
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
    expect(w.get('[data-test="sidebar-others-toggle"]').text()).toBe('Hiding 3 discovered worktrees')
  })

  it('in French', async () => {
    await setUiLanguage('fr')
    settings.sidebarExpandedBranches = ['repo:ws1']
    const w = mountSidebar()
    expect(w.get('[data-test="sidebar-others-toggle"]').text()).toBe('2 copies cachées')
    expect(w.get('[data-test="sidebar-others-dismiss"]').attributes('title')).toBe('Ne plus afficher')
    expect(w.get('[data-test="sidebar-show-worktree"]').text()).toBe('Afficher')
    expect(hiddenWorktreesLabel(1)).toBe('1 copie cachée')
    await w.findAll('.osb-header-action')[0].trigger('click')
    const labels = [...document.querySelectorAll('.orca-menu [data-orca-menu-item]')].map((b) => b.textContent.trim())
    expect(labels).toContain('Copies cachées (3)…')
  })
})
