// The left sidebar rebuilt on Orca's: projects, their workspaces (folder and
// task copies) with branch, status and live ports, the agents and terminals
// in each; menus keep every Tessel function reachable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import WorkspaceSidebar from '../components/WorkspaceSidebar.vue'
import { settings, resetSettings } from '../settings'
import { _resetFeedsForTest } from '../agentChildrenFeed'

const NOW = Date.now()
const pane = (id, extra = {}) => ({ id, num: 1, kind: 'agent', title: id, agentId: 'codex', state: 'ready', ...extra })

function projects() {
  return [
    {
      id: 'ws1',
      name: 'Shop',
      cwd: 'C:\\repo',
      branch: 'main',
      panes: [
        pane('a', { num: 1, title: 'Codex', state: 'working', since: NOW - 120000, pid: 11 }),
        pane('t', { num: 2, kind: 'shell', title: 'pwsh', shellId: 'pwsh', pid: 12 }),
        pane('c', {
          num: 3,
          title: 'Claude',
          agentId: 'claude',
          state: 'approval',
          copyPath: 'C:\\repo.worktrees\\fix-login',
          copyBranch: 'tessel/fix-login',
          focused: true,
          attention: true
        })
      ],
      copies: [{ path: 'C:\\repo.worktrees\\fix-login', branch: 'tessel/fix-login', title: 'Fix the login', taskId: 'T1' }]
    },
    { id: 'ws2', name: 'Docs', cwd: null, branch: '', panes: [pane('d', { title: 'Gemini', agentId: 'gemini' })], copies: [] }
  ]
}

const PORTS = {
  'ws1::': [{ id: '0.0.0.0:5173:4242', port: 5173, pid: 4242, processName: 'node.exe', connectHost: 'localhost', protocol: 'http', kind: 'workspace' }]
}

let mounted = []
function mountSidebar(extra = {}) {
  const w = mount(WorkspaceSidebar, {
    props: { projects: projects(), currentId: 'ws1', ports: PORTS, now: NOW, teams: [], ...extra },
    attachTo: document.body
  })
  mounted.push(w)
  return w
}
const tick = () => new Promise((r) => setTimeout(r, 5))

beforeEach(() => {
  resetSettings()
  settings.sidebarSortBy = 'manual'
  window.shellApi = {}
})
afterEach(() => {
  for (const w of mounted) {
    try {
      w.unmount()
    } catch {
      // already unmounted
    }
  }
  mounted = []
  document.body.innerHTML = ''
  _resetFeedsForTest()
  delete window.shellApi
})

