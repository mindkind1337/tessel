// A project on an SSH host in the left sidebar: its branch, the "primary"
// badge, a chip with its host, and its other git worktrees on the host
// (hidden behind one line, shown on request), like a local project; a host
// not connected keeps what was shown.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkspaceSidebar from '../components/WorkspaceSidebar.vue'
import { settings, resetSettings } from '../settings'
import { buildProjectCards, projectOtherBranches } from '../sidebarModel'
import { createProjectWorktrees } from '../projectWorktrees'
import { setUiLanguage } from '../i18n'
import { _resetFeedsForTest } from '../agentChildrenFeed'

const NOW = 1_000_000_000
const ROOT = 'ssh://ssh-box1/srv/app'
const wt = (path, branch, extra = {}) => ({ path, branch, head: 'abcdef1234567890', isMain: false, locked: false, prunable: false, ...extra })

function remoteProject(extra = {}) {
  return {
    id: 'ws1',
    name: 'app',
    cwd: null,
    branch: 'main',
    panes: [{ id: 'a', num: 1, kind: 'agent', title: 'a', agentId: 'claude', state: 'ready' }],
    copies: [],
    worktrees: [
      wt('ssh://ssh-box1/srv/app', 'main', { isMain: true, self: true }),
      wt('ssh://ssh-box1/srv/app-feature', 'feature/login'),
      wt('ssh://ssh-box1/srv/app-detached', '')
    ],
    remote: { host: 'fivem-afterlife', path: '/srv/app' },
    ...extra
  }
}

describe('a remote project: the model', () => {
  it('its card carries the branch and the host', () => {
    const [card] = buildProjectCards(remoteProject(), NOW)
    expect(card).toMatchObject({ isMain: true, branch: 'main', host: 'fivem-afterlife' })
    const [local] = buildProjectCards({ ...remoteProject(), cwd: 'C:\\app', remote: undefined }, NOW)
    expect(local.host).toBeUndefined()
  })

  it('its other branches leave out its own checkout (self), keep the rest', () => {
    const others = projectOtherBranches(remoteProject())
    expect(others.map((o) => [o.label, o.folder])).toEqual([
      ['abcdef1', 'app-detached'],
      ['feature/login', 'app-feature']
    ])
  })
})

describe('a remote project: the sidebar', () => {
  let mounted = []
  function mountSidebar(projects = [remoteProject()]) {
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

  it('shows the branch, the primary badge, the host chip and the hidden worktrees line', () => {
    const w = mountSidebar()
    const card = w.get('[data-card-key="ws1::"]')
    expect(card.get('.wtc-branch').text()).toBe('main')
    expect(card.get('.wtc-badge').text()).toBe('primary')
    expect(card.get('[data-test="card-remote-host"]').text()).toContain('fivem-afterlife')
    expect(w.get('[data-test="sidebar-others-toggle"]').text()).toBe('Hiding 1 discovered worktree')
  })

  it('no branch yet (host never connected): the host chip alone, no badge, no line', () => {
    const w = mountSidebar([remoteProject({ branch: '', worktrees: [] })])
    const card = w.get('[data-card-key="ws1::"]')
    expect(card.find('.wtc-branch').exists()).toBe(false)
    expect(card.find('.wtc-badge').exists()).toBe(false)
    expect(card.get('[data-test="card-remote-host"]').text()).toContain('fivem-afterlife')
    expect(w.find('[data-test="sidebar-others-toggle"]').exists()).toBe(false)
  })

  it('its line unfolds to the host folder; one you chose to show opens that folder on the host', async () => {
    settings.sidebarExpandedBranches = ['repo:ws1']
    const w = mountSidebar()
    expect(w.get('.osb-wt-group-path').text()).toBe('ssh://ssh-box1/srv')
    await w.get('[data-test="sidebar-show-worktree"]').trigger('click')
    expect(settings.sidebarShownWorktrees).toEqual({ 'repo:ws1': ['ssh://ssh-box1/srv/app-feature'] })
    await w.get('[data-test="sidebar-other-branch"]').trigger('click')
    expect(w.emitted('open-card')).toEqual([[{ wsId: 'ws1', path: 'ssh://ssh-box1/srv/app-feature', isMain: false }]])
  })

  it('in French', async () => {
    await setUiLanguage('fr')
    const w = mountSidebar()
    const card = w.get('[data-card-key="ws1::"]')
    expect(card.get('.wtc-badge').text()).toBe('principal')
    expect(card.get('[data-test="card-remote-host"]').text()).toContain('Hôte SSH')
    expect(w.get('[data-test="sidebar-others-toggle"]').text()).toBe('1 copie cachée')
  })
})

describe('a remote project: refreshing', () => {
  it('a host not connected (offline) or a failed read keeps what was shown, quietly', async () => {
    const store = {}
    let answer = { ok: true, repo: true, branch: 'main', worktrees: [wt(ROOT, 'main', { isMain: true, self: true })] }
    const pw = createProjectWorktrees({ list: async () => answer, store, visible: () => true })
    await pw.refresh([ROOT])
    expect(store[ROOT]).toHaveLength(1)
    answer = { ok: false, error: 'offline' }
    await pw.refresh([ROOT])
    expect(store[ROOT]).toHaveLength(1)
    answer = { ok: false, error: 'failed' }
    await pw.refresh([ROOT])
    expect(store[ROOT]).toHaveLength(1)
    answer = { ok: true, repo: false, branch: '', worktrees: [] }
    await pw.refresh([ROOT])
    expect(store[ROOT]).toEqual([])
  })
})
