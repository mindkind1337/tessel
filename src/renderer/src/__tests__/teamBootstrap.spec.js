// Exercise App.vue's actual bootstrap callback and the main-process bridge
// together: a successful reply must describe the requesting pane's team.
import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { createCliRequests, CliRequestError } from '../cliRequests'

function between(file, from, to) {
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`Missing bootstrap callback in ${file}`)
  return source.slice(start, end)
}
const renderer = between('src/renderer/src/App.vue', '  async createTeam({ dir, teamName, pane: paneId }) {', '\n  notify: (text) => showToast')
const main = between('src/main/index.js', "  'team-mgmt': async (params) => {", '\n}\nconst cliServer =')
const publication = between('src/renderer/src/App.vue', 'async function publishCurrentTeams(', '// --- Team channel')

function setup({ leadFails = false, publishFails = false } = {}) {
  const ws = { id: 'project', cwd: 'C:\\test' }
  const caller = { id: 'pane-caller', num: 7, kind: 'agent', team: null }
  const other = { id: 'pane-other', num: 2, kind: 'agent', team: null }
  const teams = []
  const events = []
  const ctx = {
    window: { shellApi: { channel: { ensure: vi.fn(async () => ({ ok: true })) } } },
    teams: { value: teams },
    workspaces: { value: [ws] },
    sameFolder: (a, b) => a === b,
    findLeaf: (id) => [caller, other].find((l) => l.id === id),
    isAgentLeaf: (leaf) => leaf?.kind === 'agent',
    wsOfLeaf: () => ws,
    CliRequestError,
    t: (_key, fallback) => fallback,
    createTeam: vi.fn(([id], { name }) => {
      const team = { id: 'team-created', name, inboxes: {} }
      ctx.findLeaf(id).team = team.id
      ctx.teams.value.push(team)
      return team
    }),
    teamById: (id) => ctx.teams.value.find((t) => t.id === id),
    changeTeamLead: vi.fn(async (id, pane) => {
      await Promise.resolve()
      if (leadFails) return
      const team = ctx.teams.value.find((t) => t.id === id)
      team.leadId = pane
      team.inboxes[pane] = 'lead-token'
      events.push('lead-ready')
    }),
    assignLeadInbox: vi.fn(async (team, leaf) => {
      team.inboxes[leaf.id] = 'lead-token'
      return { path: 'inbox' }
    }),
    dropInbox: vi.fn(),
    logMembership: vi.fn(),
    channelSigs: {},
    channelBoxes: {},
    tellTeam: vi.fn(),
    publishCurrentTeams: vi.fn(async () => {
      await Promise.resolve()
      if (publishFails) throw new Error('Map publication failed')
      events.push('map-published')
    }),
    teamDir: () => ws.cwd,
    inboxPathFor: (dir, token) => `${dir}/.tessel/team/${token}`,
    scheduleSave: vi.fn(),
    showToast: vi.fn()
  }
  vm.createContext(ctx)
  const callback = vm.runInContext(`({${renderer}}).createTeam`, ctx)
  const requests = createCliRequests({ workspaces: () => [ws], currentWs: () => ws, createTeam: callback })
  const bridge = { ask: vi.fn((method, params) => requests.handle({ method, params })) }
  const mainCtx = { cliBridge: bridge, CliError: CliRequestError, process: { env: {} }, teamSecretOf: () => 'a'.repeat(64), verifyRequest: () => ({ ok: true }) }
  vm.createContext(mainCtx)
  const handle = vm.runInContext(`({${main}})['team-mgmt']`, mainCtx)
  const call = (pane = caller.id, args = {}) => handle({ pane, op: 'bootstrap', args: { projectDir: ws.cwd, ...args } })
  return { call, callback, ctx, bridge, caller, other, teams, events, ws }
}

