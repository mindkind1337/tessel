// @vitest-environment node
// Antigravity's (agy) conversation in a terminal pane's chat view: hand-made
// files in the shapes its logs have (no real agent folder, no real text).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { TRANSCRIPT_VIEW_AGENTS, antigravityViewEvents, findTranscriptViewFile, readTranscriptView, transcriptViewRoots, validViewId } from '../transcriptView'

const ID = '0a1b2c3d-1111-4222-8333-444455556666'
const OTHER = '9f8e7d6c-1111-4222-8333-444455556666'
const lines = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'
let n = 0
const at = () => `2026-01-01T10:00:${String(n % 60).padStart(2, '0')}Z`
const step = (fields) => ({ step_index: n++, status: 'DONE', created_at: at(), ...fields })
const user = (text, extra = '') =>
  step({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nCursor is on line 3.\n</ADDITIONAL_METADATA>${extra}` })
const planner = (fields) => step({ source: 'MODEL', type: 'PLANNER_RESPONSE', ...fields })
const result = (type, content, status = 'DONE') => step({ source: 'MODEL', type, content, status })

let tmp
let roots
beforeEach(() => {
  n = 0
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tview-agy-'))
  roots = transcriptViewRoots(tmp, {})
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function agyFile(content, { id = ID, name = 'transcript.jsonl' } = {}) {
  const dir = join(roots.antigravity, id, '.system_generated', 'logs')
  fs.mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  fs.writeFileSync(file, content)
  return file
}

describe('Antigravity in the transcript view', () => {
  it('is a transcript view agent with UUID conversation ids, under ~/.gemini/antigravity-cli/brain', () => {
    expect(TRANSCRIPT_VIEW_AGENTS).toContain('antigravity')
    expect(validViewId('antigravity', ID)).toBe(true)
    expect(validViewId('antigravity', 'abc123')).toBe(false)
    expect(validViewId('antigravity', '../x')).toBe(false)
    expect(roots.antigravity).toBe(join(tmp, '.gemini', 'antigravity-cli', 'brain'))
  })
})

describe('antigravityViewEvents', () => {
  it('prompts without their envelope, thinking and text, tool calls paired with the next steps, system steps hidden', () => {
    const events = antigravityViewEvents(
      lines([
        user('First question', '\n<USER_SETTINGS_CHANGE>\nmodel changed\n</USER_SETTINGS_CHANGE>'),
        step({ source: 'SYSTEM', type: 'CONVERSATION_HISTORY' }),
        planner({ thinking: 'Let me look.', tool_calls: [{ name: 'list_dir', args: { DirectoryPath: 'C:\\proj', toolAction: 'Listing', toolSummary: 'Listing the folder' } }, { name: 'run_command', args: { CommandLine: 'npm test', toolSummary: 'Running tests' } }] }),
        result('LIST_DIRECTORY', 'a.js\nb.js'),
        result('RUN_COMMAND', 'exit status 1', 'ERROR'),
        step({ source: 'MODEL', type: 'CHECKPOINT' }),
        planner({ content: 'Done here.' }),
        user('Second'),
        planner({ content: 'Partial answer', status: 'CANCELED' }),
        user('Third'),
        step({ source: 'MODEL', type: 'ERROR_MESSAGE', content: 'Quota exceeded' })
      ]).split('\n').filter(Boolean)
    )
    const users = events.filter((e) => e.type === 'user')
    expect(users.map((e) => e.text)).toEqual(['First question', 'Second', 'Third'])
    expect(users.every((e) => Number.isFinite(e.at))).toBe(true)
    expect(events.filter((e) => e.type === 'thinking').map((e) => e.text)).toEqual(['Let me look.'])
    expect(events.filter((e) => e.type === 'assistant').map((e) => e.text)).toEqual(['Done here.', 'Partial answer'])
    const calls = events.filter((e) => e.type === 'tool' && e.name)
    expect(calls.map((e) => e.name)).toEqual(['list_dir', 'run_command'])
    expect(calls.map((e) => e.summary)).toEqual(['C:\\proj', 'npm test'])
    // Its own labels are not part of the call's input.
    expect(calls[0].input).toEqual({ DirectoryPath: 'C:\\proj' })
    const results = events.filter((e) => e.type === 'toolResult')
    expect(results.map((e) => [e.id, e.isError])).toEqual([
      [calls[0].id, false],
      [calls[1].id, true]
    ])
    expect(results[0].text).toBe('a.js\nb.js')
    const ends = events.filter((e) => e.type === 'turnEnd')
    expect(ends.map((e) => e.status)).toEqual(['completed', 'interrupted', 'failed'])
    expect(ends[2].error).toBe('Quota exceeded')
    expect(JSON.stringify(events)).not.toMatch(/ADDITIONAL_METADATA|Cursor is on line|model changed|USER_REQUEST/)
  })

  it('a step logged again keeps its place with its latest content; a call never answered is not paired with a later turn', () => {
    const first = planner({ tool_calls: [{ name: 'view_file', args: { AbsolutePath: 'C:\\a.js' } }], status: 'RUNNING' })
    const again = { ...first, status: 'DONE', content: 'Reading it.' }
    const events = antigravityViewEvents(
      lines([user('Go'), first, result('VIEW_FILE', 'text of a'), again, user('Next'), planner({ tool_calls: [{ name: 'ask_question', args: '{"question":"Which?"}' }] })]).split('\n').filter(Boolean)
    )
    expect(events.filter((e) => e.type === 'assistant').map((e) => e.text)).toEqual(['Reading it.'])
    expect(events.filter((e) => e.type === 'tool' && e.name).map((e) => e.name)).toEqual(['view_file', 'ask_question'])
    expect(events.filter((e) => e.type === 'toolResult')).toHaveLength(1)
    // Its arguments as text are read as JSON.
    expect(events.find((e) => e.name === 'ask_question').input).toEqual({ question: 'Which?' })
  })

  it('older and prefixed shapes, a prompt without envelope, unknown and broken lines', () => {
    const events = antigravityViewEvents([
      'not json',
      JSON.stringify({ source: 'USER', type: 'REQUEST', content: 'Plain prompt', created_at: at() }),
      JSON.stringify({ source: 'CORTEX_STEP_SOURCE_MODEL', type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', content: 'Hi' }),
      JSON.stringify({ source: 'MODEL', type: 'SOMETHING_NEW', content: 'no call before it' }),
      JSON.stringify({ source: 'USER_IMPLICIT', type: 'USER_INPUT', content: 'not typed by you' })
    ])
    expect(events.filter((e) => e.type === 'user').map((e) => e.text)).toEqual(['Plain prompt'])
    expect(events.filter((e) => e.type === 'assistant').map((e) => e.text)).toEqual(['Hi'])
    expect(events.filter((e) => e.type === 'toolResult')).toHaveLength(0)
  })
})

describe('finding an Antigravity conversation file', () => {
  it('finds brain/<id>/.system_generated/logs/, the full log first, else the shortened one', () => {
    const short = agyFile(lines([user('Hi')]))
    expect(findTranscriptViewFile('antigravity', ID, roots)).toBe(short)
    const full = agyFile(lines([user('Hi')]), { name: 'transcript_full.jsonl' })
    expect(findTranscriptViewFile('antigravity', ID, roots)).toBe(full)
    expect(findTranscriptViewFile('antigravity', OTHER, roots)).toBe(null)
    expect(findTranscriptViewFile('antigravity', '../brain', roots)).toBe(null)
  })

  it('a path its hooks may have reported is never used (the id alone finds the file)', () => {
    const own = agyFile(lines([user('a')]))
    const elsewhere = join(tmp, 'elsewhere.jsonl')
    fs.writeFileSync(elsewhere, lines([user('b')]))
    expect(findTranscriptViewFile('antigravity', ID, roots, { reported: elsewhere })).toBe(own)
  })

  it('never follows a link or junction out of the brain folder', () => {
    const outside = join(tmp, 'outside', '.system_generated', 'logs')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(join(outside, 'transcript.jsonl'), lines([user('x')]))
    fs.mkdirSync(roots.antigravity, { recursive: true })
    let linked = true
    try {
      fs.symlinkSync(join(tmp, 'outside'), join(roots.antigravity, ID), 'junction')
    } catch {
      linked = false
    }
    if (!linked) return
    expect(findTranscriptViewFile('antigravity', ID, roots)).toBe(null)
  })

  it('reads the file into chat events', () => {
    agyFile(lines([user('Hello'), planner({ content: 'Hi there' })]))
    const res = readTranscriptView({ agent: 'antigravity', sessionId: ID, roots })
    expect(res.ok).toBe(true)
    expect(res.events.filter((e) => e.type === 'user').map((e) => e.text)).toEqual(['Hello'])
    expect(res.events.filter((e) => e.type === 'assistant').map((e) => e.text)).toEqual(['Hi there'])
    expect(readTranscriptView({ agent: 'antigravity', sessionId: OTHER, roots })).toEqual({ ok: false, code: 'missing' })
    expect(readTranscriptView({ agent: 'antigravity', sessionId: 'not-a-uuid', roots })).toEqual({ ok: false, code: 'invalid' })
  })
})
