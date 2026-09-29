// Orchestration through the team tools (Orca's coordinator and workers, the
// Tessel way): each worker tool drops a request Tessel applies; the ones that
// answer wait for Tessel's answer file. No real agent runs here: Tessel's side
// is played by the test (takeTeamRequests, writeTeamAnswer, publishWorkers).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRequire } from 'module'
import { ensureTeamChannel } from '../teamChannel'
import { writeCurrentTeams } from '../teamNotices'
import { publishTeamTasks, takeTeamRequests, finishTeamRequests, writeTeamAnswer, publishWorkers, parseRequest } from '../teamTasks'

const require = createRequire(import.meta.url)
const mcp = require('../teamMcp/server.cjs')

describe('worker tools', () => {
  let dir
  const teamId = 'team-1'
  const LEAD = { id: 'pane-1-aaaaaa', num: 1, title: 'Claude Code' }
  const W = { id: 'pane-5-bbbbbb', num: 5, title: 'Codex CLI' }
  const as = (who) => (process.env.TESSEL_PANE_ID = who.id)
  const call = (name, args = {}) => mcp.handle({ id: 1, method: 'tools/call', params: { name, arguments: args } })
  const text = (r) => r.content[0].text
  const requests = () => takeTeamRequests({ dir, teamId }).requests
  // Tessel's side: answer every request that waits, then remove the files.
  async function tesselAnswers(answer) {
    for (let i = 0; i < 40; i++) {
      const reqs = requests()
      if (reqs.length) {
        for (const r of reqs) if (r.rid) writeTeamAnswer({ dir, teamId, rid: r.rid, ...answer(r) })
        finishTeamRequests({ dir, teamId, files: reqs.map((r) => r.file) })
        return reqs
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return []
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-workers-'))
    ensureTeamChannel({ dir, teamId, members: [LEAD, W] })
    writeCurrentTeams({ dir, panes: { [LEAD.id]: { team: teamId, num: 1 }, [W.id]: { team: teamId, num: 5 } } })
    as(LEAD)
    process.env.TESSEL_PROJECT_DIR = dir
  })
  afterEach(() => {
    delete process.env.TESSEL_PANE_ID
    delete process.env.TESSEL_PROJECT_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('the tools are listed with their schemas', () => {
    const tools = Object.fromEntries(mcp.TOOLS.map((t) => [t.name, t]))
    expect(tools.team_worker_start.inputSchema.required).toEqual(['agent', 'task', 'brief'])
    expect(tools.team_worker_start.inputSchema.properties.agent.enum).toEqual(['claude', 'codex', 'gemini', 'qwen'])
    expect(tools.team_worker_start.inputSchema.properties.isolation.enum).toEqual(['worktree', 'project'])
    expect(tools.team_worker_start.inputSchema.properties.model.type).toBe('string')
    expect(tools.team_worker_start.inputSchema.properties.effort.type).toBe('string')
    expect(tools.team_worker_stop.inputSchema.required).toEqual(['worker'])
    expect(tools.team_worker_read.inputSchema.required).toEqual(['worker'])
    expect(tools.team_worker_release.inputSchema.required).toEqual(['worker'])
    expect(tools.team_worker_done.inputSchema.required).toEqual(['summary'])
    expect(tools.team_heartbeat.inputSchema.properties.phase.enum).toEqual(['investigating', 'implementing', 'reviewing', 'waiting'])
    for (const t of mcp.TOOLS) expect(t.description.length).toBeGreaterThan(20)
    // A new tools API: running agents are told to restart for it.
    expect(mcp.VERSION).toBe('1.8.0')
  })

  it('team_worker_start: sent to Tessel, waits for its answer', async () => {
    const starting = call('team_worker_start', {
      agent: 'codex',
      task: 'Fix the cart',
      brief: 'Make the total right. Run npm test.',
      isolation: 'worktree',
      model: 'gpt-5.5',
      effort: 'high',
      after: ['task-1-1']
    })
    const reqs = await tesselAnswers(() => ({ ok: true, text: 'Started worker #5 (codex) on card task-2-2 "Fix the cart".' }))
    const { file, fromId, rid, ...r } = reqs[0]
    expect(fromId).toBe(LEAD.id)
    expect(rid).toMatch(/^r-/)
    expect(r).toEqual({
      action: 'worker-start',
      agent: 'codex',
      title: 'Fix the cart',
      brief: 'Make the total right. Run npm test.',
      isolation: 'worktree',
      model: 'gpt-5.5',
      effort: 'high',
      deps: ['task-1-1']
    })
    const res = await starting
    expect(res.isError).toBe(false)
    expect(text(res)).toMatch(/Started worker #5/)
    // The answer file is taken (removed) by the tool.
    expect(fs.readdirSync(join(dir, '.tessel', 'team-channel', teamId, 'answers'))).toEqual([])
  }, 20000)

  it('team_worker_start: a refusal is an error; bad arguments never reach Tessel', async () => {
    const starting = call('team_worker_start', { agent: 'claude', task: 'X', brief: 'Y' })
    await tesselAnswers(() => ({ ok: false, text: 'Starting a worker is not permitted at depth 2 (max 1). Complete this task yourself.' }))
    const res = await starting
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/Complete this task yourself/)

    for (const bad of [
      { agent: 'cline', task: 'X', brief: 'Y' },
      { agent: 'codex', brief: 'Y' },
      { agent: 'codex', task: 'X' },
      { agent: 'codex', task: 'X', brief: 'Y', isolation: 'docker' },
      { agent: 'codex', task: 'X', brief: 'Y', model: 'a b' },
      { agent: 'codex', task: 'X', brief: 'Y', after: ['../../x'] }
    ]) {
      const r = await call('team_worker_start', bad)
      expect(r.isError).toBe(true)
    }
    expect(requests()).toEqual([])
  }, 20000)

  it('read, stop (one or all), release: requests with an answer', async () => {
    const read = call('team_worker_read', { worker: '5', lines: 30 })
    let reqs = await tesselAnswers(() => ({ ok: true, text: '#5 "Fix the cart" is running. Its screen now:\nRunning tests…' }))
    expect(reqs[0]).toMatchObject({ action: 'worker-read', worker: '#5', lines: 30 })
    expect(text(await read)).toMatch(/Running tests/)

    const stop = call('team_worker_stop', { worker: 'all', reason: 'plan changed' })
    reqs = await tesselAnswers(() => ({ ok: true, text: 'Stopped: #5.' }))
    expect(reqs[0]).toMatchObject({ action: 'worker-stop', worker: 'all', reason: 'plan changed' })
    expect(text(await stop)).toBe('Stopped: #5.')

    const release = call('team_worker_release', { worker: '#5' })
    reqs = await tesselAnswers(() => ({ ok: true, text: 'Released #5.' }))
    expect(reqs[0]).toMatchObject({ action: 'worker-release', worker: '#5' })
    expect(text(await release)).toBe('Released #5.')

    expect((await call('team_worker_stop', { worker: 'everyone' })).isError).toBe(true)
    expect((await call('team_worker_release', { worker: 'all' })).isError).toBe(true)
  }, 30000)

  it('a worker reports done and sends heartbeats (no wait)', async () => {
    as(W)
    const done = await call('team_worker_done', { outcome: 'succeeded', summary: 'Fixed the total. Tests pass. Nothing left.', files: 'src/cart.js' })
    expect(done.isError).toBe(false)
    expect(text(done)).toMatch(/stop here and return to an idle prompt/)
    expect((await call('team_heartbeat', { phase: 'implementing', note: 'tests next' })).isError).toBe(false)
    expect((await call('team_heartbeat', { phase: 'napping' })).isError).toBe(true)
    expect((await call('team_worker_done', { summary: '' })).isError).toBe(true)
    const reqs = requests().map(({ file, fromId, ...r }) => ({ fromId, ...r }))
    expect(reqs).toEqual([
      { fromId: W.id, action: 'worker-done', outcome: 'succeeded', summary: 'Fixed the total. Tests pass. Nothing left.', files: ['src/cart.js'] },
      { fromId: W.id, action: 'heartbeat', phase: 'implementing', note: 'tests next' }
    ])
  })

  it('team_worker_list reads what Tessel published; team_gates lists the decisions', async () => {
    expect(text(await call('team_worker_list'))).toMatch(/No workers yet/)
    publishWorkers({
      dir,
      teamId,
      workers: [
        { id: 'w-1', handle: '#5', coordinator: '#1', title: 'Fix the cart', card: 'task-2-2', agent: 'codex', status: 'running', isolation: 'worktree', branch: 'agent/fix-the-cart', depth: 1, startedAt: Date.now(), heartbeatAt: Date.now(), phase: 'implementing' },
        { id: 'w-2', handle: null, coordinator: '#1', title: 'Docs', card: 'task-3-3', agent: 'claude', status: 'confirming', isolation: 'project', depth: 1 },
        { id: 'bad id!', status: 'running' }
      ],
      limits: { maxConcurrent: 4, maxDepth: 1, confirm: true },
      phases: { '#1': 'dispatching' }
    })
    const list = text(await call('team_worker_list'))
    expect(list).toMatch(/Limits: 4 workers at a time per coordinator, nesting depth 1, the user confirms each start\./)
    expect(list).toMatch(/Coordinator phase: #1: dispatching\./)
    expect(list).toMatch(/#5 "Fix the cart", worker of #1 {2}\[running; codex; own copy, branch agent\/fix-the-cart; card task-2-2; heartbeat just now \(implementing\)\]/)
    expect(list).toMatch(/\(not started\) "Docs", worker of #1 {2}\[confirming; claude; project folder; card task-3-3\]/)
    expect(list).not.toMatch(/bad id/)
    // Unchanged: not rewritten.
    expect(publishWorkers({ dir, teamId, workers: [], limits: null, phases: {} }).changed).toBe(true)
    expect(publishWorkers({ dir, teamId, workers: [], limits: null, phases: {} }).changed).toBe(false)

    expect(text(await call('team_gates'))).toMatch(/No decisions asked/)
    publishTeamTasks({
      dir,
      teamId,
      tasks: [
        { id: 'task-1-1', title: 'API', column: 'doing', gate: { question: 'Keep v1?', options: ['Keep', 'Drop'], status: 'pending' } },
        { id: 'task-2-2', title: 'UI', column: 'done', gate: { question: 'Dark mode?', options: [], status: 'resolved', answer: 'Yes' } }
      ]
    })
    const gates = text(await call('team_gates'))
    expect(gates).toMatch(/pending {3}task-1-1 "API": Keep v1\? \(choices: Keep \/ Drop\)/)
    expect(gates).toMatch(/resolved {2}task-2-2 "UI": Dark mode\? -> Yes/)
  })

  it('outside a team the worker tools refuse', async () => {
    writeCurrentTeams({ dir, panes: {} })
    const r = await call('team_worker_start', { agent: 'codex', task: 'X', brief: 'Y' })
    expect(r.isError).toBe(true)
  })

  it("Tessel's main process: answers only under a request id; requests validated", () => {
    expect(writeTeamAnswer({ dir, teamId, rid: '../evil', ok: true, text: 'x' }).ok).toBe(false)
    expect(writeTeamAnswer({ dir, teamId, rid: 'r-abc-123', ok: true, text: 'x' }).ok).toBe(true)
    expect(parseRequest({ action: 'worker-start', agent: 'codex', title: 'X', brief: 'Y' })).toMatchObject({ action: 'worker-start', isolation: 'worktree' })
    expect(parseRequest({ action: 'worker-start', agent: 'bash', title: 'X', brief: 'Y' }).error).toMatch(/agent/)
    expect(parseRequest({ action: 'heartbeat' })).toEqual({ action: 'heartbeat', phase: null, note: '' })
  })
})
