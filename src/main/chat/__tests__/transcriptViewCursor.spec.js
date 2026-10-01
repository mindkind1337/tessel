// @vitest-environment node
// Cursor CLI's conversation in a terminal pane's chat view: hand-made files in
// the shapes its transcripts have (no real agent folder, no real text).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { TRANSCRIPT_VIEW_AGENTS, cursorViewEvents, findTranscriptViewFile, readTranscriptView, transcriptViewRoots, validViewId } from '../transcriptView'

const ID = '0a1b2c3d-1111-4222-8333-444455556666'
const OTHER = '9f8e7d6c-1111-4222-8333-444455556666'
const lines = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'
const user = (text) => ({ role: 'user', message: { content: [{ type: 'text', text } ] } })
const step = (...content) => ({ role: 'assistant', message: { content } })
const text = (t) => ({ type: 'text', text: t })
const tool = (name, input) => ({ type: 'tool_use', name, input })

let tmp
let roots
beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tview-cursor-'))
  roots = transcriptViewRoots(tmp, {})
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function cursorFile(content, { id = ID, folder = 'C-proj', legacy = false } = {}) {
  const dir = legacy ? join(roots.cursor, folder, 'agent-transcripts') : join(roots.cursor, folder, 'agent-transcripts', id)
  fs.mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, content)
  return file
}

describe('Cursor in the transcript view', () => {
  it('is a transcript view agent with UUID conversation ids, under ~/.cursor/projects', () => {
    expect(TRANSCRIPT_VIEW_AGENTS).toContain('cursor')
    expect(validViewId('cursor', ID)).toBe(true)
    expect(validViewId('cursor', 'abc123')).toBe(false)
    expect(validViewId('cursor', '../x')).toBe(false)
    expect(roots.cursor).toBe(join(tmp, '.cursor', 'projects'))
  })
})

describe('cursorViewEvents', () => {
  it('prompts without their envelope, steps as messages, tools closed by the next line, turn ends', () => {
    const events = cursorViewEvents(
      lines([
        user('<timestamp>Monday</timestamp>\n<user_query>\nFirst question\n</user_query>'),
        step(text('Looking.\n\n[REDACTED]'), tool('Read', { path: 'a.js' }), tool('Grep', { pattern: 'x', path: '.' })),
        step(text('[REDACTED]'), tool('Shell', { command: 'ls', description: 'list' })),
        step(text('Done here.')),
        { type: 'turn_ended', status: 'success' },
        user('[Image]\n<image_files>\nThe user attached an image.\n1. img.png\n</image_files>\n<user_query>\nAnd this?\n</user_query>'),
        step(text('Stopped early.')),
        { type: 'turn_ended', status: 'aborted', error: 'Aborted by user' },
        user('<user_query>Third</user_query>'),
        { type: 'turn_ended', status: 'error', error: 'Something failed' }
      ]).split('\n').filter(Boolean)
    )
    const users = events.filter((e) => e.type === 'user')
    expect(users).toHaveLength(3)
    expect(users[0].text).toBe('First question')
    expect(users[1].text).toMatch(/And this\?/)
    expect(users[1].text).toMatch(/\[image\]/i)
    expect(users[1].text).not.toMatch(/image_files|attached/)
    expect(users[2].text).toBe('Third')
    const said = events.filter((e) => e.type === 'assistant').map((e) => e.text)
    expect(said).toEqual(['Looking.', 'Done here.', 'Stopped early.'])
    expect(said.join(' ')).not.toMatch(/REDACTED/)
    const calls = events.filter((e) => e.type === 'tool' && e.name)
    expect(calls.map((e) => e.name)).toEqual(['Read', 'Grep', 'Shell'])
    expect(calls[2].summary).toBe('ls')
    // Read and Grep are done once the next step comes, before the Shell call.
    const readId = calls[0].id
    const doneAt = events.findIndex((e) => e.type === 'tool' && e.id === readId && e.status === 'done')
    expect(doneAt).toBeGreaterThan(-1)
    expect(doneAt).toBeLessThan(events.indexOf(calls[2]))
    const ends = events.filter((e) => e.type === 'turnEnd')
    expect(ends.map((e) => e.status)).toEqual(['completed', 'interrupted', 'failed'])
    expect(ends[1].error).toBeUndefined()
    expect(ends[2].error).toBe('Something failed')
  })

  it('a prompt with no envelope is kept whole; unknown and broken lines are skipped', () => {
    const events = cursorViewEvents(['not json', JSON.stringify({ type: 'something_else' }), JSON.stringify(user('Plain prompt')), JSON.stringify(step(tool('ApplyPatch', '*** Begin Patch')))])
    expect(events.filter((e) => e.type === 'user').map((e) => e.text)).toEqual(['Plain prompt'])
    expect(events.find((e) => e.type === 'tool' && e.name === 'ApplyPatch')).toBeTruthy()
  })
})

