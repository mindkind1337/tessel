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
  it('appends and reads back events with their seq, skipping deltas', () => {
    const j = createChatJournal({ dir: tmp, paneId: 'p1', now: () => 7 })
    j.append(1, { type: 'user', id: 'u', text: 'hi' })
    j.append(2, { type: 'assistantDelta', messageId: 'm', text: 'h' })
    j.append(3, { type: 'assistant', messageId: 'm', text: 'hello' })
    expect(j.read()).toEqual([
      { seq: 1, event: { type: 'user', id: 'u', text: 'hi' } },
      { seq: 3, event: { type: 'assistant', messageId: 'm', text: 'hello' } }
    ])
    expect(j.lastSeq()).toBe(3)
    expect(fs.existsSync(join(tmp, 'chats', 'p1', 'journal.jsonl'))).toBe(true)
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
