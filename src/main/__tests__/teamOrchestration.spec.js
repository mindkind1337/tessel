import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRequire } from 'module'
import { ensureTeamChannel, pollTeamChannel } from '../teamChannel'
import { writeCurrentTeams } from '../teamNotices'
import { publishTeamTasks, takeTeamRequests, writeRoster, parseRequest } from '../teamTasks'

const require = createRequire(import.meta.url)
const mcp = require('../teamMcp/server.cjs')

describe('Orchestration through the team tools', () => {
  let dir
  const teamId = 'team-1'
  const A = { id: 'pane-1-aaaaaa', num: 1, title: 'Codex CLI' }
  const B = { id: 'pane-2-bbbbbb', num: 2, title: 'Claude Code' }
  const C = { id: 'pane-3-cccccc', num: 3, title: 'Codex CLI' }
  const as = (who) => (process.env.TESSEL_PANE_ID = who.id)
  const call = (name, args = {}) => mcp.handle({ id: 1, method: 'tools/call', params: { name, arguments: args } })
  const text = (r) => r.content[0].text
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-orch-'))
    ensureTeamChannel({ dir, teamId, members: [A, B, C] })
    writeCurrentTeams({
      dir,
      panes: { [A.id]: { team: teamId, num: 1 }, [B.id]: { team: teamId, num: 2 }, [C.id]: { team: teamId, num: 3 } }
    })
    as(B)
    process.env.TESSEL_PROJECT_DIR = dir
  })
  afterEach(() => {
    delete process.env.TESSEL_PANE_ID
    delete process.env.TESSEL_PROJECT_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('cards that wait for others, reports and decisions go to Tessel as requests', () => {
    expect(call('team_task_add', { title: 'UI', assignee: '#1', after: ['task-1-1', 'task-2-2'] }).isError).toBe(false)
    expect(call('team_task_add', { title: 'x', after: 'bad id!' }).isError).toBe(true)
    expect(call('team_task_done', { id: 'task-1-1', summary: 'Did the API. Tests pass.', files: 'a.js, b.js' }).isError).toBe(false)
    expect(call('team_task_done', { id: 'task-1-1', outcome: 'maybe', summary: 'x' }).isError).toBe(true)
    expect(call('team_task_done', { id: 'task-1-1' }).isError).toBe(true)
    expect(call('team_task_gate', { id: 'task-1-1', question: 'Keep the old API?', options: ['Keep', 'Drop'] }).isError).toBe(false)
    const reqs = takeTeamRequests({ dir, teamId }).requests.map(({ file, fromId, ...r }) => r)
    expect(reqs).toEqual([
      { action: 'add', title: 'UI', assignee: '#1', column: 'todo', deps: ['task-1-1', 'task-2-2'] },
      { action: 'report', id: 'task-1-1', outcome: 'succeeded', summary: 'Did the API. Tests pass.', files: ['a.js', 'b.js'] },
      { action: 'gate', id: 'task-1-1', question: 'Keep the old API?', options: ['Keep', 'Drop'] }
    ])
    expect(parseRequest({ action: 'add', title: 'x', deps: ['../x'] }).error).toMatch(/after/)
    expect(parseRequest({ action: 'report', id: 'task-1', summary: '' }).error).toMatch(/summary/)
  })

  it('team_tasks shows what a card waits for, the decision asked and the report', () => {
    publishTeamTasks({
      dir,
      teamId,
      tasks: [
        { id: 'task-1-1', title: 'API', column: 'done', assignee: '#2', report: { outcome: 'succeeded', summary: 'Done it', files: [] } },
        { id: 'task-2-2', title: 'UI', column: 'todo', assignee: '#1', deps: ['task-1-1', 'task-3-3'], waitingOn: ['task-3-3'] },
        { id: 'task-3-3', title: 'Copy', column: 'doing', assignee: '#3', gate: { question: 'Which tone?', options: [], status: 'pending' } }
      ]
    })
    const t = text(call('team_tasks'))
    expect(t).toContain('task-2-2  UI  (#1)  [waits for task-3-3]')
    expect(t).toContain("[waits for the user's decision: Which tone?]")
    expect(t).toContain('[succeeded: Done it]')
  })

  it('groups: by agent, idle ones, everyone; never myself', () => {
    expect(text(call('team_send', { to: '@codex', text: 'hi' }))).toMatch(/has not said yet/)
    writeRoster({
      dir,
      teamId,
      members: {
        [A.id]: { agent: 'codex', model: 'GPT-5.5 · high', state: 'working' },
        [B.id]: { agent: 'claude', model: 'Opus 5.5', state: 'idle' },
        [C.id]: { agent: 'codex', model: null, state: 'idle' }
      }
    })
    expect(text(call('team_send', { to: '@codex', text: 'to codex' }))).toBe('Sent to #1, #3. Tessel delivers it in the background.')
    expect(text(call('team_send', { to: '@idle', text: 'to idle' }))).toBe('Sent to #3. Tessel delivers it in the background.')
    expect(text(call('team_send', { to: '@all', text: 'to all' }))).toBe('Sent to #1, #3. Tessel delivers it in the background.')
    expect(call('team_send', { to: '@gemini', text: 'x' }).isError).toBe(true)
    pollTeamChannel({ dir, teamId })
    const state = JSON.parse(fs.readFileSync(join(dir, '.tessel', 'team-channel', teamId, 'state.json'), 'utf8'))
    const got = (m) => state.messages.filter((x) => x.text === m).map((x) => x.toId).sort()
    expect(got('to codex')).toEqual([A.id, C.id])
    expect(got('to idle')).toEqual([C.id])
    expect(got('to all')).toEqual([A.id, C.id])
    // The worker list: agent, model, state, open cards.
    publishTeamTasks({ dir, teamId, tasks: [{ id: 'task-9-9', title: 'X', column: 'doing', assignee: '#1' }] })
    expect(text(call('team_members'))).toContain('#1 Codex CLI [codex, GPT-5.5 · high, working], cards: task-9-9')
  })

  it('team_ask waits for the answer to its question', async () => {
    const asking = call('team_ask', { to: '#1', question: 'Are you editing pty.js?', options: ['Yes', 'No'], wait_seconds: 20 })
    // Tessel takes the question in; #1 answers it.
    const answer = (async () => {
      for (let i = 0; i < 40; i++) {
        pollTeamChannel({ dir, teamId })
        const state = JSON.parse(fs.readFileSync(join(dir, '.tessel', 'team-channel', teamId, 'state.json'), 'utf8'))
        const q = state.messages.find((m) => m.toId === A.id && m.askId)
        if (q) {
          expect(q.text).toMatch(/QUESTION, #2 Claude Code waits for your answer/)
          expect(q.text).toMatch(/Choices: Yes \/ No/)
          as(A)
          mcp.send(mcp.locate(), '#2', 'No, go ahead.', q.id)
          as(B)
          pollTeamChannel({ dir, teamId })
          return
        }
        await new Promise((r) => setTimeout(r, 100))
      }
    })()
    await answer
    const r = await asking
    expect(r.isError).toBe(false)
    expect(text(r)).toMatch(/^Answer from #1 Codex CLI \(message .+\): No, go ahead\.$/)
  }, 30000)

  it('team_ask: only the teammate asked answers; a cancelled wait leaves the answer unread', async () => {
    const control = new AbortController()
    const asking = mcp.handle({ id: 7, method: 'tools/call', params: { name: 'team_ask', arguments: { to: '#1', question: 'Q?', wait_seconds: 20 } } }, control.signal)
    let q = null
    for (let i = 0; i < 40 && !q; i++) {
      pollTeamChannel({ dir, teamId })
      const state = JSON.parse(fs.readFileSync(join(dir, '.tessel', 'team-channel', teamId, 'state.json'), 'utf8'))
      q = state.messages.find((m) => m.toId === A.id && m.askId)
      if (!q) await new Promise((r) => setTimeout(r, 100))
    }
    // #3 replies to it: not the answer.
    as(C)
    mcp.send(mcp.locate(), '#2', 'I am not #1.', q.id)
    as(B)
    pollTeamChannel({ dir, teamId })
    await new Promise((r) => setTimeout(r, 1500))
    // The agent cancels its call; then #1 answers: left for team_inbox.
    control.abort()
    as(A)
    mcp.send(mcp.locate(), '#2', 'Yes from #1.', q.id)
    as(B)
    pollTeamChannel({ dir, teamId })
    const r = await asking
    expect(text(r)).toBe('Cancelled.')
    const inbox = mcp.readInbox(mcp.locate())
    expect(inbox).toContain('I am not #1.')
    expect(inbox).toContain('Yes from #1.')
  }, 30000)

  it('team_ask: Tessel slow to take the question in is not "not asked"', async () => {
    // Nobody polls the channel: the question waits in the outbox.
    const r = await call('team_ask', { to: '#1', question: 'Slow?', wait_seconds: 5 })
    expect(r.isError).toBe(false)
    expect(text(r)).toMatch(/No answer yet after 5 s\. The question stays open/)
  }, 30000)

  it('team_ask: no answer in time keeps the question open; a question to nobody is refused', async () => {
    const asking = call('team_ask', { to: '#1', question: 'Ready?', wait_seconds: 5 })
    setTimeout(() => pollTeamChannel({ dir, teamId }), 300)
    const r = await asking
    expect(text(r)).toMatch(/No answer yet after 5 s\. The question stays open: wait again with team_ask \{"resume":"q-/)
    const qid = /"resume":"(q-[a-z0-9-]+)"/.exec(text(r))[1]
    // Resumed: the answer that came meanwhile is found, nothing asked again.
    const state = JSON.parse(fs.readFileSync(join(dir, '.tessel', 'team-channel', teamId, 'state.json'), 'utf8'))
    const q = state.messages.find((m) => m.askId === qid)
    as(A)
    mcp.send(mcp.locate(), '#2', 'Yes.', q.id)
    as(B)
    pollTeamChannel({ dir, teamId })
    expect(text(await call('team_ask', { resume: qid, wait_seconds: 5 }))).toMatch(/: Yes\.$/)
    const again = JSON.parse(fs.readFileSync(join(dir, '.tessel', 'team-channel', teamId, 'state.json'), 'utf8'))
    expect(again.messages.filter((m) => m.askId === qid && m.fromId === B.id)).toHaveLength(1)

    const nobody = call('team_ask', { to: '#9', question: 'Hello?', wait_seconds: 5 })
    setTimeout(() => pollTeamChannel({ dir, teamId }), 300)
    const refused = await nobody
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/The question was not sent: .*not an active teammate/)
  }, 30000)
})
