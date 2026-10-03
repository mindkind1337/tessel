// The Dashboard tab of the right side panel (AgentDashboard.vue,
// agentDashboard.js): every agent of every project, counted by state,
// filtered, searched, grouped by state or by project; a card focuses its
// pane; "Sleep idle" asks first, then sleeps the idle terminal agents.
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import AgentDashboard from '../components/AgentDashboard.vue'
import { buildDashboard, dashboardBucket, dashboardView } from '../agentDashboard'
import { setUiLanguage } from '../i18n'

const NOW = 1_000_000_000
const pane = (id, extra = {}) => ({
  id,
  kind: 'agent',
  agentId: 'claude',
  agentLabel: 'Claude Code',
  title: 'Claude Code ' + id,
  state: 'ready',
  sleeping: false,
  since: 0,
  ...extra
})
const projects = () => [
  {
    id: 'w1',
    name: 'tessel',
    panes: [
      pane('1', { state: 'working', since: NOW - 4 * 60000, task: 'Build the dashboard' }),
      pane('2', { state: 'waiting', since: NOW - 10 * 60000 }),
      pane('3', { state: 'approval', since: NOW - 60000 }),
      { id: 's', kind: 'shell', title: 'PowerShell', state: 'ready' }
    ]
  },
  {
    id: 'w2',
    name: 'site',
    panes: [
      pane('4'),
      pane('5', { focused: true }),
      pane('6', { sleeping: true }),
      pane('c', { kind: 'chat', agentId: 'claude', title: 'Claude chat', state: 'ready' })
    ]
  }
]

beforeEach(() => {
  Object.assign(dashboardView, { groupBy: 'status', filter: 'all', query: '' })
})

describe('agentDashboard.js', () => {
  it('buckets: asks you, working, done, idle, sleeping', () => {
    expect(dashboardBucket({ dotState: 'waiting' })).toBe('waiting')
    expect(dashboardBucket({ dotState: 'blocked' })).toBe('waiting')
    expect(dashboardBucket({ dotState: 'monitoring' })).toBe('working')
    expect(dashboardBucket({ dotState: 'done' })).toBe('done')
    expect(dashboardBucket({ dotState: 'unverifiable' })).toBe('idle')
    expect(dashboardBucket({ dotState: 'idle', sleeping: true })).toBe('sleeping')
  })

  it('counts every row, filters and searches, groups by state or project', () => {
    const rows = [
      { id: 'a', dotState: 'working', primary: 'A', projectId: 'p1', projectName: 'One', since: 5 },
      { id: 'b', dotState: 'working', primary: 'B', subline: 'Fix login', projectId: 'p2', projectName: 'Two', since: 9 },
      { id: 'c', dotState: 'idle', primary: 'C', projectId: 'p1', projectName: 'One' }
    ]
    const all = buildDashboard(rows)
    expect(all.counts).toEqual({ waiting: 0, working: 2, done: 0, idle: 1, sleeping: 0 })
    expect(all.groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ['working', ['b', 'a']],
      ['idle', ['c']]
    ])
    expect(buildDashboard(rows, { query: 'login' }).groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual(['b'])
    expect(buildDashboard(rows, { query: 'one' }).groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual(['a', 'c'])
    const idle = buildDashboard(rows, { filter: 'idle' })
    expect(idle.counts.working).toBe(2) // counts ignore the filter
    expect(idle.groups.map((g) => g.key)).toEqual(['idle'])
    const byProject = buildDashboard(rows, { groupBy: 'project' })
    expect(byProject.groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
      ['One', ['a', 'c']],
      ['Two', ['b']]
    ])
  })
})

