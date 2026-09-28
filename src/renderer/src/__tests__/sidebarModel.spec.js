// The left sidebar's logic (Orca's, see sidebarModel.js): projects ->
// workspaces (the project folder and each task copy) -> agents/terminals.
import { describe, it, expect } from 'vitest'
import {
  paneDotState,
  buildProjectCards,
  buildSidebarRows,
  cardStatus,
  summarizeAgents,
  buildSummaryAgentGroups,
  selectSummaryGroupIconAgents,
  formatShortTimeAgo,
  neighborCard,
  cardTargetPane,
  portProbes,
  compareCards,
  paneRow
} from '../sidebarModel'

const NOW = 1_000_000_000
const pane = (id, extra = {}) => ({ id, num: 1, kind: 'agent', title: id, agentId: 'claude', state: 'ready', ...extra })

function project(extra = {}) {
  return {
    id: 'ws1',
    name: 'Shop',
    cwd: 'C:\\repo',
    branch: 'main',
    panes: [
      pane('a', { num: 1, state: 'working', since: NOW - 120000, pid: 11 }),
      pane('t', { num: 2, kind: 'shell', title: 'pwsh', shellId: 'pwsh', pid: 12 }),
      pane('c', {
        num: 3,
        state: 'approval',
        since: NOW - 5000,
        copyPath: 'C:\\repo.worktrees\\fix-login',
        copyBranch: 'tessel/fix-login',
        pid: 13,
        focused: true
      })
    ],
    copies: [
      { path: 'C:\\repo.worktrees\\fix-login', branch: 'tessel/fix-login', title: 'Fix the login', taskId: 'T1' },
      { path: 'C:\\repo.worktrees\\old', branch: 'tessel/old', title: 'Old task', taskId: 'T2' }
    ],
    ...extra
  }
}

describe('states in Orca words', () => {
  it('maps Tessel pane states to Orca dots', () => {
    expect(paneDotState(pane('x', { state: 'working' }))).toBe('working')
    expect(paneDotState(pane('x', { state: 'approval' }))).toBe('waiting')
    expect(paneDotState(pane('x', { state: 'limited' }))).toBe('blocked')
    expect(paneDotState(pane('x', { state: 'waiting' }))).toBe('done')
    expect(paneDotState(pane('x', { state: 'unknown' }))).toBe('unverifiable')
    expect(paneDotState(pane('x', { state: 'working', sleeping: true }))).toBe('idle')
    expect(paneDotState(pane('x', { kind: 'shell' }))).toBe('idle')
  })

  it("a workspace's status: permission > working > usage limit > done > active > inactive", () => {
    const r = (dotState, sleeping = false) => ({ dotState, sleeping })
    expect(cardStatus([r('working'), r('waiting')])).toBe('permission')
    expect(cardStatus([r('working'), r('idle')])).toBe('working')
    expect(cardStatus([r('blocked'), r('done')])).toBe('interrupted')
    expect(cardStatus([r('done'), r('idle')])).toBe('done')
    expect(cardStatus([r('idle')])).toBe('active')
    expect(cardStatus([r('working', true)])).toBe('inactive')
    expect(cardStatus([])).toBe('inactive')
  })

  it('ages like Orca (now / 5m / 3h / 2d)', () => {
    expect(formatShortTimeAgo(NOW - 10000, NOW)).toBe('now')
    expect(formatShortTimeAgo(NOW - 5 * 60000, NOW)).toBe('5m')
    expect(formatShortTimeAgo(NOW - 3 * 3600000, NOW)).toBe('3h')
    expect(formatShortTimeAgo(NOW - 50 * 3600000, NOW)).toBe('2d')
  })

  it('a row says what the pane does', () => {
    expect(paneRow(pane('x', { state: 'limited', reset: 'resets 4pm' }), NOW).secondary).toBe('Usage limit · resets 4pm')
    expect(paneRow(pane('x', { sleeping: true }), NOW).secondary).toBe('Sleeping')
    expect(paneRow(pane('x', { kind: 'shell', title: 'pwsh' }), NOW)).toMatchObject({ primary: 'pwsh', secondary: 'Terminal' })
    expect(paneRow(pane('x', { task: 'Fix it', state: 'working' }), NOW)).toMatchObject({ primary: 'x', secondary: '', subline: 'Fix it', stateLabel: 'Working' })
    expect(paneRow(pane('x', { sessionId: 's1' }), NOW).children).toEqual({ agent: 'claude', sessionId: 's1' })
    expect(paneRow(pane('x', { agentId: 'codex', sessionId: 's1' }), NOW).children).toBeNull()
  })
})

