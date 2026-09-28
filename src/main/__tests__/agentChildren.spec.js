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
})