describe('AgentDashboard.vue', () => {
  const make = (extra = {}) => mount(AgentDashboard, { props: { projects: projects(), now: NOW }, ...extra })

  it('rechecks idle agents after confirmation without adding newly idle agents', async () => {
    let confirm
    const w = make({ global: { provide: { askConfirm: () => new Promise((resolve) => { confirm = resolve }) } } })
    await w.get('[data-test="adb-sleep-idle"]').trigger('click')
    const updated = projects()
    updated[1].panes[0].state = 'working'
    updated[0].panes[0].state = 'ready'
    await w.setProps({ projects: updated })
    confirm(true)
    await flushPromises()
    expect(w.emitted('sleep')).toBeUndefined()
    w.unmount()
  })

  it('a total, a line per state, a bar, and a section per state with its cards', () => {
    const w = make()
    expect(w.find('[data-test="adb-total"]').text()).toBe('7 agents')
    expect(w.find('[data-test="adb-summary"]').text()).toBe('1 waiting · 1 working · 1 done · 3 idle · 1 sleeping')
    expect(w.findAll('.adb-bar-seg')).toHaveLength(5)
    expect(w.findAll('section').map((s) => s.attributes('data-test'))).toEqual([
      'adb-section-waiting',
      'adb-section-working',
      'adb-section-done',
      'adb-section-idle',
      'adb-section-sleeping'
    ])
    const working = w.find('[data-test="adb-section-working"] [data-test="adb-card"]')
    expect(working.find('.adb-card-title').text()).toBe('Build the dashboard')
    expect(working.find('.adb-card-sub').text()).toBe('Claude Code · tessel')
    expect(working.find('[data-test="adb-pill"]').text()).toBe('Working 4m')
    const done = w.find('[data-test="adb-section-done"] [data-test="adb-card"]')
    expect(done.find('.adb-card-title').text()).toBe('Claude Code 2')
    expect(done.find('[data-test="adb-pill"]').text()).toBe('Done 10m')
    // A chat agent is listed; a plain terminal is not.
    expect(w.findAll('[data-test="adb-card"]').map((c) => c.attributes('data-pane-id'))).not.toContain('s')
    expect(w.findAll('[data-test="adb-card"]').map((c) => c.attributes('data-pane-id'))).toContain('c')
  })

  it('chips filter, search narrows, Project groups by project, a card focuses its pane', async () => {
    const w = make()
    expect(w.find('[data-test="adb-chip-idle"]').text()).toContain('3')
    await w.find('[data-test="adb-chip-working"]').trigger('click')
    expect(w.findAll('[data-test="adb-card"]')).toHaveLength(1)
    await w.find('[data-test="adb-chip-all"]').trigger('click')
    await w.find('[data-test="adb-search"]').setValue('site')
    expect(w.findAll('[data-test="adb-card"]')).toHaveLength(4)
    await w.find('[data-test="adb-search"]').setValue('nothing like it')
    expect(w.find('[data-test="adb-no-match"]').exists()).toBe(true)
    await w.find('[data-test="adb-search"]').setValue('')
    await w.find('[data-test="adb-group-project"]').trigger('click')
    expect(w.findAll('.adb-group-name').map((n) => n.text())).toEqual(['tessel', 'site'])
    await w.find('[data-test="adb-card"]').trigger('click')
    expect(w.emitted('focus-pane')).toEqual([['3']])
  })

  it('Sleep idle: the idle terminal agents (not the pane you are in, not a chat), after a confirmation', async () => {
    let asked = null
    let answer = false
    const w = make({ global: { provide: { askConfirm: (o) => ((asked = o), Promise.resolve(answer)) } } })
    const btn = w.find('[data-test="adb-sleep-idle"]')
    expect(btn.text()).toContain('(1)')
    await btn.trigger('click')
    await nextTick()
    expect(asked.title).toBe('Put idle agents to sleep?')
    expect(w.emitted('sleep')).toBeUndefined()
    answer = true
    await btn.trigger('click')
    await nextTick()
    expect(w.emitted('sleep')).toEqual([[['4']]])
  })

  it('an empty dashboard says so', () => {
    const w = mount(AgentDashboard, { props: { projects: [], now: NOW } })
    expect(w.find('[data-test="adb-empty"]').exists()).toBe(true)
    expect(w.find('[data-test="adb-sleep-idle"]').attributes('disabled')).toBeDefined()
  })

  it('in French', async () => {
    await setUiLanguage('fr')
    const w = make()
    expect(w.find('[data-test="adb-total"]').text()).toBe('7 agents')
    expect(w.find('[data-test="adb-chip-all"]').text()).toContain('Tous')
    expect(w.find('[data-test="adb-section-working"] [data-test="adb-pill"]').text()).toBe('Au travail 4 min')
    await setUiLanguage('en')
  })
})
