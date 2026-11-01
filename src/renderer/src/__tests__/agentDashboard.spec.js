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
      ['working', ['a', 'b']], // the longest at work on top
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

describe('dashboard order', () => {
  it('in a state, the longest there first: an agent that starts goes under the others', () => {
    const rows = [
      { id: 'new', dotState: 'working', num: 1, since: 300 },
      { id: 'old', dotState: 'working', num: 2, since: 100 },
      { id: 'mid', dotState: 'working', num: 3, since: 200 },
      { id: 'unknown', dotState: 'working', num: 0 }
    ]
    expect(buildDashboard(rows).groups[0].rows.map((r) => r.id)).toEqual(['old', 'mid', 'new', 'unknown'])
  })

  it('by project: projects at work first, the one at it the longest on top, then the others in sidebar order', () => {
    const rows = [
      { id: 'a', dotState: 'idle', projectId: 'p1', projectName: 'Quiet', since: 1 },
      { id: 'b', dotState: 'working', projectId: 'p2', projectName: 'Late', since: 500 },
      { id: 'c', dotState: 'done', projectId: 'p3', projectName: 'Done', since: 2 },
      { id: 'd', dotState: 'working', projectId: 'p4', projectName: 'Early', since: 100 },
      { id: 'e', dotState: 'idle', projectId: 'p4', projectName: 'Early', since: 50 },
      { id: 'f', dotState: 'waiting', projectId: 'p5', projectName: 'Asks', since: 300 }
    ]
    const g = buildDashboard(rows, { groupBy: 'project' }).groups
    expect(g.map((x) => x.label)).toEqual(['Early', 'Asks', 'Late', 'Quiet', 'Done'])
    expect(g[0].rows.map((r) => r.id)).toEqual(['d', 'e'])
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
    expect(working.find('.adb-card-sub').text()).toBe('Claude Code 1 · tessel') // its pane's name: the icon says the agent
    expect(working.find('[data-test="adb-pill"]').text()).toBe('4m') // the section names the state
    const done = w.find('[data-test="adb-section-done"] [data-test="adb-card"]')
    expect(done.find('.adb-card-title').text()).toBe('Claude Code 2')
    expect(done.find('[data-test="adb-pill"]').text()).toBe('10m')
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

  it('a right-click on a card: go to its pane, sleep it (or wake it when asleep), close it', async () => {
    const w = make({ attachTo: document.body })
    const card = (id) => w.findAll('[data-test="adb-card"]').find((c) => c.attributes('data-pane-id') === id)
    const items = () => [...document.body.querySelectorAll('.orca-menu-item')]
    const labels = () => items().map((b) => b.textContent.trim())
    await card('4').trigger('contextmenu', { clientX: 10, clientY: 20 })
    expect(labels()).toEqual(['Go to Pane', 'Sleep', 'Close'])
    items()[1].click()
    await nextTick()
    expect(w.emitted('sleep')).toEqual([[['4']]])
    await card('4').trigger('contextmenu')
    items()[2].click()
    await nextTick()
    expect(w.emitted('close-pane')).toEqual([['4']])
    // Asleep: Wake it (opening its pane is what wakes it).
    await card('6').trigger('contextmenu')
    expect(labels()).toEqual(['Go to Pane', 'Wake it', 'Close'])
    items()[1].click()
    await nextTick()
    expect(w.emitted('focus-pane')).toEqual([['6']])
    // A chat agent has no terminal to stop: no Sleep.
    await card('c').trigger('contextmenu')
    expect(labels()).toEqual(['Go to Pane', 'Close'])
    w.unmount()
  })

  it("a card in a team shows the team's number on its icon, the lead's marked", () => {
    const list = projects()
    const agents = list[0].panes.filter((p) => p.kind === 'agent' || p.kind === 'chat')
    agents[0].team = 't1'
    agents[0].lead = true
    agents[1].team = 't1'
    const w = mount(AgentDashboard, {
      props: { projects: list, now: NOW },
      global: { provide: { panelCtx: { teamById: (id) => (id === 't1' ? { id: 't1', name: 'Team 2' } : null) } } }
    })
    const badges = w.findAll('[data-test="adb-team"]')
    expect(badges.map((b) => b.text())).toEqual(['2', '2'])
    expect(badges.filter((b) => b.classes().includes('lead'))).toHaveLength(1)
    expect(w.find('[data-test="adb-team"].lead').attributes('title')).toBe('Team 2 (lead)')
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
    expect(w.find('[data-test="adb-section-working"] [data-test="adb-pill"]').text()).toBe('4 min')
    await setUiLanguage('en')
  })
})

describe('AgentDashboard.vue: before the layout is back', () => {
  it('shows it is loading, not "No agents yet"; empty only once ready', async () => {
    const w = mount(AgentDashboard, { props: { projects: [], now: NOW, ready: false } })
    expect(w.find('[data-test="adb-loading"]').exists()).toBe(true)
    expect(w.find('[data-test="adb-empty"]').exists()).toBe(false)
    await w.setProps({ ready: true })
    expect(w.find('[data-test="adb-loading"]').exists()).toBe(false)
    expect(w.find('[data-test="adb-empty"]').exists()).toBe(true)
    w.unmount()
  })

  it('agents already listed are shown even before ready', async () => {
    const w = mount(AgentDashboard, { props: { projects: projects(), now: NOW, ready: false } })
    expect(w.find('[data-test="adb-loading"]').exists()).toBe(false)
    expect(w.find('[data-test="adb-empty"]').exists()).toBe(false)
    w.unmount()
  })
})
