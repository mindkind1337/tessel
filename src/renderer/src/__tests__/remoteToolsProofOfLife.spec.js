import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// The proof-of-life check of agents on an SSH host (App.vue
// checkRemoteAgentTools), read from the source (App needs a full window).
const src = fs.readFileSync(path.resolve(__dirname, '../App.vue'), 'utf8')
const fnSrc = src.slice(src.indexOf('function toolsRanSince('), src.indexOf('// An agent on an SSH host whose tessel-team server never connected'))
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
