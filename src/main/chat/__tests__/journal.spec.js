// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createChatJournal, clipString, validPaneId, CLIP_BYTES } from '../journal'

let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-chat-journal-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('chat journal', () => {
  it('clips question and answer text while retaining ordinary 8 KiB answers exactly', () => {
    const j = createChatJournal({ dir: tmp, paneId: 'p1' })
    const big = 'x'.repeat(CLIP_BYTES * 3)
    j.append(1, { type: 'question', requestId: 'r', questions: [{ id: 'q', question: big, options: [{ id: 'o', label: big }] }] })
    j.append(2, { type: 'questionStatus', requestId: 'r', status: 'answered', answers: [{ questionId: 'q', optionIds: [], other: big }] })
    const exact = 'é'.repeat(CLIP_BYTES / 2)
    j.append(3, { type: 'questionStatus', requestId: 'r2', status: 'answered', answers: [{ questionId: 'q', optionIds: [], other: exact }] })
    const rows = j.read().map(row => row.event)
    expect(rows[0].questions[0].question).toBe(clipString(big))
    expect(rows[0].questions[0].options[0].label).toBe(clipString(big))
    expect(rows[1].answers[0].other).toBe(clipString(big))
    expect(rows[2].answers[0].other).toBe(exact)
  })
  it('preserves the latest full command snapshot after journal rotation and restart', () => {
    const j = createChatJournal({ dir: tmp, paneId: 'p1', rotateBytes: 150 })
    const commands = [{ name: 'review', kind: 'skill', description: 'Inspect' }]
    j.append(1, { type: 'commands', commands })
    for (let i = 2; i < 20; i++) j.append(i, { type: 'assistant', messageId: String(i), text: 'x'.repeat(100) })
    expect(j.read().some(row => row.event.type === 'commands')).toBe(false)
    const reopened = createChatJournal({ dir: tmp, paneId: 'p1' })
    expect(reopened.readCommands()).toEqual(commands)
    reopened.append(20, { type: 'commands', commands: [] })
    expect(reopened.readCommands()).toEqual([])
  })

  it('appends and reads back events with their seq and write time, skipping deltas', () => {
    const j = createChatJournal({ dir: tmp, paneId: 'p1', now: () => 7 })
    j.append(1, { type: 'user', id: 'u', text: 'hi' })
    j.append(2, { type: 'assistantDelta', messageId: 'm', text: 'h' })
    j.append(3, { type: 'assistant', messageId: 'm', text: 'hello' })
    expect(j.read()).toEqual([
      { seq: 1, at: 7, event: { type: 'user', id: 'u', text: 'hi' } },
      { seq: 3, at: 7, event: { type: 'assistant', messageId: 'm', text: 'hello' } }
    ])
    expect(j.lastSeq()).toBe(3)
    expect(fs.existsSync(join(tmp, 'chats', 'p1', 'journal.jsonl'))).toBe(true)
  })

  it("does not keep a sub-agent's tool-level progress, only its roster and lifecycle", () => {
    const j = createChatJournal({ dir: tmp, paneId: 'p1', now: () => 7 })
    j.append(1, { type: 'subagent', phase: 'start', id: 'c', groupId: 'g', status: 'working' })
    j.append(2, { type: 'subagent', phase: 'progress', id: 'c', groupId: 'g', status: 'working', tool: { id: 't', name: 'Read', status: 'running' } })
    j.append(3, { type: 'subagent', phase: 'progress', id: 'c', groupId: 'g', status: 'working', model: 'm' })
    j.append(4, { type: 'subagents', groupId: 'g', agents: [] })
    j.append(5, { type: 'subagent', phase: 'end', id: 'c', groupId: 'g', status: 'completed' })
    expect(j.read().map((r) => r.seq)).toEqual([1, 3, 4, 5])
  })

  it('clips strings in tool input and results to 8 KB', () => {
    const j = createChatJournal({ dir: tmp, paneId: 'p1' })
    const big = 'x'.repeat(CLIP_BYTES * 3)
    j.append(1, { type: 'tool', id: 't', name: 'Write', input: { content: big, nested: [{ s: big }] }, status: 'running' })
    j.append(2, { type: 'toolResult', id: 't', isError: false, text: big })
    const [tool, result] = j.read()
    expect(tool.event.input.content.length).toBeLessThan(CLIP_BYTES + 40)
    expect(tool.event.input.content).toMatch(/… \(16384 more bytes\)$/)
    expect(tool.event.input.nested[0].s.length).toBeLessThan(CLIP_BYTES + 40)
    expect(result.event.text.length).toBeLessThan(CLIP_BYTES + 40)
    expect(clipString('é'.repeat(CLIP_BYTES))).not.toContain('\uFFFD')
  })

  it('rotates past the size limit and still reads across both files', () => {
    const j = createChatJournal({ dir: tmp, paneId: 'p1', rotateBytes: 400 })
    for (let i = 1; i <= 12; i++) j.append(i, { type: 'assistant', messageId: `m${i}`, text: 'y'.repeat(50) })
    const folder = join(tmp, 'chats', 'p1')
    expect(fs.existsSync(join(folder, 'journal.1.jsonl'))).toBe(true)
    expect(fs.statSync(join(folder, 'journal.jsonl')).size).toBeLessThanOrEqual(400)
    const seqs = j.read().map((e) => e.seq)
    expect(seqs[seqs.length - 1]).toBe(12)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(j.read(3).map((e) => e.seq)).toEqual([10, 11, 12])
  })

  it('readTail: the last events from the end of the file, across a rotation, as read() gives them', () => {
    const j = createChatJournal({ dir: tmp, paneId: 'p1', rotateBytes: 4000 })
    for (let i = 1; i <= 120; i++) j.append(i, { type: 'user', id: 'u' + i, text: 'é'.repeat(i % 7) + ' message ' + i })
    expect(fs.existsSync(join(tmp, 'chats', 'p1', 'journal.1.jsonl'))).toBe(true)
    const all = j.read()
    for (const n of [1, 5, 30, all.length, all.length + 50]) expect(j.readTail(n)).toEqual(all.slice(-n))
    expect(j.lastSeq()).toBe(120)
    // A line cut by a crash at the end, and a damaged one in the middle: skipped.
    const file = join(tmp, 'chats', 'p1', 'journal.jsonl')
    fs.appendFileSync(file, '{"seq":999,"event":{"ty')
    expect(j.readTail(2).map((x) => x.seq)).toEqual([119, 120])
    expect(createChatJournal({ dir: tmp, paneId: 'none' }).readTail(5)).toEqual([])
  })

  it('readTail reads chunk by chunk (a long journal)', () => {
    const j = createChatJournal({ dir: tmp, paneId: 'p2' })
    const long = 'x'.repeat(5000)
    for (let i = 1; i <= 60; i++) j.append(i, { type: 'assistant', messageId: 'm' + i, text: long + i })
    expect(j.readTail(3).map((x) => x.seq)).toEqual([58, 59, 60])
    expect(j.readTail(3).at(-1).event.text).toBe(long + 60)
  })

  it('skips damaged lines', () => {
    const j = createChatJournal({ dir: tmp, paneId: 'p1' })
    j.append(1, { type: 'notice', kind: 'info', text: 'a' })
    fs.appendFileSync(join(tmp, 'chats', 'p1', 'journal.jsonl'), '{"seq":2,"ev\n')
    j.append(3, { type: 'notice', kind: 'info', text: 'b' })
    expect(j.read().map((e) => e.seq)).toEqual([1, 3])
  })

  it('meta round trip', () => {
    const j = createChatJournal({ dir: tmp, paneId: 'p1' })
    expect(j.readMeta()).toBe(null)
    j.writeMeta({ sessionId: 's', agent: 'claude', cwd: 'C:\\x', extra: 1 })
    expect(j.readMeta()).toEqual({ sessionId: 's', agent: 'claude', cwd: 'C:\\x' })
  })

  it('refuses pane ids that could leave its folder', () => {
    for (const bad of ['..', '.', 'a/b', 'a\\b', '', 'x'.repeat(101), '..x']) expect(validPaneId(bad)).toBe(false)
    expect(() => createChatJournal({ dir: tmp, paneId: '..' })).toThrow()
    expect(validPaneId('pane-1.2_x')).toBe(true)
  })
})
