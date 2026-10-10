// The team-mgmt pipe request end to end on the main side: signed by the MCP
// (teamMcp/server.cjs teamMgmtRequest), checked by cliServer's validateParams,
// then by index.js's 'team-mgmt' handler (extracted, as it runs in Electron).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { createRequire } from 'module'
import { setTeamSecret, teamSecretOf, verifyRequest, newTeamSecret, _resetTeamAuth } from '../teamAuth'
import { validateParams, CliError } from '../cliServer'

const require = createRequire(import.meta.url)
const mcp = require('../teamMcp/server.cjs')

function between(file, from, to) {
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`Missing team-mgmt handler in ${file}`)
  return source.slice(start, end)
}
const source = between('src/main/index.js', "  'team-mgmt': async (params) => {", '\n}\nconst cliServer =')

const PANE = 'pane-9-lead00'
const OTHER = 'pane-4-other0'

function setup(answer) {
  const cliBridge = {
    ask: vi.fn(async (_method, params) => answer ? answer(params) : { teamId: 'team-x', lead: { id: params.pane, num: 3 }, inbox: 'C:\\p\\.tessel\\team\\tok' })
  }
  const ctx = { cliBridge, CliError, teamSecretOf, verifyRequest, process: { env: {} } }
  vm.createContext(ctx)
  const handle = vm.runInContext(`({${source}})['team-mgmt']`, ctx)
  // Through the pipe's own validation, as the server does.
  const send = (req) => handle(validateParams('team-mgmt', JSON.parse(JSON.stringify(req))))
  return { handle, send, cliBridge }
}
// A request signed by the pane this MCP runs in.
function signedBy(pane, secret, args, op = 'bootstrap') {
  process.env.TESSEL_PANE_ID = pane
  process.env.TESSEL_TEAM_SECRET = secret
  return mcp.teamMgmtRequest(op, args)
}

describe('team-mgmt: who may create a team', () => {
  let secret
  beforeEach(() => {
    _resetTeamAuth()
    secret = newTeamSecret()
    setTeamSecret(PANE, secret)
    setTeamSecret(OTHER, newTeamSecret())
  })
  afterEach(() => {
    delete process.env.TESSEL_PANE_ID
    delete process.env.TESSEL_TEAM_SECRET
    _resetTeamAuth()
  })

  it('creates the team for the pane that signed the request', async () => {
    const s = setup()
    const out = await s.send(signedBy(PANE, secret, { teamName: 'Alpha', projectDir: 'C:\\p' }))
    expect(s.cliBridge.ask).toHaveBeenCalledWith('createTeam', { cwd: 'C:\\p', teamName: 'Alpha', pane: PANE })
    expect(out).toMatchObject({ teamId: 'team-x', lead: { id: PANE, num: 3 }, inbox: 'C:\\p\\.tessel\\team\\tok' })
    expect(out.text).toMatch(/^Team "team-x" is ready\. You are its lead \(num 3\)/)
  })

  it('accepts "create" as the same request', async () => {
    const s = setup()
    await s.send(signedBy(PANE, secret, { projectDir: 'C:\\p' }, 'create'))
    expect(s.cliBridge.ask).toHaveBeenCalledWith('createTeam', { cwd: 'C:\\p', teamName: '', pane: PANE })
  })

  it('keeps a padded display name as signed', async () => {
    const s = setup()
    await s.send(signedBy(PANE, secret, { teamName: '  My team  ', projectDir: 'C:\\p' }))
    expect(s.cliBridge.ask).toHaveBeenCalledWith('createTeam', expect.objectContaining({ pane: PANE }))
  })

  it('refuses an unsigned request', async () => {
    const s = setup()
    const req = { pane: PANE, op: 'bootstrap', args: { projectDir: 'C:\\p' } }
    await expect(s.handle(req)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(s.send({ ...req, auth: null })).rejects.toMatchObject({ code: 'unauthorized' })
    expect(s.cliBridge.ask).not.toHaveBeenCalled()
  })

  it('refuses one pane signing for another (no making someone else the lead)', async () => {
    const s = setup()
    // Signed with PANE's secret, but naming OTHER as the pane.
    const req = { ...signedBy(PANE, secret, { projectDir: 'C:\\p' }), pane: OTHER }
    await expect(s.send(req)).rejects.toMatchObject({ code: 'unauthorized' })
    // A secret that is not the pane's.
    await expect(s.send(signedBy(OTHER, newTeamSecret(), { projectDir: 'C:\\p' }))).rejects.toMatchObject({ code: 'unauthorized' })
    expect(s.cliBridge.ask).not.toHaveBeenCalled()
  })

  it('refuses changed arguments', async () => {
    const s = setup()
    const req = signedBy(PANE, secret, { projectDir: 'C:\\p' })
    req.args.projectDir = 'C:\\elsewhere'
    await expect(s.send(req)).rejects.toMatchObject({ code: 'unauthorized' })
    const named = signedBy(PANE, secret, { teamName: 'A', projectDir: 'C:\\p' })
    named.args.teamName = 'B'
    await expect(s.send(named)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(s.cliBridge.ask).not.toHaveBeenCalled()
  })

  it('refuses a replay of the same request', async () => {
    const s = setup()
    const req = signedBy(PANE, secret, { projectDir: 'C:\\p' })
    await s.send(req)
    await expect(s.send(req)).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringMatching(/replay/) })
    expect(s.cliBridge.ask).toHaveBeenCalledTimes(1)
  })

  it('answers unknown_pane for a pane this Tessel did not start, so the agent tries the next Tessel', async () => {
    const s = setup()
    await expect(s.send(signedBy('pane-77-nobody', newTeamSecret(), { projectDir: 'C:\\p' }))).rejects.toMatchObject({ code: 'unknown_pane' })
    // Even unsigned: the pane is checked first.
    await expect(s.handle({ pane: 'pane-77-nobody', op: 'bootstrap', args: {} })).rejects.toMatchObject({ code: 'unknown_pane' })
    expect(s.cliBridge.ask).not.toHaveBeenCalled()
  })

  it('fails when the window does not make the caller the lead with an inbox', async () => {
    const wrong = setup((p) => ({ teamId: 'team-x', lead: { id: OTHER, num: 2 }, inbox: 'x' }))
    await expect(wrong.send(signedBy(PANE, secret, { projectDir: 'C:\\p' }))).rejects.toMatchObject({ code: 'failed' })
    const noInbox = setup((p) => ({ teamId: 'team-x', lead: { id: p.pane, num: 2 }, inbox: null }))
    await expect(noInbox.send(signedBy(PANE, secret, { projectDir: 'C:\\p' }))).rejects.toMatchObject({ code: 'failed' })
  })
})