describe('team bootstrap across the main and renderer request handlers', () => {
  it.each(['current', 'retire'])('strict publication rejects a failed %s IPC response', async (operation) => {
    const api = { current: vi.fn(async () => ({ ok: true })), retire: vi.fn(async () => ({ ok: true })) }
    api[operation].mockResolvedValue({ ok: false, error: 'Disk is not writable' })
    const ctx = { window: { shellApi: { team: api } }, workspaces: { value: [] }, teams: { value: [] }, teamDirsSeen: new Set(['C:\\test']), CliRequestError }
    vm.createContext(ctx)
    const publish = vm.runInContext(`(${publication.trim()})`, ctx)
    await expect(publish({ strict: true })).rejects.toThrow('Disk is not writable')
  })

  it('assigns the caller as lead and waits for the inbox and map before answering', async () => {
    const s = setup()
    const result = await s.call(undefined, { teamName: 'My-team' })
    expect(s.bridge.ask).toHaveBeenCalledWith('createTeam', { cwd: s.ws.cwd, pane: s.caller.id, teamName: 'My-team' })
    expect(s.events).toEqual(['lead-ready', 'map-published'])
    expect(s.teams[0]).toMatchObject({ name: 'My-team', leadId: s.caller.id })
    expect(result).toMatchObject({ teamId: 'team-created', lead: { id: s.caller.id, num: 7 }, inbox: 'C:\\test/.tessel/team/lead-token' })
    expect(result.text).toContain('num 7')
    expect(s.other.team).toBeNull()
    expect(s.ctx.scheduleSave).toHaveBeenCalled()
  })

  it('rejects an unknown caller instead of assigning a different agent or writing a disk-only team', async () => {
    const s = setup()
    await expect(s.call('pane-missing')).rejects.toMatchObject({ code: 'unknown_pane' })
    expect(s.ctx.createTeam).not.toHaveBeenCalled()
  })

  it('rejects a caller already in a team', async () => {
    const s = setup()
    s.caller.team = 'existing-team'
    await expect(s.call()).rejects.toMatchObject({ code: 'already_in_team' })
    expect(s.ctx.createTeam).not.toHaveBeenCalled()
  })

  it('rejects a caller in another project', async () => {
    const s = setup()
    s.ctx.wsOfLeaf = () => ({ id: 'another-project', cwd: 'D:\\other' })
    await expect(s.call()).rejects.toMatchObject({ code: 'no_project' })
    expect(s.ctx.createTeam).not.toHaveBeenCalled()
  })

  it('does not report success when lead creation fails', async () => {
    const s = setup({ leadFails: true })
    await expect(s.call()).rejects.toMatchObject({ code: 'failed' })
    expect(s.caller.team).toBeNull()
    expect(s.ctx.teams.value).toHaveLength(0)
    expect(s.ctx.publishCurrentTeams).toHaveBeenCalledWith()
    // A failed attempt leaves the caller free for a later retry.
    s.ctx.changeTeamLead.mockImplementation(async (id, pane) => {
      const team = s.ctx.teamById(id)
      team.leadId = pane
      team.inboxes[pane] = 'lead-token'
    })
    await expect(s.call()).resolves.toMatchObject({ teamId: 'team-created' })
  })

  it('does not report success when publishing the map fails', async () => {
    const s = setup({ publishFails: true })
    await expect(s.call()).rejects.toThrow('Map publication failed')
    expect(s.caller.team).toBeNull()
    expect(s.ctx.teams.value).toHaveLength(0)
    expect(s.ctx.dropInbox).toHaveBeenCalled()
    expect(s.ctx.window.shellApi.channel.ensure).toHaveBeenCalledWith({ dir: s.ws.cwd, teamId: 'team-created', members: [] })
  })

  it('returns the existing team on retry after a successful creation', async () => {
    const s = setup()
    const first = await s.call()
    expect(await s.call()).toEqual(first)
    expect(s.ctx.createTeam).toHaveBeenCalledTimes(1)
    expect(s.ctx.assignLeadInbox).toHaveBeenCalledTimes(1)
    expect(s.ctx.teams.value).toHaveLength(1)
  })

  it('does not roll back a pre-existing team when an idempotent retry fails', async () => {
    const s = setup()
    await s.call()
    s.ctx.assignLeadInbox.mockResolvedValue(null)
    await expect(s.call()).rejects.toMatchObject({ code: 'failed' })
    expect(s.caller.team).toBe('team-created')
    expect(s.ctx.teams.value).toHaveLength(1)
    expect(s.ctx.dropInbox).not.toHaveBeenCalled()
  })

  it('refuses duplicate display names before creating a team', async () => {
    const s = setup()
    s.ctx.teams.value.push({ id: 'other-team', name: 'My team' })
    await expect(s.call(undefined, { teamName: 'My team' })).rejects.toMatchObject({ code: 'team_name_taken' })
    expect(s.ctx.createTeam).not.toHaveBeenCalled()
  })

  it('reports a non-agent pane distinctly from an unknown pane', async () => {
    const s = setup()
    s.caller.kind = 'shell'
    await expect(s.call()).rejects.toMatchObject({ code: 'not_agent' })
  })
})