describe('cards of a project', () => {
  it('the project folder first, then each task copy with the panes working in it', () => {
    const cards = buildProjectCards(project(), NOW)
    expect(cards.map((c) => [c.title, c.isMain, c.branch, c.panes.map((p) => p.id)])).toEqual([
      ['repo', true, 'main', ['a', 't']],
      ['Fix the login', false, 'tessel/fix-login', ['c']],
      ['Old task', false, 'tessel/old', []]
    ])
    const [main, copy, old] = cards
    expect(main.status).toBe('working')
    expect(copy.status).toBe('permission')
    expect(copy.isActive).toBe(true)
    expect(old.sleeping).toBe(true)
    expect(old.status).toBe('inactive')
    expect(main.panes[0].time).toBe('2m')
  })

  it('a copy made outside a task still gets its card, named after its branch', () => {
    const p = project({ copies: [] })
    const cards = buildProjectCards(p, NOW)
    expect(cards[1]).toMatchObject({ title: 'tessel/fix-login', taskId: null })
  })

  it('a workspace with no project folder shows its name', () => {
    const cards = buildProjectCards(project({ cwd: null, branch: '', copies: [], panes: [] }), NOW)
    expect(cards[0]).toMatchObject({ title: 'Shop', path: null, sleeping: true })
  })
})

describe('the list', () => {
  const projects = [
    project(),
    {
      id: 'ws2',
      name: 'Docs',
      cwd: 'C:\\docs',
      branch: '',
      panes: [pane('d', { state: 'waiting', since: NOW - 1000 })],
      copies: []
    }
  ]

  it('groups by project with a header per project (Orca default)', () => {
    const rows = buildSidebarRows(projects, { sortBy: 'manual' }, NOW)
    expect(rows.map((r) => (r.type === 'header' ? `# ${r.label}` : r.card.title))).toEqual([
      '# Shop',
      'repo',
      'Fix the login',
      'Old task',
      '# Docs',
      'docs'
    ])
  })

  it('"Agent Activity" puts the workspaces needing you first', () => {
    const rows = buildSidebarRows([projects[0]], { sortBy: 'smart' }, NOW)
    expect(rows.filter((r) => r.type === 'card').map((r) => r.card.title)).toEqual(['Fix the login', 'repo', 'Old task'])
  })

  it('Hide sleeping (except the default branch), Hide default branch, and the one you are in stays', () => {
    const titles = (opts) =>
      buildSidebarRows([projects[0]], { sortBy: 'manual', ...opts }, NOW)
        .filter((r) => r.type === 'card')
        .map((r) => r.card.title)
    expect(titles({ showSleepingWorkspaces: false })).toEqual(['repo', 'Fix the login'])
    expect(titles({ hideDefaultBranchWorkspace: true })).toEqual(['Fix the login', 'Old task'])
    // The copy you are in is never hidden.
    expect(titles({ hideDefaultBranchWorkspace: true, showSleepingWorkspaces: false })).toEqual(['Fix the login'])
  })

  it('collapsed projects keep their header; project filter; no grouping', () => {
    const collapsed = buildSidebarRows(projects, { collapsedGroups: ['repo:ws1'], sortBy: 'manual' }, NOW)
    expect(collapsed[0]).toMatchObject({ type: 'header', collapsed: true, count: 3 })
    expect(collapsed[1]).toMatchObject({ type: 'header', label: 'Docs' })
    const filtered = buildSidebarRows(projects, { filterRepoIds: ['ws2'] }, NOW)
    expect(filtered.filter((r) => r.type === 'header').map((r) => r.label)).toEqual(['Docs'])
    const flat = buildSidebarRows(projects, { groupBy: 'none', sortBy: 'name' }, NOW)
    expect(flat[0]).toMatchObject({ type: 'header', label: 'All' })
    expect(flat.slice(1).map((r) => r.card.title)).toEqual(['docs', 'Fix the login', 'Old task', 'repo'])
  })

  it('project order: most recent activity first', () => {
    const rows = buildSidebarRows(
      [
        { ...projects[0], panes: [pane('a', { since: NOW - 50000 })], copies: [] },
        { ...projects[1], panes: [pane('d', { since: NOW - 10 })] }
      ],
      { projectOrderBy: 'recent' },
      NOW
    )
    expect(rows.filter((r) => r.type === 'header').map((r) => r.label)).toEqual(['Docs', 'Shop'])
  })

  it('"Recent" follows what agents did, not where you clicked (a click never reorders)', () => {
    const p = { ...projects[0], copies: [], panes: [pane('a', { since: NOW - 1000 }), pane('c', { copyPath: 'D:/work/x', activityAt: NOW, since: NOW - 9000 })] }
    const titles = buildSidebarRows([p], { sortBy: 'recent' }, NOW)
      .filter((r) => r.type === 'card')
      .map((r) => r.card.title)
    expect(titles).toEqual(['repo', 'x'])
  })

  it('arrow keys move between workspaces, wrapping', () => {
    const rows = buildSidebarRows(projects, { sortBy: 'manual' }, NOW)
    expect(neighborCard(rows, 'ws1::', 'down').title).toBe('Fix the login')
    expect(neighborCard(rows, 'ws1::', 'up').title).toBe('docs')
    expect(neighborCard(rows, null, 'down').title).toBe('repo')
  })

  it('a click on a card goes to the pane you were in there, else its first agent', () => {
    const [main, copy] = buildProjectCards(project(), NOW)
    expect(cardTargetPane(copy)).toBe('c')
    expect(cardTargetPane(main)).toBe('a')
    const recent = buildProjectCards(project({ panes: [pane('a'), pane('b', { activityAt: 5 })] }), NOW)[0]
    expect(cardTargetPane(recent)).toBe('b')
  })

  it('name / recent / repo sorts', () => {
    const a = { title: 'b', attention: { cls: 5, attentionTimestamp: 0 }, lastActivityAt: 1, projectId: 'p2', order: 1 }
    const b = { title: 'a', attention: { cls: 5, attentionTimestamp: 0 }, lastActivityAt: 2, projectId: 'p1', order: 0 }
    expect([a, b].sort(compareCards('name')).map((c) => c.title)).toEqual(['a', 'b'])
    expect([a, b].sort(compareCards('recent')).map((c) => c.title)).toEqual(['a', 'b'])
    expect([a, b].sort(compareCards('repo', { p1: 'Z', p2: 'A' })).map((c) => c.title)).toEqual(['b', 'a'])
  })
})

