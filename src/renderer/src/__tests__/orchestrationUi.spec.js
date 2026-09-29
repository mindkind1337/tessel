// Orchestration in the interface: worker rows in Sessions (linked to their
// coordinator), the Tasks panel's orchestration card, Settings > Orchestration.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import WorkspaceSidebar from '../components/WorkspaceSidebar.vue'
import OrchestrationCard from '../components/OrchestrationCard.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { settings, resetSettings, loadSettings, DEFAULT_SETTINGS } from '../settings'
import { _resetFeedsForTest } from '../agentChildrenFeed'

const NOW = Date.now()
const pane = (id, extra = {}) => ({ id, num: 1, kind: 'agent', title: id, agentId: 'codex', state: 'ready', team: 'tm1', ...extra })

let mounted = []
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
  resetSettings()
})

describe('Sessions: worker rows', () => {
  function mountSidebar() {
    const w = mount(WorkspaceSidebar, {
      props: {
        projects: [
          {
            id: 'ws1',
            name: 'Shop',
            cwd: 'C:\\repo',
            branch: 'main',
            // The worker alone on the card (several agents fold into a summary).
            panes: [pane('wk', { num: 5, title: 'Codex', workerOf: { id: 'lead', label: '#1 Claude', num: 1, status: 'running' } })],
            copies: []
          }
        ],
        currentId: 'ws1',
        ports: {},
        now: NOW,
        teams: [{ id: 'tm1', name: 'Team 1' }]
      },
      attachTo: document.body
    })
    mounted.push(w)
    return w
  }

  it('a worker is marked as the worker of its coordinator; the mark goes to the coordinator', async () => {
    const w = mountSidebar()
    const row = w.find('.compact-agent-row[data-pane-id="wk"]')
    const tag = row.find('[data-worker-of]')
    expect(tag.text()).toBe('worker of #1')
    expect(row.attributes('aria-label')).toContain('Worker of #1 Claude: go to it')
    await tag.trigger('click')
    expect(w.emitted('focus-pane').at(-1)).toEqual(['lead'])
    // The row itself still goes to the worker.
    await row.trigger('click')
    expect(w.emitted('focus-pane').at(-1)).toEqual(['wk'])
  })

  it("the row's hover card says whose worker it is", async () => {
    vi.useFakeTimers()
    try {
      const w = mountSidebar()
      await w.find('.compact-agent-row[data-pane-id="wk"]').trigger('pointerover')
      vi.advanceTimersByTime(300)
      await nextTick()
      await nextTick()
      const card = document.querySelector('.agent-hover-card [data-hover-worker]')
      expect(card && card.textContent).toBe('Worker of #1 Claude')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Tasks panel: the orchestration card', () => {
  function mountCard(view, actions = {}) {
    const calls = []
    const orch = {
      view: ref(view),
      allow: (team, id) => calls.push(['allow', team, id]),
      refuse: (team, id) => calls.push(['refuse', team, id]),
      stop: (team, id) => calls.push(['stop', team, id]),
      focus: (id) => calls.push(['focus', id]),
      ...actions
    }
    const w = mount(OrchestrationCard, { props: { workspaceId: 'ws1' }, global: { provide: { orchestration: orch } } })
    mounted.push(w)
    return { w, calls }
  }
  const team = (workers) => ({
    teamId: 'tm1',
    wsId: 'ws1',
    name: 'Team 1',
    color: '#6c9cff',
    limits: { maxConcurrent: 4, maxDepth: 1, confirm: true },
    coordinators: [{ id: 'lead', label: '#1 Claude', phase: 'dispatching' }],
    workers,
    running: workers.filter((x) => ['running', 'starting'].includes(x.status)).length,
    waiting: workers.filter((x) => ['confirming', 'queued'].includes(x.status)).length
  })
  const worker = (id, status, extra = {}) => ({ id, title: `Task ${id}`, agent: 'codex', status, isolation: 'worktree', paneId: null, label: null, by: 'lead', taskId: `task-${id}`, ...extra })

  it('shows the phase, the counts and each worker; the user allows, refuses, cancels, stops', async () => {
    const { w, calls } = mountCard([
      team([
        worker('a', 'confirming'),
        worker('b', 'queued'),
        worker('c', 'running', { paneId: 'p5', label: '#5 Codex', branch: 'agent/c', heartbeatAt: Date.now() - 3 * 60000, phase: 'implementing' }),
        worker('d', 'done')
      ])
    ])
    expect(w.text()).toContain('Team 1')
    expect(w.text()).toContain('1 running · 2 waiting · up to 4 at a time per coordinator')
    expect(w.find('.orch-phase').text()).toBe('Starting workers')
    const rows = w.findAll('[data-test="orch-worker"]')
    expect(rows.map((r) => r.attributes('data-status'))).toEqual(['confirming', 'queued', 'running', 'done'])
    expect(rows[2].text()).toContain('own copy, agent/c')
    expect(rows[2].text()).toContain('heartbeat 3 min ago (implementing)')
    await w.find('[data-test="orch-allow"]').trigger('click')
    await w.find('[data-test="orch-refuse"]').trigger('click')
    await w.find('[data-test="orch-cancel"]').trigger('click')
    await w.find('[data-test="orch-stop"]').trigger('click')
    await rows[2].find('.orch-link').trigger('click')
    expect(calls).toEqual([
      ['allow', 'tm1', 'a'],
      ['refuse', 'tm1', 'a'],
      ['stop', 'tm1', 'b'],
      ['stop', 'tm1', 'c'],
      ['focus', 'p5']
    ])
  })

  it('nothing when no team of this workspace has workers', () => {
    const { w } = mountCard([{ ...team([worker('a', 'running')]), wsId: 'ws2' }])
    expect(w.find('[data-test="orch-card"]').exists()).toBe(false)
  })
})

describe('Settings > Orchestration: workers', () => {
  it('cautious defaults: ask first, 4 at a time, depth 1; saved values checked', () => {
    expect(DEFAULT_SETTINGS.orchestrationConfirmWorkers).toBe(true)
    expect(DEFAULT_SETTINGS.orchestrationMaxWorkers).toBe(4)
    expect(DEFAULT_SETTINGS.orchestrationMaxDepth).toBe(1)
    loadSettings({ orchestrationConfirmWorkers: false, orchestrationMaxWorkers: 6, orchestrationMaxDepth: 2 })
    expect([settings.orchestrationConfirmWorkers, settings.orchestrationMaxWorkers, settings.orchestrationMaxDepth]).toEqual([false, 6, 2])
    resetSettings()
    loadSettings({ orchestrationConfirmWorkers: 'no', orchestrationMaxWorkers: 500, orchestrationMaxDepth: 0 })
    expect([settings.orchestrationConfirmWorkers, settings.orchestrationMaxWorkers, settings.orchestrationMaxDepth]).toEqual([true, 4, 1])
  })

  it('the setup card and the three settings', async () => {
    const w = mount(SettingsDialog, { attachTo: document.body })
    mounted.push(w)
    const group = w.find('[data-orch-workers]')
    expect(group.exists()).toBe(true)
    expect(group.find('[data-orch-setup]').findAll('li')).toHaveLength(3)
    const confirm = group.find('[data-setting="orchestrationConfirmWorkers"]')
    expect(confirm.element.checked).toBe(true)
    await confirm.setValue(false)
    expect(settings.orchestrationConfirmWorkers).toBe(false)
    const max = group.find('[data-setting="orchestrationMaxWorkers"]')
    max.element.value = '99'
    await max.trigger('change')
    expect(settings.orchestrationMaxWorkers).toBe(8)
    const depth = group.find('[data-setting="orchestrationMaxDepth"]')
    depth.element.value = '2'
    await depth.trigger('change')
    expect(settings.orchestrationMaxDepth).toBe(2)
    expect(group.text()).toContain('Per coordinator (1 to 8)')
  })
})
