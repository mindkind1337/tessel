// @vitest-environment node
// Qoder CLI conversations (~/.qoder/projects/<slug>/<session>.jsonl, Claude
// Code's format with records of its own) in the Agent Session History, its
// details and session search. Synthetic files in a temp home only: never the
// real home. The records follow a Qoder 1.1.64 transcript.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { listSessions, qoderTextLine, qoderTranscriptIn } from '../agentSessions'
import { sessionDetails, findSessionFile } from '../sessionDetails'
import { listSources, rowsFromLines } from '../sessionSearch/indexer'
import { createSessionSearchCore } from '../sessionSearch/core'

const Q1 = 'faa75b79-790e-4c44-8f3e-c7145d18eb7e'
const Q2 = '0b1c2d3e-4f50-4617-8899-aabbccddeeff'
const NOW = Date.parse('2026-10-02T08:00:00Z')
const CWD = 'C:\\work\\qoder-proof'

let home, dataDir, search
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-qoder-home-'))
  dataDir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-qoder-data-'))
  search = null
})
afterEach(() => {
  if (search) search.close()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// A Qoder transcript: its startup records, a prompt, thinking, text, a tool
// call and its result, the answer.
function qoderLines(id, cwd, prompt, answer) {
  const at = (s) => new Date(NOW - 3600000 + s * 1000).toISOString()
  const msg = (uuid, s, content, extra = {}) => ({
    type: 'assistant',
    uuid,
    timestamp: at(s),
    message: { id: `chatcmpl-${uuid}`, type: 'message', role: 'assistant', model: 'qmodel_38max', content },
    cwd,
    sessionId: id,
    ...extra
  })
  return [
    { type: 'workspace-directories', sessionId: id, directories: [cwd] },
    { type: 'runtime-config', sessionId: id, model: 'qmodel_38max', reasoningEffort: null, timestamp: NOW - 3600000 },
    { type: 'worktree-state', sessionId: id, worktreeSession: null },
    {
      type: 'user',
      uuid: 'u1',
      timestamp: at(0),
      message: { role: 'user', content: prompt },
      permissionMode: 'acceptEdits',
      origin: { kind: 'human' },
      humanInput: { text: prompt, mode: 'prompt' },
      parentUuid: null,
      isSidechain: false,
      cwd,
      sessionId: id,
      version: '1.1.64'
    },
    { type: 'active-leaf', sessionId: id, leafUuid: 'u1', explicit: false, timestamp: NOW - 3599000 },
    msg('a1', 3, [{ type: 'thinking', thinking: 'secretthinking about the file', signature: '' }]),
    msg('a2', 3, [{ type: 'text', text: 'Creating the file.', citations: null }]),
    msg('a3', 3, [{ type: 'tool_use', id: 'call_1', name: 'Write', input: { file_path: 'proof.txt', content: 'toolpayload' } }]),
    {
      type: 'user',
      uuid: 'u2',
      timestamp: at(4),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'File created successfully: toolresultmarker' }] },
      cwd,
      sessionId: id
    },
    msg('a4', 6, [{ type: 'text', text: answer, citations: null }]),
    { type: 'last-prompt', sessionId: id, lastPrompt: prompt }
  ].map((r) => JSON.stringify(r))
}
function putQoder(id, { name = `${id}.jsonl`, cwd = CWD, prompt = 'Create proof.txt with a marker', answer = 'PELICAN_DONE', mtime = NOW - 60000 } = {}) {
  const folder = join(home, '.qoder', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  fs.mkdirSync(folder, { recursive: true })
  const file = join(folder, name)
  fs.writeFileSync(file, qoderLines(id, cwd, prompt, answer).join('\n') + '\n')
  fs.utimesSync(file, new Date(mtime), new Date(mtime))
  return file
}

describe('Qoder lines for the Claude readers', () => {
  it('keeps only the text blocks of a message', () => {
    const lines = qoderLines(Q1, CWD, 'hello', 'bye')
    const tool = JSON.parse(qoderTextLine(lines[7]))
    expect(tool.message.content).toEqual([])
    const text = JSON.parse(qoderTextLine(lines[6]))
    expect(text.message.content).toEqual([{ type: 'text', text: 'Creating the file.', citations: null }])
    // Not a message, or not JSON: as it is.
    expect(qoderTextLine(lines[0])).toBe(lines[0])
    expect(qoderTextLine('{"content": oops')).toBe('{"content": oops')
  })

  it('reads prompts and answers, never thinking, tool calls or their output', () => {
    const rows = rowsFromLines('qoder', qoderLines(Q1, CWD, 'Create proof.txt', 'PELICAN_DONE'), Q1)
    expect(rows.map((r) => [r.role, r.text])).toEqual([
      ['user', 'Create proof.txt'],
      ['assistant', 'Creating the file.'],
      ['assistant', 'PELICAN_DONE']
    ])
  })
})

describe('Qoder in the Agent Session History', () => {
  it('lists its conversations with their folder, title and id', () => {
    putQoder(Q1, { mtime: NOW - 1000 })
    // Another file name: its id is the sessionId inside.
    putQoder(Q2, { name: 'renamed-session.jsonl', cwd: 'D:\\other', prompt: 'Second task', mtime: NOW - 5000 })
    // A sub-agent's transcript (in a folder) is not a conversation of its own.
    const sub = join(home, '.qoder', 'projects', 'x', Q1, 'subagents')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(join(sub, 'worker.jsonl'), qoderLines(Q1, CWD, 'sub', 'sub').join('\n'))
    const rows = listSessions({ limit: 10 }, home).filter((s) => s.agent === 'qoder')
    expect(rows).toEqual([
      expect.objectContaining({ agent: 'qoder', id: Q1, cwd: CWD, title: 'Create proof.txt with a marker' }),
      expect.objectContaining({ agent: 'qoder', id: Q2, cwd: 'D:\\other', title: 'Second task' })
    ])
    expect(rows[0].started).toBe(NOW - 3600000)
    expect(listSessions({ cwd: 'd:/other', limit: 10 }, home).map((s) => s.id)).toEqual([Q2])
    // Left out with the other agents (an account's own list).
    expect(listSessions({ limit: 10 }, home, { others: false }).some((s) => s.agent === 'qoder')).toBe(false)
  })

  it('shows its details from the transcript, by id whatever the file name', () => {
    const file = putQoder(Q2, { name: 'renamed-session.jsonl' })
    expect(qoderTranscriptIn(join(home, '.qoder'), Q2)).toBe(file)
    expect(qoderTranscriptIn(join(home, '.qoder'), Q1)).toBe(null)
    expect(findSessionFile({ agent: 'qoder', id: Q2 }, home)).toMatchObject({ file })
    const d = sessionDetails({ agent: 'qoder', id: Q2 }, home)
    expect(d).toMatchObject({ ok: true, file, firstPrompt: 'Create proof.txt with a marker', messageCount: 3 })
    expect(d.turns.map((t) => t.text)).toEqual(['Create proof.txt with a marker', 'Creating the file.', 'PELICAN_DONE'])
    expect(sessionDetails({ agent: 'qoder', id: Q1 }, home)).toEqual({ ok: false })
  })
})

describe('Qoder in session search', () => {
  it('lists its files inside ~/.qoder/projects', () => {
    const file = putQoder(Q1)
    const src = listSources({ home, titles: false }).filter((s) => s.agent === 'qoder')
    expect(src).toEqual([expect.objectContaining({ agent: 'qoder', path: file, root: join(home, '.qoder', 'projects'), id: Q1 })])
  })

  it('indexes what was said and finds it, not its tool output', () => {
    putQoder(Q1, { name: 'renamed-session.jsonl', answer: 'The pelicans are counted.' })
    search = createSessionSearchCore({ dir: dataDir, home, now: () => NOW, timers: { setTimeout: () => null, clearTimeout: () => {} } })
    expect(search.enable()).toEqual({ ok: true })
    for (let i = 0; i < 1000 && search.runOnce(); i++);
    const hits = search.search({ query: 'pelicans' }).hits
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ agent: 'qoder', sessionId: Q1, title: 'Create proof.txt with a marker', cwd: CWD })
    expect(search.search({ query: 'pelicans', agents: ['qoder'] }).hits).toHaveLength(1)
    expect(search.search({ query: 'pelicans', agents: ['claude'] }).hits).toHaveLength(0)
    expect(search.search({ query: 'toolresultmarker' }).hits).toEqual([])
    expect(search.search({ query: 'secretthinking' }).hits).toEqual([])
    expect(search.search({ query: 'toolpayload' }).hits).toEqual([])
  })
})
