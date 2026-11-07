import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { isPromptLine, lastPromptBefore } from '../promptBefore.js'

const line = (o) => JSON.stringify(o)
const human = (text, extra = {}) => line({ type: 'user', uuid: 'u1', timestamp: '2026-11-06T18:00:00.000Z', message: { role: 'user', content: text }, origin: { kind: 'human' }, ...extra })

describe('isPromptLine: a Claude Code transcript line that is a prompt you typed', () => {
  it('another session\u2019s message (peer) starts a turn too: the view hides its answer, as it does in the window', () => {
    expect(isPromptLine(human('Another Claude session sent a message:\n[Tessel] 1 new message', { isMeta: true, origin: { kind: 'peer' } }))).toBe(true)
  })

  it('keeps your prompts, with or without an origin, and one queued while the agent worked', () => {
    expect(isPromptLine(human('fix the build'))).toBe(true)
    expect(isPromptLine(line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: {} }] } }))).toBe(true)
    expect(isPromptLine(line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'and the tests', origin: { kind: 'human' } } }))).toBe(true)
  })

  it('leaves out tool results, context, sub-agents, task notices, other sessions and queued notices', () => {
    expect(isPromptLine(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }))).toBe(false)
    expect(isPromptLine(human('<system-reminder>x</system-reminder>', { isMeta: true }))).toBe(false)
    expect(isPromptLine(human('sub', { isSidechain: true }))).toBe(false)
    expect(isPromptLine(human('<task-notification>done</task-notification>', { origin: { kind: 'task-notification' } }))).toBe(false)
    expect(isPromptLine(line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'x', isMeta: true, origin: { kind: 'peer' } } }))).toBe(false)
    expect(isPromptLine(line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: 'x', origin: { kind: 'task-notification' } } }))).toBe(false)
    expect(isPromptLine(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the file says "type":"user"' }] } }))).toBe(false)
    expect(isPromptLine(42)).toBe(false)
  })
})

describe('lastPromptBefore: the turn’s prompt before a window, read backwards', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-prompt-before-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const big = 'y'.repeat(50 * 1024)
  // A prompt, then a long turn of tool results, then the answer.
  const write = (name, { old = 1, tools = 60 } = {}) => {
    const parts = []
    for (let i = 0; i < old; i++) parts.push(human(`old prompt ${i}`), line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `old answer ${i}` }] } }))
    parts.push(human('the prompt of the long turn'))
    for (let i = 0; i < tools; i++) parts.push(line({ type: 'user', uuid: `r${i}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }] } }))
    const answerAt = parts.join('\n').length + 1
    parts.push(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] } }))
    const file = join(dir, name)
    fs.writeFileSync(file, parts.join('\n') + '\n')
    return { file, answerAt, promptAt: parts.slice(0, old * 2).join('\n').length + (old ? 1 : 0) }
  }

  it('finds the prompt several chunks back, from a window that starts at a line', async () => {
    const { file, answerAt } = write('a.jsonl')
    const found = await lastPromptBefore(file, answerAt, 64 * 1024 * 1024, { chunk: 64 * 1024 })
    expect(found).toBe(human('the prompt of the long turn'))
  })

  it('completes a line the window cut in the middle, and finds the prompt at the file’s start', async () => {
    const { file, answerAt } = write('b.jsonl', { old: 0 })
    // The window began inside the last tool result: that line is whole again, and skipped.
    const found = await lastPromptBefore(file, answerAt - 1000, 64 * 1024 * 1024, { chunk: 4096 })
    expect(found).toBe(human('the prompt of the long turn'))
    // The window began inside the prompt itself: still that prompt, whole.
    const cut = await lastPromptBefore(file, 20, 64 * 1024 * 1024, { chunk: 4096 })
    expect(cut).toBe(human('the prompt of the long turn'))
  })

  it('looks only from a start byte when given one: the growth since the last window', async () => {
    const { file, answerAt, promptAt } = write('d.jsonl', { old: 2 })
    // From the prompt's own start: found. From after it: nothing (the caller keeps what it had).
    expect(await lastPromptBefore(file, answerAt, 64 * 1024 * 1024, { chunk: 4096, stopAt: promptAt })).toBe(human('the prompt of the long turn'))
    expect(await lastPromptBefore(file, answerAt, 64 * 1024 * 1024, { chunk: 4096, stopAt: promptAt + 10 })).toBeNull()
    expect(await lastPromptBefore(file, answerAt, 1024, { stopAt: answerAt })).toBeNull()
  })

  it('gives up within its budget, and on a missing file, a window at 0 or a bad budget', async () => {
    const { file, answerAt } = write('c.jsonl')
    expect(await lastPromptBefore(file, answerAt, 100 * 1024, { chunk: 64 * 1024 })).toBeNull()
    expect(await lastPromptBefore(join(dir, 'none.jsonl'), 10, 1024)).toBeNull()
    expect(await lastPromptBefore(file, 0, 1024)).toBeNull()
    expect(await lastPromptBefore(file, answerAt, 0)).toBeNull()
  })
})
