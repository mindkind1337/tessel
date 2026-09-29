// Probing an agent's CLI for its models (agentModelList.js), with a fake
// program: arguments, stdin, kept lists, failures that keep the last good one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelLister, loadModelLists } from '../agentModelList'
import { CLAUDE_MODEL_LIST_STDIN } from '../../shared/agentModelProbe'

const CLAUDE_ANSWER =
  JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      response: {
        models: [
          { value: 'default', displayName: 'Default (recommended)' },
          { value: 'opus', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsFastMode: true }
        ]
      }
    }
  }) + '\n'

// A child_process-like object that plays one run.
function fakeSpawn(script, calls) {
  return (file, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    let input = ''
    child.stdin = opts.stdio[0] === 'pipe' ? { on() {}, end: (s) => (input += s) } : null
    child.killed = false
    child.kill = () => {
      child.killed = true
      setTimeout(() => child.emit('close', null), 0)
    }
    calls.push({ file, args, opts, input: () => input, child })
    setTimeout(() => {
      if (script.error) return child.emit('error', script.error)
      if (script.hang) return
      if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout))
      if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr))
      child.emit('close', script.code ?? 0)
    }, 1)
    return child
  }
}

describe('model lists from the agents themselves', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tessel-models-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const resolve = async (exe) => (exe === 'missing' ? null : { file: `C:\\bin\\${exe}.exe`, pre: [], path: 'C:\\bin' })

  it('Claude: its program, Orca arguments, the list_models request on stdin; the list is kept', async () => {
    const calls = []
    const lister = createModelLister(dir, { resolve, spawn: fakeSpawn({ stdout: CLAUDE_ANSWER }, calls), now: () => 1234 })
    const res = await lister.probe('claude')
    expect(res.ok).toBe(true)
    expect(res.models).toEqual([{ id: 'opus', label: 'Opus 5.5', effortLevels: ['low', 'high'], supportsFastMode: true }])
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('C:\\bin\\claude.exe')
    expect(calls[0].args).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])
    expect(calls[0].opts.windowsHide).toBe(true)
    expect(calls[0].opts.shell).toBeUndefined()
    expect(calls[0].input()).toBe(CLAUDE_MODEL_LIST_STDIN)
    expect(lister.list()).toEqual({ claude: { models: res.models, fetchedAt: 1234 } })
    // Kept on disk, read back at the next start.
    expect(JSON.parse(readFileSync(join(dir, 'agent-models.json'), 'utf8')).claude.fetchedAt).toBe(1234)
    expect(loadModelLists(dir).claude.models[0].id).toBe('opus')
  })

  it('Codex: codex debug models, stdin closed', async () => {
    const calls = []
    const out = JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_reasoning_levels: [{ effort: 'high' }] }] })
    const lister = createModelLister(dir, { resolve, spawn: fakeSpawn({ stdout: out }, calls) })
    const res = await lister.probe('codex')
    expect(res.ok).toBe(true)
    expect(calls[0].args).toEqual(['debug', 'models'])
    expect(calls[0].opts.stdio[0]).toBe('ignore')
  })

  it('a failure never replaces the last good list', async () => {
    const calls = []
    let script = { stdout: CLAUDE_ANSWER }
    const lister = createModelLister(dir, { resolve, spawn: (...a) => fakeSpawn(script, calls)(...a) })
    await lister.probe('claude')
    script = { stderr: 'Not logged in', code: 1 }
    const res = await lister.probe('claude')
    expect(res).toEqual({ ok: false, reason: 'failed', detail: '1: Not logged in' })
    expect(lister.list().claude.models[0].id).toBe('opus')
  })

  it('not found, a program that hangs, one that says too much, an agent without a probe', async () => {
    const calls = []
    expect(await createModelLister(dir, { resolve, spawn: fakeSpawn({}, calls) }).probe('claude', 'missing')).toEqual({
      ok: false,
      reason: 'not-found',
      detail: 'missing'
    })
    const hung = createModelLister(dir, { resolve, spawn: fakeSpawn({ hang: true }, calls), timeoutMs: 20 })
    expect((await hung.probe('codex')).reason).toBe('timeout')
    expect(calls.at(-1).child.killed).toBe(true)
    const big = createModelLister(dir, { resolve, spawn: fakeSpawn({ stdout: 'x'.repeat(4 * 1024 * 1024 + 10) }, calls) })
    expect((await big.probe('codex')).reason).toBe('too-much')
    expect((await big.probe('aider')).reason).toBe('unsupported')
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    expect((await createModelLister(dir, { resolve, spawn: fakeSpawn({ error: enoent }, calls) }).probe('grok')).reason).toBe('not-found')
    expect(existsSync(join(dir, 'agent-models.json'))).toBe(false)
  })

  it('one probe at a time per agent', async () => {
    const calls = []
    const lister = createModelLister(dir, { resolve, spawn: fakeSpawn({ stdout: CLAUDE_ANSWER }, calls) })
    const [a, b] = await Promise.all([lister.probe('claude'), lister.probe('claude')])
    expect(a).toBe(b)
    expect(calls).toHaveLength(1)
  })

  it('a damaged file reads as nothing kept', () => {
    expect(loadModelLists(join(dir, 'nowhere'))).toEqual({})
  })
})
