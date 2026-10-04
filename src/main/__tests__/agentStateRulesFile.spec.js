// The user's agent-state rules file: read and checked, watched for changes
// (live reload), sent only when what it means changed, created from the
// commented example on "Open rules file".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createAgentStateRulesFile, readRulesFile, MAX_RULES_FILE_BYTES } from '../agentStateRulesFile'
import { OVERRIDE_TEMPLATE } from '../../shared/agentStateRules'
import { setLanguage } from '../i18n'

let dir
let file
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rules-'))
  file = join(dir, 'agent-state-rules.json')
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

const good = JSON.stringify({
  engineVersion: 1,
  agents: { claude: { rules: [{ id: 'mine', kind: 'approval', regex: 'Continue\\?' }], disable: ['working-spinner'] } }
})
const knownAgents = ['claude', 'codex']

describe('readRulesFile', () => {
  it('no file: built-in', () => {
    expect(readRulesFile(file, { knownAgents })).toEqual({ state: 'builtin', reason: '', problem: null, file, size: 0, override: null })
  })

  it('a valid file: override, with its size', () => {
    fs.writeFileSync(file, `// mine\n${good}`)
    const r = readRulesFile(file, { knownAgents })
    expect(r).toMatchObject({ state: 'override', size: 2, reason: '' })
    expect(r.override.agents.claude.rules[0].id).toBe('mine')
  })

  it('broken JSON: invalid, with the parser error', () => {
    fs.writeFileSync(file, '{ "engineVersion": 1, ')
    expect(readRulesFile(file, { knownAgents })).toMatchObject({ state: 'invalid', override: null, reason: expect.stringContaining('not valid JSON') })
  })

  it('a schema error: invalid, with where it is', () => {
    fs.writeFileSync(file, JSON.stringify({ engineVersion: 1, agents: { robot: {} } }))
    expect(readRulesFile(file, { knownAgents }).reason).toBe('agents.robot: "robot" is not an agent Tessel knows')
  })

  it('a huge file is refused unread', () => {
    fs.writeFileSync(file, ' '.repeat(MAX_RULES_FILE_BYTES + 1))
    expect(readRulesFile(file, { knownAgents }).reason).toContain('larger than')
    expect(readRulesFile(file, { knownAgents }).problem).toEqual({ code: 'tooLarge', kb: 256 })
  })

  // The window says the reason in its own language from the code; main's
  // own text is in its language too. The parser's words stay as they are.
  describe('in French', () => {
    afterEach(() => setLanguage('en'))

    it('a schema error and broken JSON: a code, and French text around the details', () => {
      setLanguage('fr')
      fs.writeFileSync(file, JSON.stringify({ engineVersion: 1, agents: { claude: { rules: [{ id: 'x', kind: 'approval', regex: '(a+)+b' }] } } }))
      const bad = readRulesFile(file, { knownAgents })
      expect(bad.problem).toEqual({ code: 'unsafeRegex', at: 'agents.claude.rules[0]', why: 'repeatedGroup' })
      expect(bad.reason).toBe('agents.claude.rules[0] : la regex répète un groupe qui peut correspondre de plusieurs façons')
      fs.writeFileSync(file, '{ "engineVersion": 1, ')
      const broken = readRulesFile(file, { knownAgents })
      expect(broken.problem).toMatchObject({ code: 'badJson' })
      expect(broken.reason).toBe(`JSON non valide : ${broken.problem.detail}`)
      expect(broken.reason).not.toContain('not valid JSON')
    })
  })
})

function fakeWatch() {
  const w = { listener: null, closed: false, dir: null }
  const watch = (d, _opts, listener) => {
    w.dir = d
    w.listener = listener
    return { close: () => (w.closed = true), on: () => {} }
  }
  return { w, watch }
}

describe('live reload', () => {
  it('watches the folder, reloads on a change of the file, sends what changed', () => {
    vi.useFakeTimers()
    const sent = []
    const logs = []
    const log = { info: (_s, m) => logs.push(['info', m]), warn: (_s, m) => logs.push(['warn', m]) }
    const { w, watch } = fakeWatch()
    const rules = createAgentStateRulesFile({ file, knownAgents, send: (p) => sent.push(p), log, watch, debounceMs: 50 })
    rules.start()
    expect(w.dir).toBe(dir)
    expect(rules.current().state).toBe('builtin')

    fs.writeFileSync(file, good)
    w.listener('rename', 'agent-state-rules.json')
    w.listener('change', 'AGENT-STATE-RULES.JSON')
    vi.advanceTimersByTime(60)
    expect(sent).toHaveLength(1)
    expect(sent[0].state).toBe('override')

    // Another file in the folder: ignored.
    fs.writeFileSync(file, '{ broken')
    w.listener('change', 'workspace-layout.json')
    vi.advanceTimersByTime(60)
    expect(sent).toHaveLength(1)

    // The rules file broken: invalid, logged, sent.
    w.listener('change', 'agent-state-rules.json')
    vi.advanceTimersByTime(60)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ state: 'invalid', override: null })
    expect(logs.at(-1)[0]).toBe('warn')
    expect(logs.at(-1)[1]).toContain('ignored, the built-in rules stay in use')

    // Saved again unchanged (or only whitespace): nothing sent.
    w.listener('change', 'agent-state-rules.json')
    vi.advanceTimersByTime(60)
    expect(sent).toHaveLength(2)

    // Deleted: back to built-in.
    fs.rmSync(file)
    w.listener('rename', null)
    vi.advanceTimersByTime(60)
    expect(sent.at(-1).state).toBe('builtin')

    rules.stop()
    expect(w.closed).toBe(true)
  })

  it('a watch that cannot start is logged, the file still read', () => {
    fs.writeFileSync(file, good)
    const logs = []
    const rules = createAgentStateRulesFile({
      file,
      knownAgents,
      log: { info: () => {}, warn: (_s, m) => logs.push(m) },
      watch: () => {
        throw new Error('EPERM')
      }
    })
    rules.start()
    expect(rules.current().state).toBe('override')
    expect(logs[0]).toContain('cannot watch')
  })
})

describe('ensureFile', () => {
  it('creates the commented example when missing, never overwrites', () => {
    const rules = createAgentStateRulesFile({ file, knownAgents, watch: fakeWatch().watch })
    expect(rules.ensureFile()).toBe(file)
    expect(fs.readFileSync(file, 'utf8')).toBe(OVERRIDE_TEMPLATE)
    expect(rules.reload()).toMatchObject({ state: 'override', size: 0 })
    fs.writeFileSync(file, good)
    rules.ensureFile()
    expect(fs.readFileSync(file, 'utf8')).toBe(good)
  })
})
