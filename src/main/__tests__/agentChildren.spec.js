import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { claudeSubagents, summarizeTail } from '../agentChildren'

const SID = '11111111-2222-4333-8444-555555555555'
const line = (o) => JSON.stringify(o)

describe("a Claude Code conversation's sub-agents", () => {
  let claudeDir
  beforeEach(() => {
    claudeDir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-children-'))
  })
  afterEach(() => fs.rmSync(claudeDir, { recursive: true, force: true }))

  it('finished only when its last message ended the turn and nothing followed', () => {
    const a = { type: 'assistant', timestamp: '2026-09-28T10:05:00Z', message: { stop_reason: 'end_turn', usage: { input_tokens: 2, cache_read_input_tokens: 100000, cache_creation_input_tokens: 5000, output_tokens: 800 } } }
    expect(summarizeTail([line(a), line({ type: 'attachment', timestamp: '2026-09-28T10:05:01Z' })])).toEqual({ done: true, last: Date.parse('2026-09-28T10:05:01Z'), tokens: 105802 })
    const working = [line({ ...a, message: { ...a.message, stop_reason: 'tool_use' } }), line({ type: 'user', timestamp: '2026-09-28T10:06:00Z' })]
    expect(summarizeTail(working).done).toBe(false)
  })

  it('lists them with their title, type, state, times and tokens', () => {
    const dir = join(claudeDir, 'projects', 'C--proj', SID, 'subagents')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(claudeDir, 'projects', 'C--proj', `${SID}.jsonl`), '')
    const now = Date.parse('2026-09-28T10:10:00Z')
    fs.writeFileSync(join(dir, 'agent-aaa.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Fix the search box' }))
    fs.writeFileSync(
      join(dir, 'agent-aaa.jsonl'),
      [
        line({ type: 'user', timestamp: '2026-09-28T10:00:00Z' }),
        line({ type: 'assistant', timestamp: '2026-09-28T10:09:00Z', message: { stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 90 } } }),
        line({ type: 'user', timestamp: '2026-09-28T10:09:30Z' })
      ].join('\n') + '\n'
    )
    fs.writeFileSync(join(dir, 'agent-bbb.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Research Orca' }))
    fs.writeFileSync(
      join(dir, 'agent-bbb.jsonl'),
      [
        line({ type: 'user', timestamp: '2026-09-28T09:00:00Z' }),
        line({ type: 'assistant', timestamp: '2026-09-28T09:04:00Z', message: { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } })
      ].join('\n') + '\n'
    )
    const list = claudeSubagents(SID, claudeDir, now)
    expect(list.map((a) => [a.id, a.type, a.title, a.state, a.tokens])).toEqual([
      ['aaa', 'general-purpose', 'Fix the search box', 'running', 100],
      ['bbb', 'Explore', 'Research Orca', 'done', 2]
    ])
    expect(list[0].startedAt).toBe(Date.parse('2026-09-28T10:00:00Z'))
    expect(list[1].endedAt).toBe(Date.parse('2026-09-28T09:04:00Z'))
    expect(claudeSubagents('not-an-id', claudeDir)).toEqual([])
    expect(claudeSubagents('99999999-2222-4333-8444-555555555555', claudeDir)).toEqual([])
  })

  const event = (at, stop) =>
    line({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { stop_reason: stop, usage: { input_tokens: 1, output_tokens: 2 } } }) + '\n'

  it('an unfinished one silent for 16 min is quiet (not stopped, no end date)', () => {
    const dir = join(claudeDir, 'projects', 'C--proj', SID, 'subagents')
    fs.mkdirSync(dir, { recursive: true })
    const now = Date.parse('2026-09-28T10:30:00Z')
    const old = new Date(now - 16 * 60000)
    const file = join(dir, 'agent-slow.jsonl')
    fs.writeFileSync(file, event(old.getTime(), 'tool_use'))
    fs.utimesSync(file, old, old)
    const [c] = claudeSubagents(SID, claudeDir, now)
    expect(c.state).toBe('quiet')
    expect(c.endedAt).toBe(null)
    expect(c.lastAt).toBe(old.getTime())
  })

  describe('never reads outside the account folder through a link or junction', () => {
    let outside
    beforeEach(() => {
      outside = fs.mkdtempSync(join(os.tmpdir(), 'tessel-children-outside-'))
      const now = Date.now()
      fs.mkdirSync(join(outside, 'subagents'))
      for (const d of [outside, join(outside, 'subagents')]) {
        fs.writeFileSync(join(d, 'agent-foreign.jsonl'), event(now, 'end_turn'))
        fs.writeFileSync(join(d, 'agent-foreign.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'OUTSIDE' }))
      }
    })
    afterEach(() => fs.rmSync(outside, { recursive: true, force: true }))

    it('a junction for the subagents folder', () => {
      const session = join(claudeDir, 'projects', 'C--proj', SID)
      fs.mkdirSync(session, { recursive: true })
      fs.symlinkSync(outside, join(session, 'subagents'), 'junction')
      expect(claudeSubagents(SID, claudeDir)).toEqual([])
    })

    it('a junction for the session folder, the project folder or projects', () => {
      const project = join(claudeDir, 'projects', 'C--proj')
      fs.mkdirSync(project, { recursive: true })
      fs.symlinkSync(outside, join(project, SID), 'junction')
      expect(claudeSubagents(SID, claudeDir)).toEqual([])
      fs.rmSync(join(claudeDir, 'projects'), { recursive: true, force: true })
      const holder = join(outside, 'p')
      fs.mkdirSync(join(holder, SID), { recursive: true })
      fs.symlinkSync(join(outside, 'subagents'), join(holder, SID, 'subagents'), 'junction')
      fs.mkdirSync(join(claudeDir, 'projects'))
      fs.symlinkSync(holder, join(claudeDir, 'projects', 'C--proj'), 'junction')
      expect(claudeSubagents(SID, claudeDir)).toEqual([])
      fs.rmSync(join(claudeDir, 'projects'), { recursive: true, force: true })
      fs.mkdirSync(join(outside, 'projects', 'C--proj', SID), { recursive: true })
      fs.renameSync(join(outside, 'subagents'), join(outside, 'projects', 'C--proj', SID, 'subagents'))
      fs.symlinkSync(join(outside, 'projects'), join(claudeDir, 'projects'), 'junction')
      expect(claudeSubagents(SID, claudeDir)).toEqual([])
    })

    it('a linked transcript file (when this system allows file links)', () => {
      const dir = join(claudeDir, 'projects', 'C--proj', SID, 'subagents')
      fs.mkdirSync(dir, { recursive: true })
      try {
        fs.symlinkSync(join(outside, 'agent-foreign.jsonl'), join(dir, 'agent-foreign.jsonl'), 'file')
      } catch {
        return // no right to make file links here: nothing to check
      }
      expect(claudeSubagents(SID, claudeDir)).toEqual([])
    })
  })
})
