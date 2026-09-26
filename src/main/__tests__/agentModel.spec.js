import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  agentModel,
  claudeModelFromText,
  codexModelFromText,
  codexModelFromToml,
  modelFromCommand
} from '../agentModel'
import { modelLabel } from '../../shared/modelLabel'

const ID = '6da350a1-326a-4f43-b9cc-9fae8081edcc'
const CX = '01a0d616-11e1-7202-9d2b-4b4172f348e9'

let home
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-model-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function put(rel, text) {
  const f = join(home, rel)
  fs.mkdirSync(join(f, '..'), { recursive: true })
  fs.writeFileSync(f, text)
  return f
}
const line = (o) => JSON.stringify(o)

describe('conversation files', () => {
  it('Claude: the latest real answer wins', () => {
    const text = [
      line({ type: 'assistant', message: { model: 'claude-sonnet-5' } }),
      line({ type: 'user', message: { content: 'hi' } }),
      line({ type: 'assistant', message: { model: 'claude-opus-5-5' } }),
      line({ type: 'assistant', message: { model: '<synthetic>' } }),
      '{"type":"assistant","message":{"model":"cut'
    ].join('\n')
    expect(claudeModelFromText(text)).toBe('claude-opus-5-5')
    expect(claudeModelFromText('')).toBe(null)
  })

  it('Claude: 1M context comes from the settings when it is the same model', () => {
    put(`.claude/projects/C--x/${ID}.jsonl`, line({ type: 'assistant', message: { model: 'claude-opus-5-5' } }) + '\n')
    put('.claude/settings.json', '{"model":"opus[1m]"}')
    const r = agentModel({ agentId: 'claude', sessionId: ID }, home)
    expect(r.model).toBe('claude-opus-5-5[1m]')
    expect(modelLabel(r.model)).toBe('Opus 5.5 (1M)')
    put('.claude/settings.json', '{"model":"sonnet[1m]"}')
    expect(agentModel({ agentId: 'claude', sessionId: ID }, home).model).toBe('claude-opus-5-5')
  })

  it('Codex: the latest turn (or /model change) with its effort', () => {
    const text = [
      line({ type: 'world_state', payload: { state: { collaboration_mode: { model: 'gpt-6-sol' } } } }),
      line({ type: 'turn_context', payload: { model: 'gpt-6-sol', effort: 'high' } }),
      line({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra' } } })
    ].join('\n')
    expect(codexModelFromText(text)).toEqual({ model: 'gpt-6-astra', effort: null })
    expect(codexModelFromText(text.split('\n').slice(0, 2).join('\n'))).toEqual({ model: 'gpt-6-sol', effort: 'high' })
  })

  it('reads the pane session file, before any setting', () => {
    put(`.claude/projects/C--x/${ID}.jsonl`, line({ type: 'assistant', message: { model: 'claude-opus-5-5' } }) + '\n')
    put('.claude/settings.json', '{"model":"sonnet"}')
    expect(agentModel({ agentId: 'claude', sessionId: ID }, home)).toEqual({
      model: 'claude-opus-5-5',
      effort: null,
      source: 'session'
    })
    const d = new Date()
    const day = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
    put(
      `.codex/sessions/${day}/rollout-2026-09-24T21-02-45-${CX}.jsonl`,
      line({ type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'medium' } }) + '\n'
    )
    expect(agentModel({ agentId: 'codex', sessionId: CX }, home)).toEqual({
      model: 'gpt-6-astra',
      effort: 'medium',
      source: 'session'
    })
  })
})

describe('command and settings', () => {
  it('finds --model / -m in the command', () => {
    expect(modelFromCommand('claude --model opus')).toBe('opus')
    expect(modelFromCommand('gemini -m gemini-3-pro')).toBe('gemini-3-pro')
    expect(modelFromCommand('opencode --model="anthropic/claude-sonnet-5"')).toBe('anthropic/claude-sonnet-5')
    expect(modelFromCommand('codex --no-daemon')).toBe(null)
    expect(modelFromCommand('my-mcp-tool')).toBe(null)
  })

  it('Codex config.toml: top level only', () => {
    expect(codexModelFromToml('model = "gpt-6-astra"\nmodel_reasoning_effort = "medium"\n[profiles.x]\nmodel = "o"')).toEqual({
      model: 'gpt-6-astra',
      effort: 'medium'
    })
    expect(codexModelFromToml('[profiles.x]\nmodel = "o"')).toBe(null)
  })

  it('the command beats settings; settings as a last resort', () => {
    put('.claude/settings.json', '{"model":"opus[1m]"}')
    expect(agentModel({ agentId: 'claude', command: 'claude --model haiku' }, home).source).toBe('command')
    expect(agentModel({ agentId: 'claude', sessionId: ID }, home)).toEqual({
      model: 'opus[1m]',
      effort: null,
      source: 'settings'
    })
  })

  it('the folder settings come before the user settings', () => {
    const cwd = join(home, 'proj')
    put('proj/.gemini/settings.json', '{"model":{"name":"gemini-3-flash"}}')
    put('.gemini/settings.json', '{"model":{"name":"gemini-3-pro"}}')
    expect(agentModel({ agentId: 'gemini', cwd }, home).model).toBe('gemini-3-flash')
  })

  it('OpenCode .jsonc with comments', () => {
    put('.config/opencode/opencode.jsonc', '{\n  // mine\n  "model": "anthropic/claude-sonnet-5", /* x */\n}')
    const old = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    try {
      expect(agentModel({ agentId: 'opencode' }, home).model).toBe('anthropic/claude-sonnet-5')
    } finally {
      if (old !== undefined) process.env.XDG_CONFIG_HOME = old
    }
  })

  it('nothing found: null, never a guess', () => {
    expect(agentModel({ agentId: 'copilot' }, home)).toBe(null)
    expect(agentModel({}, home)).toBe(null)
    put('.qwen/settings.json', '{ broken')
    expect(agentModel({ agentId: 'qwen' }, home)).toBe(null)
  })
})

describe('modelLabel', () => {
  it('short names', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelLabel('opus[1m]')).toBe('Opus (1M)')
    expect(modelLabel('anthropic/claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelLabel('gpt-6-astra')).toBe('gpt-6-astra')
    expect(modelLabel('')).toBe('')
  })
})
