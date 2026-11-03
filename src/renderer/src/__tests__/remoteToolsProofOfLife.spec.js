import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// The proof-of-life check of agents on an SSH host (App.vue
// checkRemoteAgentTools), read from the source (App needs a full window).
const src = fs.readFileSync(path.resolve(__dirname, '../App.vue'), 'utf8')
const fnSrc = src.slice(src.indexOf('function toolsRanSince('), src.indexOf('// An agent on an SSH host whose tessel_team server never connected'))
// eslint-disable-next-line no-new-func
const toolsRanSince = new Function(`${fnSrc}; return toolsRanSince`)()

describe('an agent whose team tools ran since it started', () => {
  const launchedAt = 1_000_000
  const remote = { id: 'p1', remoteHostId: 'ssh-h', launchedAt }
  const local = { id: 'p1', launchedAt }
  it('the tools of a previous launch of the same pane never count; this launch\'s, however long ago on a host', () => {
    const old = { ok: true, alive: { p1: { at: launchedAt + 10 } }, seen: { p1: launchedAt + 10 }, sameLaunch: { p1: false } }
    expect(toolsRanSince(old, 'p1', remote)).toBe(false)
    expect(toolsRanSince(old, 'p1', local)).toBe(false)
    const mine = { ok: true, alive: { p1: null }, seen: { p1: launchedAt - 3_600_000 }, sameLaunch: { p1: true } }
    expect(toolsRanSince(mine, 'p1', remote)).toBe(true)
    expect(toolsRanSince(mine, 'p1', local)).toBe(false)
  })
  it('running now: yes, local or remote', () => {
    const res = { ok: true, alive: { p1: { at: launchedAt + 10 } }, seen: { p1: launchedAt + 10 } }
    expect(toolsRanSince(res, 'p1', remote)).toBe(true)
    expect(toolsRanSince(res, 'p1', local)).toBe(true)
  })
  it('an SSH host agent idle for an hour (its tools stopped, its shim reopens them): still yes', () => {
    const res = { ok: true, alive: { p1: null }, seen: { p1: launchedAt + 60_000 } }
    expect(toolsRanSince(res, 'p1', remote)).toBe(true)
    // A local agent's tools that stopped are down.
    expect(toolsRanSince(res, 'p1', local)).toBe(false)
  })
  it('a file of another launch (the same pane id restarted) or none: no', () => {
    expect(toolsRanSince({ ok: true, alive: { p1: null }, seen: { p1: launchedAt - 60_000 }, sameLaunch: { p1: false } }, 'p1', remote)).toBe(false)
    expect(toolsRanSince({ ok: true, alive: { p1: null }, seen: { p1: null } }, 'p1', remote)).toBe(false)
    expect(toolsRanSince({ ok: false }, 'p1', remote)).toBe(false)
    expect(toolsRanSince({ ok: true, alive: {}, seen: {} }, 'p1', null)).toBe(false)
  })
  it('older tools whose file does not say its launch (running from before an update, or idle since): never reported missing', () => {
    expect(toolsRanSince({ ok: true, alive: { p1: null }, seen: { p1: launchedAt - 3_600_000 }, sameLaunch: { p1: null } }, 'p1', remote)).toBe(true)
    expect(toolsRanSince({ ok: true, alive: { p1: null }, seen: { p1: launchedAt - 3_600_000 } }, 'p1', remote)).toBe(true)
  })
})

