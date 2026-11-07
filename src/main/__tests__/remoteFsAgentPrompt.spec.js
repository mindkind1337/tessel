// The host-side scan for a turn's prompt (__t_tprompt), run for real through
// the fake ssh (Git for Windows sh): what it finds must be what
// chat/promptBefore.js isPromptLine would pick over the same lines.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRemoteFs } from '../remoteFs'
import { FUNCTIONS } from '../remoteShell'
import { isPromptLine } from '../chat/promptBefore.js'
import { gitSh, fakeSpawn } from './fixtures/fakeSsh'

const HOST = 'ssh-prompt1'
function stubHosts() {
  return {
    launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: HOST } }),
    get: () => ({ id: HOST, label: 'Box' }),
    sharedConnected: () => true,
    paneStarted: () => {},
    paneConnected: () => {},
    paneClosing: () => {},
    paneExited: () => {}
  }
}
const ID = 'bc482d1e-5e63-4556-8963-8cd3d98109b1'
const j = (o) => JSON.stringify(o)
const human = (text, extra = {}) => j({ type: 'user', uuid: 'u', timestamp: '2026-11-06T18:00:00.000Z', message: { role: 'user', content: text }, origin: { kind: 'human' }, ...extra })
const LINES = [
  human('old prompt é'),
  j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the file says "type":"user" inside' }] } }),
  human('the prompt of the long turn'),
  human('<system-reminder>context</system-reminder>', { isMeta: true }),
  j({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5000) }] } }),
  human('<task-notification>done</task-notification>', { origin: { kind: 'task-notification' } }),
  human('a sub-agent line', { isSidechain: true }),
  j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] } })
]
const offsets = []
let o = 0
for (const l of LINES) {
  offsets.push(o)
  o += Buffer.byteLength(l) + 1
}
const ANSWER_AT = offsets[7]
const PROMPT_AT = offsets[2]

it('__t_tprompt is a function the terminal may call', () => {
  expect(FUNCTIONS.has('__t_tprompt')).toBe(true)
})

describe.skipIf(!gitSh())('the prompt before a window, scanned on the host (real sh)', () => {
  let base
  let rfs
  // The fake host inherits this process's environment: a Claude Code session
  // running these specs sets CLAUDE_CONFIG_DIR, which would point the host's
  // lookup at this computer's transcripts instead of the fake home's.
  const configDir = process.env.CLAUDE_CONFIG_DIR
  beforeAll(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rfs-prompt-'))
    const home = join(base, 'home')
    const proj = join(home, '.claude', 'projects', '-home-me-proj')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(join(proj, `${ID}.jsonl`), LINES.join('\n') + '\n')
    rfs = createRemoteFs({ hosts: stubHosts(), spawnImpl: fakeSpawn({ home }) })
    rfs.allow(HOST)
  })
  afterAll(() => {
    if (configDir !== undefined) process.env.CLAUDE_CONFIG_DIR = configDir
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('finds the turn’s prompt before the answer: the same line isPromptLine picks', async () => {
    const res = await rfs.findAgentPrompt(HOST, { agent: 'claude', id: ID, before: ANSWER_AT - 1 })
    expect(res.ok).toBe(true)
    expect(res.line).toBe(LINES[2])
    const byRule = LINES.filter((l, i) => offsets[i] < ANSWER_AT && isPromptLine(l)).pop()
    expect(res.line).toBe(byRule)
  }, 30000)

  it('from a start byte after the prompt: none (the caller keeps what it had); from the prompt itself: found', async () => {
    expect(await rfs.findAgentPrompt(HOST, { agent: 'claude', id: ID, before: ANSWER_AT - 1, start: PROMPT_AT + 1 })).toEqual({ ok: false, none: true })
    expect((await rfs.findAgentPrompt(HOST, { agent: 'claude', id: ID, before: ANSWER_AT - 1, start: PROMPT_AT })).line).toBe(LINES[2])
  }, 30000)

  it('a window inside the old answer: the old prompt; an unknown file: missing; bad arguments refused', async () => {
    expect((await rfs.findAgentPrompt(HOST, { agent: 'claude', id: ID, before: offsets[1] + 5 })).line).toBe(LINES[0])
    expect((await rfs.findAgentPrompt(HOST, { agent: 'claude', id: 'bc482d1e-0000-0000-0000-000000000000', before: 100 })).missing).toBe(true)
    expect(await rfs.findAgentPrompt(HOST, { agent: 'codex', id: ID, before: 100 })).toEqual({ ok: false, error: 'invalid' })
    expect(await rfs.findAgentPrompt(HOST, { agent: 'claude', id: '../x', before: 100 })).toEqual({ ok: false, error: 'invalid' })
    expect(await rfs.findAgentPrompt(HOST, { agent: 'claude', id: ID, before: 0 })).toEqual({ ok: false, error: 'invalid' })
    expect(await rfs.findAgentPrompt(HOST, { agent: 'claude', id: ID, before: 10, start: 11 })).toEqual({ ok: false, error: 'invalid' })
  }, 30000)
})
