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
import { publishTeamTasks, takeTeamRequests, finishTeamRequests, writeTeamAnswer, publishWorkers, parseRequest, releaseTeamRequests } from '../teamTasks'
import { setTeamSecret, newTeamSecret, revokeTeamSecret, _resetTeamAuth, openAnswer } from '../teamAuth'

const require = createRequire(import.meta.url)
const mcp = require('../teamMcp/server.cjs')

describe('worker tools', () => {
  let dir
  const teamId = 'team-1'
  const LEAD = { id: 'pane-1-aaaaaa', num: 1, title: 'Claude Code' }
  const W = { id: 'pane-5-bbbbbb', num: 5, title: 'Codex CLI' }
  const secrets = {}
  // Each pane's own secret, as Tessel gives it at launch (env + main memory).
  const as = (who) => {
    process.env.TESSEL_PANE_ID = who.id
    process.env.TESSEL_TEAM_SECRET = secrets[who.id]
  }
  const call = (name, args = {}) => mcp.handle({ id: 1, method: 'tools/call', params: { name, arguments: args } })
  const text = (r) => r.content[0].text
  const requests = () => takeTeamRequests({ dir, teamId }).requests
  // Tessel's side: answer every request that waits, then remove the files.
  async function tesselAnswers(answer) {
    for (let i = 0; i < 40; i++) {
      const reqs = requests()
      if (reqs.length) {
        for (const r of reqs) if (r.rid) writeTeamAnswer({ dir, teamId, rid: r.rid, toId: r.fromId, ...answer(r) })
        finishTeamRequests({ dir, teamId, files: reqs.map((r) => r.file) })
        return reqs
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return []
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-workers-'))
    for (const p of [LEAD, W]) {
      secrets[p.id] = newTeamSecret()
      setTeamSecret(p.id, secrets[p.id])
    }
    ensureTeamChannel({ dir, teamId, members: [LEAD, W] })
    writeCurrentTeams({ dir, panes: { [LEAD.id]: { team: teamId, num: 1 }, [W.id]: { team: teamId, num: 5 } } })
    as(LEAD)
    process.env.TESSEL_PROJECT_DIR = dir
  })
  afterEach(() => {
    delete process.env.TESSEL_PANE_ID
    delete process.env.TESSEL_PROJECT_DIR
    delete process.env.TESSEL_TEAM_SECRET
    _resetTeamAuth()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('the tools are listed with their schemas', () => {
    const tools = Object.fromEntries(mcp.TOOLS.map((t) => [t.name, t]))
    expect(tools.team_worker_start.inputSchema.required).toEqual(['agent', 'task', 'brief'])
    expect(tools.team_worker_start.inputSchema.properties.agent.enum).toEqual(['claude', 'codex', 'gemini', 'qwen', 'opencode'])
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
    expect(mcp.VERSION).toBe('1.11.5')
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
    expect(writeTeamAnswer({ dir, teamId, rid: '../evil', ok: true, text: 'x', toId: LEAD.id }).ok).toBe(false)
    expect(writeTeamAnswer({ dir, teamId, rid: 'r-abc-123', ok: true, text: 'x', toId: LEAD.id }).ok).toBe(true)
    // Nobody to seal it for: nothing written.
    expect(writeTeamAnswer({ dir, teamId, rid: 'r-abc-124', ok: true, text: 'x', toId: 'pane-9-nobody' }).ok).toBe(false)
    expect(parseRequest({ action: 'worker-start', agent: 'codex', title: 'X', brief: 'Y' })).toMatchObject({ action: 'worker-start', isolation: 'worktree' })
    expect(parseRequest({ action: 'worker-start', agent: 'bash', title: 'X', brief: 'Y' }).error).toMatch(/agent/)
    expect(parseRequest({ action: 'heartbeat' })).toEqual({ action: 'heartbeat', phase: null, note: '' })
  })

  // --- Codex review of d370980: who really sent it ------------------------------
  const reqDir = () => join(dir, '.tessel', 'team-channel', teamId, 'requests')
  const drop = (name, data) => {
    fs.mkdirSync(reqDir(), { recursive: true })
    fs.writeFileSync(join(reqDir(), name), JSON.stringify(data))
  }

  it('a request file named after the lead but not signed by it is refused', () => {
    drop(`${LEAD.id}__forged1.json`, { action: 'worker-stop', worker: '#5', rid: 'r-forged-0001' })
    // Signed with another pane's secret while claiming to be the lead: refused too.
    as(W)
    const ctx = { ...mcp.locate(), meId: LEAD.id }
    mcp.taskRequest(ctx, { action: 'worker-stop', worker: '#5' })
    const res = takeTeamRequests({ dir, teamId })
    expect(res.requests).toEqual([])
    const errors = res.refused.map((r) => r.error)
    expect(errors).toHaveLength(2)
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/not signed by its pane/), expect.stringMatching(/signature does not match its pane/)]))
  })

  it('a signed request is accepted once: a copy under a new name is a replay; another team, a mismatch', async () => {
    const stopping = call('team_worker_stop', { worker: '#5' })
    await new Promise((r) => setTimeout(r, 50))
    const [name] = fs.readdirSync(reqDir())
    const signed = JSON.parse(fs.readFileSync(join(reqDir(), name), 'utf8'))
    // The secret itself is never in the file.
    expect(JSON.stringify(signed)).not.toContain(secrets[LEAD.id])
    expect(signed.auth).toMatchObject({ nonce: expect.any(String), at: expect.any(Number), mac: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const first = takeTeamRequests({ dir, teamId })
    expect(first.requests.map((r) => r.action)).toEqual(['worker-stop'])
    expect(first.requests[0].auth).toBeUndefined()
    writeTeamAnswer({ dir, teamId, rid: first.requests[0].rid, toId: LEAD.id, ok: true, text: 'Stopped.' })
    finishTeamRequests({ dir, teamId, files: [name] })
    expect(text(await stopping)).toBe('Stopped.')
    drop(`${LEAD.id}__copy2.json`, signed)
    expect(takeTeamRequests({ dir, teamId }).refused[0].error).toMatch(/already used \(a replay\)/)
    // The same signature presented in another team's folder.
    const other = 'team-2'
    ensureTeamChannel({ dir, teamId: other, members: [LEAD] })
    fs.mkdirSync(join(dir, '.tessel', 'team-channel', other, 'requests'), { recursive: true })
    fs.writeFileSync(
      join(dir, '.tessel', 'team-channel', other, 'requests', `${LEAD.id}__x3.json`),
      JSON.stringify({ ...signed, auth: { ...signed.auth, nonce: 'n-another-nonce-1234' } })
    )
    expect(takeTeamRequests({ dir, teamId: other }).refused[0].error).toMatch(/does not match/)
  }, 20000)

  it('an old request is refused', () => {
    as(LEAD)
    const ctx = mcp.locate()
    const realNow = Date.now
    Date.now = () => realNow() - 60 * 60 * 1000
    try {
      mcp.taskRequest(ctx, { action: 'heartbeat', phase: null, note: '' })
    } finally {
      Date.now = realNow
    }
    expect(takeTeamRequests({ dir, teamId }).refused[0].error).toMatch(/too old/)
  })

  it('answers are sealed for the requester: a fabricated answer is ignored, other agents cannot read it', async () => {
    const reading = call('team_worker_read', { worker: '#5' })
    await new Promise((r) => setTimeout(r, 50))
    const [req] = takeTeamRequests({ dir, teamId }).requests
    const folder = join(dir, '.tessel', 'team-channel', teamId, 'answers')
    const file = join(folder, `${req.rid}.json`)
    fs.mkdirSync(folder, { recursive: true })
    // Another agent writes a plain answer, then one sealed for another pane.
    fs.writeFileSync(file, JSON.stringify({ rid: req.rid, ok: true, text: 'forged fixture answer' }))
    await new Promise((r) => setTimeout(r, 700))
    setTeamSecret('pane-evil', newTeamSecret())
    writeTeamAnswer({ dir, teamId, rid: req.rid, toId: 'pane-evil', ok: true, text: 'forged sealed answer' })
    await new Promise((r) => setTimeout(r, 700))
    // Tessel's real answer, sealed for the lead.
    writeTeamAnswer({ dir, teamId, rid: req.rid, toId: LEAD.id, ok: true, text: 'Its screen now: SECRET-OUTPUT' })
    const onDisk = fs.readFileSync(file, 'utf8')
    expect(onDisk).not.toContain('SECRET-OUTPUT')
    expect(openAnswer(secrets[W.id], LEAD.id, req.rid, JSON.parse(onDisk).sealed)).toBeNull()
    expect(text(await reading)).toBe('Its screen now: SECRET-OUTPUT')
  }, 20000)

  it('without its pane secret an agent cannot use the worker tools; its old unsigned board requests still work', async () => {
    const OLD = { id: 'pane-7-oldold', num: 7, title: 'Old' }
    ensureTeamChannel({ dir, teamId, members: [LEAD, W, OLD] })
    writeCurrentTeams({ dir, panes: { [LEAD.id]: { team: teamId, num: 1 }, [W.id]: { team: teamId, num: 5 }, [OLD.id]: { team: teamId, num: 7 } } })
    process.env.TESSEL_PANE_ID = OLD.id
    delete process.env.TESSEL_TEAM_SECRET
    const r = await call('team_worker_start', { agent: 'codex', task: 'X', brief: 'Y' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/team secret: restart it/)
    expect((await call('team_worker_list')).isError).toBe(false)
    expect((await call('team_task_add', { title: 'legacy card' })).isError).toBe(false)
    expect(takeTeamRequests({ dir, teamId }).requests.map((x) => x.title)).toEqual(['legacy card'])
    // A pane that has a secret here never gets unsigned requests through.
    drop(`${W.id}__unsigned.json`, { action: 'add', title: 'sneaky' })
    expect(takeTeamRequests({ dir, teamId }).refused[0].error).toMatch(/not signed/)
  })

  it('a closed pane loses its secret; a relaunch replaces it', () => {
    as(LEAD)
    const ctx = mcp.locate()
    revokeTeamSecret(LEAD.id)
    mcp.taskRequest(ctx, { action: 'heartbeat', phase: null, note: '' })
    expect(takeTeamRequests({ dir, teamId }).refused[0].error).toMatch(/no team secret/)
    setTeamSecret(LEAD.id, newTeamSecret()) // relaunched: the old agent's secret is void
    mcp.taskRequest(ctx, { action: 'heartbeat', phase: null, note: '' })
    expect(takeTeamRequests({ dir, teamId }).refused[0].error).toMatch(/does not match/)
  })

  // Codex's recheck of 8a004e6 ("unfinishedPoll"): a round can be abandoned
  // after reading requests and before applying them.
  it('a signed request read again before it is finished is returned again, not taken for a replay', () => {
    as(LEAD)
    mcp.taskRequest(mcp.locate(), { action: 'heartbeat', phase: null, note: '' })
    const [name] = fs.readdirSync(reqDir())
    const signed = fs.readFileSync(join(reqDir(), name), 'utf8')
    const first = takeTeamRequests({ dir, teamId })
    const second = takeTeamRequests({ dir, teamId })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
    expect(second.refused).toEqual([])
    expect(fs.existsSync(join(reqDir(), name))).toBe(true)
    // While it is reserved: the same nonce in another file, or the same file
    // with other content, is a replay.
    fs.writeFileSync(join(reqDir(), `${LEAD.id}__copy-1.json`), signed)
    let res = takeTeamRequests({ dir, teamId })
    expect(res.requests.map((r) => r.file)).toEqual([name])
    expect(res.refused.map((r) => r.error)).toEqual([expect.stringMatching(/a replay/)])
    const tampered = JSON.parse(signed)
    tampered.note = 'changed'
    fs.writeFileSync(join(reqDir(), name), JSON.stringify(tampered))
    res = takeTeamRequests({ dir, teamId })
    expect(res.requests).toEqual([])
    expect(res.refused[0].error).toMatch(/does not match|a replay/)
    // Put back as it was, released by an abandoned round, then finished: spent.
    fs.writeFileSync(join(reqDir(), name), signed)
    releaseTeamRequests({ dir, teamId, files: [name] })
    expect(takeTeamRequests({ dir, teamId }).requests.map((r) => r.file)).toEqual([name])
    expect(finishTeamRequests({ dir, teamId, files: [name] }).removed).toEqual([name])
    fs.writeFileSync(join(reqDir(), name), signed)
    res = takeTeamRequests({ dir, teamId })
    expect(res.requests).toEqual([])
    expect(res.refused[0].error).toMatch(/a replay/)
  })

  it('same nonce, other content, same file name: refused even with a valid MAC of another request', () => {
    as(LEAD)
    mcp.taskRequest(mcp.locate(), { action: 'heartbeat', phase: 'implementing', note: '' })
    const [name] = fs.readdirSync(reqDir())
    const a = JSON.parse(fs.readFileSync(join(reqDir(), name), 'utf8'))
    expect(takeTeamRequests({ dir, teamId }).requests).toHaveLength(1)
    // Another request signed by the lead that reuses a's nonce (a buggy or
    // hostile writer): its MAC is right, but the nonce belongs to a's file.
    const { auth, ...body } = a
    const b = { ...body, phase: 'reviewing' }
    const { requestMac } = require('../teamAuth')
    const mac = requestMac(secrets[LEAD.id], LEAD.id, teamId, { ...b, nonce: auth.nonce, at: auth.at })
    fs.writeFileSync(join(reqDir(), name), JSON.stringify({ ...b, auth: { ...auth, mac } }))
    const res = takeTeamRequests({ dir, teamId })
    expect(res.requests).toEqual([])
    expect(res.refused[0].error).toMatch(/a replay/)
  })
})
