import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { ensureTeamChannel, pollTeamChannel } from '../teamChannel'
import { writeCurrentTeams } from '../teamNotices'
import { publishTeamTasks, takeTeamRequests } from '../teamTasks'

const mcp = createRequire(import.meta.url)('../teamMcp/server.cjs')
describe('named team addresses', () => {
  let dir, previousPane, previousDir, previousSecret
  const members = [{ id: 'pane-a', num: 1, paneName: 'Ada', title: 'Codex' }, { id: 'pane-b', num: 2, paneName: 'Bohr', title: 'Claude Code' }]
  beforeEach(() => {
    previousPane = process.env.TESSEL_PANE_ID
    previousDir = process.env.TESSEL_PROJECT_DIR
    previousSecret = process.env.TESSEL_TEAM_SECRET
    delete process.env.TESSEL_TEAM_SECRET
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-names-'))
    process.env.TESSEL_PROJECT_DIR = dir
    process.env.TESSEL_PANE_ID = 'pane-a'
    expect(ensureTeamChannel({ dir, teamId: 'team-a', members }).ok).toBe(true)
    writeCurrentTeams({ dir, panes: Object.fromEntries(members.map((m) => [m.id, { team: 'team-a', num: m.num, paneName: m.paneName }])) })
  })
  afterEach(() => {
    for (const [key, value] of [['TESSEL_PANE_ID', previousPane], ['TESSEL_PROJECT_DIR', previousDir], ['TESSEL_TEAM_SECRET', previousSecret]]) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  it('resolves names without case sensitivity and keeps numbered callers compatible', () => {
    const ctx = mcp.locate()
    expect(mcp.members(ctx)).toContain('Ada (Codex)')
    expect(mcp.members(ctx)).not.toMatch(/#[12]/)
    expect(mcp.send(ctx, 'bOHR', 'Named message').ok).toBe(true)
    expect(mcp.send(ctx, '#2', 'Legacy message').ok).toBe(true)
    const res = pollTeamChannel({ dir, teamId: 'team-a' })
    expect(res.deliveries.filter((m) => m.toId === 'pane-b').map((m) => m.text)).toEqual(['Named message', 'Legacy message'])
    process.env.TESSEL_PANE_ID = 'pane-b'
    expect(mcp.readInbox(mcp.locate())).toContain('Ada (Codex)')
    delete process.env.TESSEL_PANE_ID
    expect(mcp.locate('ada', dir).meId).toBe('pane-a')
  })
  it('rejects unknown, partial and ambiguous names with valid names, before writing', () => {
    const ctx = mcp.locate()
    expect(mcp.send(ctx, 'Bo', 'Bad').error).toMatch(/Valid names: Ada, Bohr/)
    ctx.state.members['pane-c'] = { active: true, num: 3, paneName: 'BOHR', title: 'Codex' }
    expect(mcp.send(ctx, 'Bohr', 'Bad').error).toMatch(/ambiguous/)
  })
  it('publishes task assignees as names and accepts names in requests', () => {
    const ctx = mcp.locate()
    expect(mcp.addTask(ctx, { title: 'Review', assignee: 'bOhR' }).ok).toBe(true)
    const requests = takeTeamRequests({ dir, teamId: 'team-a' })
    expect(requests.requests[0].assignee).toBe('Bohr')
    publishTeamTasks({ dir, teamId: 'team-a', tasks: [{ id: 'task-1', title: 'Review', column: 'doing', assignee: 'Bohr' }] })
    expect(mcp.listTasks(ctx)).toContain('(Bohr)')
  })
  it('a rename updates routing while preserving the channel token and hidden alias', () => {
    const old = mcp.locate()
    expect(ensureTeamChannel({ dir, teamId: 'team-a', members: [members[0], { ...members[1], paneName: 'Curie' }] }).ok).toBe(true)
    const next = mcp.locate()
    expect(next.me.token).toBe(old.me.token)
    expect(mcp.send(next, 'Bohr', 'Old name').error).toMatch(/Ada, Curie/)
    expect(mcp.send(next, 'curie', 'New name').ok).toBe(true)
    expect(mcp.send(next, '#2', 'Old alias').ok).toBe(true)
  })
})
