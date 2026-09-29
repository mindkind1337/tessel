// The ready handshake: the team tools' MCP server says, once per launch,
// "this launch of this pane is ready", signed; the main process records it
// only for the pane's current launch, started without a first prompt, the
// first time. No real agent runs: the server's functions are called directly.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRequire } from 'module'
import { ensureTeamChannel } from '../teamChannel'
import { writeCurrentTeams } from '../teamNotices'
import { takeTeamRequests, finishTeamRequests, releaseTeamRequests } from '../teamTasks'
import { setTeamSecret, newTeamSecret, _resetTeamAuth, requestMac } from '../teamAuth'
import { registerLaunch, endLaunch, markReady, _resetLaunchReady } from '../launchReady'

const require = createRequire(import.meta.url)
const mcp = require('../teamMcp/server.cjs')

describe('ready handshake', () => {
  let dir
  const teamId = 'team-1'
  const A = { id: 'pane-3-cccccc', num: 3, title: 'Codex CLI' }
  const B = { id: 'pane-4-dddddd', num: 4, title: 'Claude Code' }
  const LAUNCH = 'a'.repeat(32)
  const secrets = {}
  const reqDir = () => join(dir, '.tessel', 'team-channel', teamId, 'requests')
  const as = (who, launch = LAUNCH) => {
    process.env.TESSEL_PANE_ID = who.id
    process.env.TESSEL_TEAM_SECRET = secrets[who.id]
    process.env.TESSEL_AGENT_LAUNCH = launch
  }
  const take = () => takeTeamRequests({ dir, teamId })

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-ready-'))
    for (const p of [A, B]) {
      secrets[p.id] = newTeamSecret()
      setTeamSecret(p.id, secrets[p.id])
    }
    ensureTeamChannel({ dir, teamId, members: [A, B] })
    writeCurrentTeams({ dir, panes: { [A.id]: { team: teamId, num: 3 }, [B.id]: { team: teamId, num: 4 } } })
    process.env.TESSEL_PROJECT_DIR = dir
    registerLaunch(A.id, LAUNCH, { startsIdle: true })
    as(A)
  })
  afterEach(() => {
    for (const k of ['TESSEL_PANE_ID', 'TESSEL_PROJECT_DIR', 'TESSEL_TEAM_SECRET', 'TESSEL_AGENT_LAUNCH']) delete process.env[k]
    _resetTeamAuth()
    _resetLaunchReady()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('the server sends one signed ready for its launch; Tessel records it for that launch', () => {
    expect(mcp.sendReady(1)).toBe(true)
    const [name] = fs.readdirSync(reqDir())
    const file = JSON.parse(fs.readFileSync(join(reqDir(), name), 'utf8'))
    expect(file).toMatchObject({ action: 'ready', launch: LAUNCH, auth: { mac: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect(JSON.stringify(file)).not.toContain(secrets[A.id])
    const res = take()
    expect(res.requests).toEqual([{ file: name, fromId: A.id, action: 'ready', launchToken: LAUNCH, at: expect.any(Number) }])
    // Read again before it is finished (an abandoned round): the same handshake.
    releaseTeamRequests({ dir, teamId, files: [name] })
    expect(take().requests.map((r) => r.action)).toEqual(['ready'])
    finishTeamRequests({ dir, teamId, files: [name] })
  })

  it('an MCP server restarted mid-session: only the first ready of a launch counts', () => {
    mcp.sendReady(1)
    const first = take()
    finishTeamRequests({ dir, teamId, files: first.requests.map((r) => r.file) })
    mcp.sendReady(1)
    const second = take()
    expect(second.requests).toEqual([])
    expect(second.refused).toEqual([]) // dropped quietly
    expect(fs.readdirSync(reqDir())).toEqual([])
  })

  it('a launch started with a first prompt (a worker) is working: its ready does not count', () => {
    registerLaunch(A.id, LAUNCH, { startsIdle: false })
    mcp.sendReady(1)
    expect(take().requests).toEqual([])
  })

  it('bound to the current launch: another token, an ended launch, a relaunch', () => {
    as(A, 'b'.repeat(32)) // a stale or foreign launch token
    mcp.sendReady(1)
    expect(take().requests).toEqual([])
    as(A)
    endLaunch(A.id) // its terminal ended
    mcp.sendReady(1)
    expect(take().requests).toEqual([])
    // Relaunched: a new token; the old launch's ready is worthless, the new one counts.
    registerLaunch(A.id, 'c'.repeat(32), { startsIdle: true })
    mcp.sendReady(1)
    expect(take().requests).toEqual([])
    as(A, 'c'.repeat(32))
    mcp.sendReady(1)
    expect(take().requests.map((r) => r.launchToken)).toEqual(['c'.repeat(32)])
  })

  it('forged or replayed handshakes are refused', () => {
    // Unsigned, named after A.
    fs.mkdirSync(reqDir(), { recursive: true })
    fs.writeFileSync(join(reqDir(), `${A.id}__forged.json`), JSON.stringify({ action: 'ready', launch: LAUNCH }))
    let res = take()
    expect(res.requests).toEqual([])
    expect(res.refused[0].error).toMatch(/not signed/)
    // Signed by B while claiming to be A.
    as(B)
    mcp.taskRequest({ ...mcp.locate(), meId: A.id }, { action: 'ready', launch: LAUNCH })
    res = take()
    expect(res.requests).toEqual([])
    expect(res.refused[0].error).toMatch(/does not match/)
    // A's real one, then a copy of it under another name: a replay.
    as(A)
    mcp.sendReady(1)
    const [name] = fs.readdirSync(reqDir())
    const signed = fs.readFileSync(join(reqDir(), name), 'utf8')
    expect(take().requests).toHaveLength(1)
    finishTeamRequests({ dir, teamId, files: [name] })
    fs.writeFileSync(join(reqDir(), `${A.id}__copy.json`), signed)
    res = take()
    expect(res.requests).toEqual([])
    expect(res.refused[0].error).toMatch(/replay/)
    // A MAC over another launch token than the one the file claims: mismatch.
    const body = JSON.parse(signed)
    body.launch = 'd'.repeat(32)
    fs.writeFileSync(join(reqDir(), `${A.id}__edited.json`), JSON.stringify(body))
    expect(take().refused[0].error).toMatch(/does not match/)
    expect(requestMac).toBeTypeOf('function')
  })

  it('not in a team (a workspace board): no handshake; not in a team yet: tried again', () => {
    expect(markReady('pane-x', LAUNCH, 'k')).toMatchObject({ error: expect.any(String) })
    let calls = 0
    const locateLater = () => (++calls < 2 ? { error: 'Your team is being set up' } : mcp.locate())
    expect(mcp.sendReady(1, locateLater)).toBe(false) // one try only: gave up
    expect(fs.existsSync(reqDir()) ? fs.readdirSync(reqDir()) : []).toEqual([])
    expect(mcp.sendReady(1, locateLater)).toBe(true)
    // Without its secret or launch token the server sends nothing.
    delete process.env.TESSEL_AGENT_LAUNCH
    expect(mcp.sendReady(1)).toBe(false)
  })
})