describe('left sidebar', () => {
  it('shows each project, its folder and task copies with branch, and every agent and terminal', () => {
    const w = mountSidebar()
    expect(w.find('.osb-header-title').text()).toBe('Projects')
    expect(w.findAll('.osb-section-label').map((e) => e.text())).toEqual(['Shop', 'Docs'])
    const cards = w.findAll('.wtc-surface')
    expect(cards.map((c) => c.find('.wtc-title').text().replace('Unread:', ''))).toEqual(['repo', 'Fix the login', 'Docs'])
    expect(cards[0].find('.wtc-badge').text()).toBe('primary')
    expect(cards[0].find('.wtc-branch').text()).toBe('main')
    expect(cards[1].find('.wtc-branch').text()).toBe('tessel/fix-login')
    // The copy you are in is the active card; its agent row is filled.
    expect(cards[1].attributes('data-worktree-card-active')).toBe('primary')
    expect(cards[0].attributes('data-worktree-card-active')).toBeUndefined()
    expect(w.find('[data-focused-agent-pane="true"]').attributes('data-pane-id')).toBe('c')
    // Needs you: the question glyph and the unread bell.
    expect(cards[1].find('.wtc-filled-bell').exists()).toBe(true)
    expect(cards[1].find('.wtc-title').classes()).toContain('unread')
    w.unmount()
  })

  it('folds several panes into an "N panes" summary (Orca compact), and opens it', async () => {
    const w = mountSidebar()
    const main = w.findAll('.wtc-surface')[0]
    const summary = main.find('.compact-agent-summary-button')
    expect(summary.attributes('aria-label')).toMatch(/^Expand 2 panes: 1 working, 1 idle\./)
    expect(main.findAll('.compact-agent-row')).toHaveLength(0)
    await summary.trigger('click')
    expect(main.findAll('.compact-agent-row').map((r) => r.attributes('data-pane-id'))).toEqual(['a', 't'])
    expect(main.find('.compact-agent-row .car-trail').text()).toBe('- Working')
    expect(main.find('.car-time').text()).toBe('2m')
    // "Full list" shows every row without a summary.
    settings.agentActivityDisplayMode = 'full'
    await flushPromises()
    expect(w.findAll('.compact-agent-summary-button')).toHaveLength(0)
    w.unmount()
  })

  it('a click on a card goes to its pane; a click on a row goes to that pane', async () => {
    const w = mountSidebar()
    await w.findAll('.wtc-surface')[0].trigger('click')
    expect(w.emitted('focus-pane')[0]).toEqual(['a'])
    await w.find('[data-pane-id="c"]').trigger('click')
    expect(w.emitted('focus-pane')[1]).toEqual(['c'])
    w.unmount()
  })

  it('arrow keys in the list move between workspaces; the plug shows its live ports', async () => {
    const w = mountSidebar()
    await w.find('.osb-list').trigger('keydown', { key: 'ArrowUp' })
    // From the copy you are in, up is the project folder.
    expect(w.emitted('focus-pane')[0]).toEqual(['a'])
    const plug = w.find('.wcp-trigger')
    expect(plug.attributes('aria-label')).toBe('1 live port')
    await plug.trigger('click')
    await tick()
    const card = document.querySelector('.wcp-card')
    expect(card.textContent).toContain('Live Ports (1)')
    expect(card.textContent).toContain('5173')
    expect(card.textContent).toContain('node.exe')
    expect(card.textContent).toContain('localhost:5173')
    card.querySelector('[aria-label="Open in Browser"]').click()
    expect(w.emitted('port-open')[0][0].port).toBe(5173)
    w.unmount()
  })

  it('Workspace options: Hide sleeping, grouping and the filter badge', async () => {
    const w = mountSidebar({
      projects: [
        {
          ...projects()[0],
          copies: [...projects()[0].copies, { path: 'C:\\repo.worktrees\\old', branch: 'tessel/old', title: 'Old', taskId: 'T2' }]
        }
      ]
    })
    expect(w.findAll('.wtc-title').map((e) => e.text())).toContain('Old')
    await w.find('.osb-options-btn').trigger('click')
    const menu = document.querySelector('.orca-menu')
    expect(menu.textContent).toContain('Workspace options')
    expect(menu.textContent).toContain('Group by')
    expect(menu.textContent).toContain('Sort by')
    const hide = [...menu.querySelectorAll('[role="switch"]')].find((b) => b.textContent.includes('Hide sleeping'))
    hide.click()
    await flushPromises()
    expect(settings.showSleepingWorkspaces).toBe(false)
    expect(w.findAll('.wtc-title').map((e) => e.text())).not.toContain('Old')
    expect(w.find('.osb-filter-badge').text()).toBe('1')
    // Group by: None -> one "All" list, titled Workspaces.
    const none = [...document.querySelectorAll('.orca-seg-item')].find((b) => b.textContent.trim() === 'None')
    none.click()
    await flushPromises()
    expect(w.find('.osb-header-title').text()).toBe('Workspaces')
    expect(w.find('.osb-section-label').text()).toBe('All')
    w.unmount()
  })

  it('project actions keep Tessel functions: rename, folder, new task, message, notes, activity, remove', async () => {
    const w = mountSidebar()
    await w.findAll('.osb-header-action')[0].trigger('click')
    const labels = [...document.querySelectorAll('.orca-menu [data-orca-menu-item]')].map((b) => b.textContent.trim())
    expect(labels).toEqual([
      'Rename',
      'Change Project Folder…',
      'New Task…',
      'Message All Agents…',
      'New Team…',
      'Project Notes',
      'Activity',
      'Remove Project'
    ])
    const click = (label) =>
      [...document.querySelectorAll('.orca-menu [data-orca-menu-item]')].find((b) => b.textContent.trim() === label).click()
    click('Remove Project')
    expect(w.emitted('remove')[0]).toEqual(['ws1'])
    await w.findAll('.osb-header-action')[0].trigger('click')
    click('Message All Agents…')
    await flushPromises()
    const box = w.find('.osb-inline-box textarea')
    await box.setValue('Please rebase')
    await box.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('message-ws')[0]).toEqual(['ws1', 'Please rebase'])
    w.unmount()
  })

  it('a workspace card menu: copy path, mark read, delete a task copy; the primary one removes the project', async () => {
    const w = mountSidebar()
    await w.findAll('.wtc-surface')[1].trigger('contextmenu', { clientX: 20, clientY: 30 })
    const items = () => [...document.querySelectorAll('.orca-menu [data-orca-menu-item]')]
    expect(items().map((b) => b.textContent.trim())).toEqual([
      'Open in File Explorer',
      'Copy Path',
      'Copy Worktree Name',
      'Mark Read',
      'Review Changes…',
      'Sleep',
      'Delete'
    ])
    items()
      .find((b) => b.textContent.trim() === 'Delete')
      .click()
    expect(w.emitted('delete-task')[0]).toEqual(['T1'])
    await w.findAll('.wtc-surface')[0].trigger('contextmenu', { clientX: 20, clientY: 30 })
    const del = items().find((b) => b.textContent.trim() === 'Delete Worktree')
    expect(del.disabled).toBe(true)
    items()
      .find((b) => b.textContent.trim() === 'Remove Project from Tessel')
      .click()
    expect(w.emitted('remove')[0]).toEqual(['ws1'])
    w.unmount()
  })

  it('an agent row menu makes a team: tick agents, then group them', async () => {
    const w = mountSidebar({ projects: [{ ...projects()[0], copies: [] }] })
    settings.agentActivityDisplayMode = 'full'
    await flushPromises()
    await w.find('[data-pane-id="a"]').trigger('contextmenu', { clientX: 5, clientY: 5 })
    ;[...document.querySelectorAll('.orca-menu [data-orca-menu-item]')].find((b) => b.textContent.trim() === 'New Team…').click()
    await flushPromises()
    await w.find('[data-pane-id="c"]').trigger('click')
    const group = w.findAll('.osb-btn.primary').find((b) => b.text() === 'Group as a team')
    await group.trigger('click')
    expect(w.emitted('create-team')[0]).toEqual([['a', 'c']])
    w.unmount()
  })

  it("lists a Claude Code session's sub-agents under its row, running first, folded by its chevron", async () => {
    const now = Date.now()
    window.shellApi = {
      agentChildren: async () => [
        { id: 'k1', type: 'Explore', title: 'Scan the repo', state: 'done', startedAt: now - 90000, endedAt: now - 30000, tokens: 1200 },
        { id: 'k2', type: 'general-purpose', title: 'Write tests', state: 'running', startedAt: now - 5000 },
        { id: 'k3', type: 'Explore', title: 'Ancient', state: 'done', startedAt: 1, endedAt: 2 }
      ]
    }
    settings.agentActivityDisplayMode = 'full'
    const w = mountSidebar({
      projects: [{ ...projects()[0], copies: [], panes: [pane('c', { agentId: 'claude', title: 'Claude', sessionId: 'sess-1' })] }]
    })
    await flushPromises()
    const kids = w.findAll('[data-agent-child]')
    expect(kids.map((k) => k.find('.car-lead').text())).toEqual(['Write tests', 'Scan the repo'])
    expect(kids[1].find('.car-time').text()).toContain('↓ 1.2k tokens')
    expect(w.find('.child-more').text()).toBe('1 more')
    await w.find('.compact-agent-child-disclosure-button').trigger('click')
    expect(w.findAll('[data-agent-child]')).toHaveLength(0)
    w.unmount()
  })
})
