import { describe, it, expect } from 'vitest'
import { parseLeadRequest, findTaskRef, leadGuide } from '../../../shared/leadRequests'

describe('lead requests', () => {
  it('reads a task for a teammate or a new agent', () => {
    expect(parseLeadRequest({ action: 'task', title: ' Fix it ', brief: 'b', agent: '#3' })).toEqual({
      ok: true,
      action: 'task',
      title: 'Fix it',
      brief: 'b',
      num: 3,
      kind: null,
      ownCopy: true
    })
    expect(parseLeadRequest({ action: 'task', title: 'X', agent: 'Codex', own_copy: false })).toMatchObject({
      num: null,
      kind: 'codex',
      ownCopy: false
    })
    expect(parseLeadRequest({ action: 'task', title: 'X', agent: 2 }).num).toBe(2)
  })
  it('refuses incomplete or unknown requests', () => {
    expect(parseLeadRequest(null).ok).toBe(false)
    expect(parseLeadRequest([]).ok).toBe(false)
    expect(parseLeadRequest({ action: 'task', agent: '#1' }).error).toMatch(/title/)
    expect(parseLeadRequest({ action: 'task', title: 'x' }).error).toMatch(/agent/)
    expect(parseLeadRequest({ action: 'task', title: 'x', agent: 'rm -rf /' }).ok).toBe(false)
    expect(parseLeadRequest({ action: 'merge', task: 'x' }).error).toMatch(/unknown action/)
    expect(parseLeadRequest({ action: 'changes', task: 'x' }).error).toMatch(/text/)
    expect(parseLeadRequest({ action: 'message', to: 'bob', text: 'hi' }).ok).toBe(false)
  })
  it('reads messages, approvals and change requests', () => {
    expect(parseLeadRequest({ action: 'message', to: 'team', text: 'hi' })).toMatchObject({ ok: true, to: 'team' })
    expect(parseLeadRequest({ action: 'message', to: '#2', text: 'hi' })).toMatchObject({ ok: true, to: 'one', num: 2 })
    expect(parseLeadRequest({ action: 'APPROVE', task: 'Fix it', note: 'good' })).toMatchObject({ ok: true, action: 'approve', text: 'good' })
    expect(parseLeadRequest({ action: 'changes', task: 'Fix it', text: 'more' })).toMatchObject({ ok: true, action: 'changes' })
  })
  it('caps long text', () => {
    expect(parseLeadRequest({ action: 'message', to: 'team', text: 'x'.repeat(9000) }).text).toHaveLength(6000)
  })
  it('finds a task by id, then by title', () => {
    const tasks = [
      { id: 'task-1-1', title: 'Fix the header' },
      { id: 'task-2-2', title: 'Fix the footer' },
      { id: 'task-3-3', title: 'Docs' }
    ]
    expect(findTaskRef(tasks, 'task-2-2').task).toBe(tasks[1])
    expect(findTaskRef(tasks, 'fix the HEADER').task).toBe(tasks[0])
    expect(findTaskRef(tasks, 'Doc').task).toBe(tasks[2])
    expect(findTaskRef(tasks, 'Fix the').error).toMatch(/matches 2 tasks.*use the task id/)
    expect(findTaskRef(tasks, 'nothing')).toEqual({ error: null })
  })
  it('never picks one of two tasks with the same title', () => {
    const tasks = [
      { id: 'task-1-1', title: 'Fix tests' },
      { id: 'task-2-2', title: 'Fix tests' }
    ]
    const r = findTaskRef(tasks, 'Fix tests')
    expect(r.task).toBeUndefined()
    expect(r.error).toMatch(/task-1-1, task-2-2/)
    expect(findTaskRef(tasks, 'task-2-2').task).toBe(tasks[1])
  })
  it('explains the role', () => {
    const g = leadGuide({ teamName: 'Team 1', inbox: 'C:/p/.tessel/lead/abc', members: ['#2 Codex CLI'], kinds: ['codex', 'claude'] })
    expect(g).toMatch(/lead the team "Team 1"/)
    expect(g).toMatch(/C:\/p\/.tessel\/lead\/abc/)
    expect(g).toMatch(/"codex", "claude"/)
    expect(g).toMatch(/do not merge/)
  })
})

describe('team messages', () => {
  it('reads "to": "lead"', () => {
    expect(parseLeadRequest({ action: 'message', to: 'lead', text: 'done?' })).toMatchObject({ ok: true, to: 'lead' })
  })
  it('tells a member how to reach its teammates', async () => {
    const { memberGuide } = await import('../../../shared/leadRequests')
    const g = memberGuide({ teamName: 'Team 1', inbox: 'C:/p/.tessel/team/abc', me: '#4 Claude Code', members: ['#1 Codex CLI (codex)'], lead: '#1 Codex CLI' })
    expect(g).toMatch(/You are #4 Claude Code/)
    expect(g).toMatch(/#1 Codex CLI leads the team/)
    expect(g).toMatch(/team_inbox/)
    expect(g).toMatch(/team_send/)
    expect(g).toMatch(/Nothing is ever typed/)
    expect(g).toMatch(/do not ask the user to pass messages on/)
  })
})