describe('finding a Cursor conversation file', () => {
  it('finds <folder>/agent-transcripts/<id>/<id>.jsonl in any project folder, and the older flat file', () => {
    const file = cursorFile(lines([user('<user_query>Hi</user_query>')]))
    expect(findTranscriptViewFile('cursor', ID, roots)).toBe(file)
    const legacy = cursorFile(lines([user('x')]), { id: OTHER, folder: 'c-other', legacy: true })
    expect(findTranscriptViewFile('cursor', OTHER, roots)).toBe(legacy)
    expect(findTranscriptViewFile('cursor', '12345678-1111-4222-8333-444455556666', roots)).toBe(null)
  })

  it("uses the path its hooks reported when it is that conversation's own file inside ~/.cursor/projects", () => {
    const found = cursorFile(lines([user('a')]), { folder: 'C-a' })
    const reported = cursorFile(lines([user('b')]), { folder: 'C-b' })
    expect(findTranscriptViewFile('cursor', ID, roots, { reported })).toBe(reported)
    // Another conversation's file, a sub-agent's, or a file outside: the search instead.
    const other = cursorFile(lines([user('c')]), { id: OTHER, folder: 'C-c' })
    expect(findTranscriptViewFile('cursor', ID, roots, { reported: other })).toBe(found)
    const subDir = join(roots.cursor, 'C-a', 'agent-transcripts', OTHER, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(join(subDir, `${ID}.jsonl`), lines([user('d')]))
    expect(findTranscriptViewFile('cursor', ID, roots, { reported: join(subDir, `${ID}.jsonl`) })).toBe(found)
    const outside = join(tmp, 'elsewhere', `${ID}.jsonl`)
    fs.mkdirSync(join(tmp, 'elsewhere'), { recursive: true })
    fs.writeFileSync(outside, lines([user('e')]))
    expect(findTranscriptViewFile('cursor', ID, roots, { reported: outside })).toBe(found)
    expect(findTranscriptViewFile('cursor', ID, roots, { reported: `relative/${ID}.jsonl` })).toBe(found)
  })

  it('never follows a link or junction out of ~/.cursor/projects', () => {
    const outsideDir = join(tmp, 'outside', 'agent-transcripts', ID)
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.writeFileSync(join(outsideDir, `${ID}.jsonl`), lines([user('x')]))
    fs.mkdirSync(roots.cursor, { recursive: true })
    let linked = true
    try {
      fs.symlinkSync(join(tmp, 'outside'), join(roots.cursor, 'C-linked'), 'junction')
    } catch {
      linked = false
    }
    if (!linked) return
    expect(findTranscriptViewFile('cursor', ID, roots)).toBe(null)
  })

  it('reads the file into chat events', () => {
    cursorFile(lines([user('<user_query>Hello</user_query>'), step(text('Hi there')), { type: 'turn_ended', status: 'success' }]))
    const res = readTranscriptView({ agent: 'cursor', sessionId: ID, roots })
    expect(res.ok).toBe(true)
    expect(res.events.filter((e) => e.type === 'user').map((e) => e.text)).toEqual(['Hello'])
    expect(res.events.filter((e) => e.type === 'assistant').map((e) => e.text)).toEqual(['Hi there'])
    expect(readTranscriptView({ agent: 'cursor', sessionId: OTHER, roots })).toEqual({ ok: false, code: 'missing' })
  })
})