describe('agent summaries (compact agent activity)', () => {
  const rows = [
    { id: '1', dotState: 'working', iconKind: 'claude', typeLabel: 'Claude' },
    { id: '2', dotState: 'waiting', iconKind: 'codex', typeLabel: 'Codex' },
    { id: '3', dotState: 'working', iconKind: 'claude', typeLabel: 'Claude 2' }
  ]
  it('reads like Orca', () => {
    expect(summarizeAgents(rows, '3 agents')).toBe('3 agents: 1 waiting, 2 working')
    expect(summarizeAgents(rows.slice(0, 1), '1 agents')).toBe('1 agents working')
    expect(summarizeAgents([rows[0], rows[2]], '2 agents')).toBe('All 2 agents working')
    expect(buildSummaryAgentGroups(rows).map((g) => [g.state, g.agents.length])).toEqual([
      ['waiting', 1],
      ['working', 2]
    ])
    expect(selectSummaryGroupIconAgents(rows, 3).map((r) => r.id)).toEqual(['1', '2'])
  })
})

describe('port probes', () => {
  it("each card's shells and, for git folders, its path", () => {
    expect(portProbes([project()])).toEqual([
      { id: 'ws1::', pids: [11, 12], path: 'C:\\repo' },
      { id: 'ws1::C:\\repo.worktrees\\fix-login', pids: [13], path: 'C:\\repo.worktrees\\fix-login' },
      { id: 'ws1::C:\\repo.worktrees\\old', pids: [], path: 'C:\\repo.worktrees\\old' }
    ])
    // Not a git folder (a home folder, say): only its shells.
    expect(portProbes([project({ branch: '', copies: [], panes: [pane('a', { pid: 5 })] })])).toEqual([
      { id: 'ws1::', pids: [5], path: null }
    ])
  })
})