describe('the note it puts in the pane', () => {
  const check = src.slice(src.indexOf('async function checkRemoteAgentTools('), src.indexOf('// Agents started by hand in a shell pane'))
  it('counts what ran since the launch, for a team member on a host too', () => {
    expect(check).toContain('for (const id of ids) if (toolsRanSince(res, id, findLeaf(id))) alive.add(id)')
    const team = src.slice(src.indexOf('async function checkTeamTools('), src.indexOf('async function checkRemoteAgentTools('))
    expect(team).toContain('for (const id of ids) if (toolsRanSince(res, id, findLeaf(id))) alive.add(id)')
  })
  it('goes by itself once the tools connect, only when this check put it', () => {
    expect(check).toMatch(/if \(remoteToolsNoted\.delete\(leaf\)\) delete leaf\.remoteToolsNote/)
    expect(check).toMatch(/leaf\.remoteToolsNote = t\('app\.remoteAgents\.toolsNotRunning'[^\n]*\r?\n\s*remoteToolsNoted\.add\(leaf\)/)
    // Kept per pane object: a pane started again in place counts from nothing.
    expect(src).toContain('const remoteToolsMisses = new WeakMap()')
    expect(src).toContain('const remoteToolsNoted = new WeakSet()')
  })
  it('each pane says which launch is its own (toolsAlive tells the tools of a previous launch apart)', () => {
    expect(src.split('window.shellApi.team.toolsAlive({ dir, ids, launches: launchTokens(ids) })').length - 1).toBe(2)
  })
})

// The nudge "[Tessel] You have new team messages…" (teamDelivery.js pointerText)
// is typed only into a pane whose agent can read them (App.vue pointerBlocked,
// run from the source with what it looks at stubbed).
describe('the nudge never goes into a pane that cannot read it', () => {
  const list = src.slice(src.indexOf('const REMOTE_TOOLS_AGENTS = ['), src.indexOf('\n', src.indexOf('const REMOTE_TOOLS_AGENTS = [')))
  const fnSrc = src.slice(src.indexOf('function pointerBlocked('), src.indexOf('const restartedForTools = new Set()'))
  const idle = { state: 'idle' }
  const blocked = (leaf) => {
    const stubs = {
      findLeaf: () => leaf,
      settings: { teamWakeUps: true, teamWakeUnconfirmed: false },
      restartingLeaves: new Set(),
      wakeState: {},
      WAKE_AFTER_MS: 0,
      REWAKE_AFTER_MS: 0,
      WAKE_AFTER_RESTART_MS: 0,
      agentStateKnown: () => true,
      trackedState: { p1: idle },
      awaitingApproval: () => false,
      approvals: {},
      limits: {},
      pendingMessages: {},
      unsent: {},
      delivering: new Set(),
      wakeAllowed: () => true,
      Date
    }
    // eslint-disable-next-line no-new-func
    const fn = new Function(...Object.keys(stubs), `${list}; ${fnSrc}; return pointerBlocked`)(...Object.values(stubs))
    return fn('p1')
  }
  const agent = (extra = {}) => ({ id: 'p1', kind: 'agent', agentId: 'claude', teamTools: true, ...extra })

  it('an idle local agent with the team tools: not blocked', () => {
    expect(blocked(agent())).toBe('')
    expect(blocked(agent({ agentId: 'gemini' }))).toBe('')
  })
  it('on an SSH host: Claude Code, Codex and Antigravity read them; an agent the host gives no tools cannot', () => {
    for (const agentId of ['claude', 'codex', 'antigravity']) expect(blocked(agent({ agentId, remoteHostId: 'ssh-box' }))).toBe('')
    for (const agentId of ['gemini', 'opencode', 'qwen']) expect(blocked(agent({ agentId, remoteHostId: 'ssh-box' }))).toBe('its agent has no Tessel tools on the host')
  })
  it('an agent on a host whose tools never connected (its note in the pane): blocked until they do', () => {
    expect(blocked(agent({ agentId: 'claude', remoteHostId: 'ssh-box', remoteToolsNote: 'Tessel tools are not connected on Box: x.' }))).toBe('its Tessel tools are not connected on the host')
    const leaf = agent({ agentId: 'antigravity', remoteHostId: 'ssh-box', remoteToolsNote: 'Tessel tools are not connected on Box: x.' })
    expect(blocked(leaf)).toMatch(/not connected on the host/)
    delete leaf.remoteToolsNote // checkRemoteAgentTools saw them run
    expect(blocked(leaf)).toBe('')
  })
  it('a pane without the team tools at all stays blocked as before', () => {
    expect(blocked(agent({ teamTools: false, remoteHostId: 'ssh-box' }))).toBe('not an agent pane with the team tools')
  })
})
