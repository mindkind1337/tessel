import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  agentModel,
  agentModelLive,
  clineSessionModel,
  watchModelFiles,
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

  it('OpenCode: the model picked in it since the pane started beats its settings', () => {
    const old = process.env.XDG_CONFIG_HOME
    const oldState = process.env.XDG_STATE_HOME
    delete process.env.XDG_CONFIG_HOME
    delete process.env.XDG_STATE_HOME
    try {
      const f = put('.local/state/opencode/model.json', '{"recent":[{"providerID":"opencode","modelID":"big-pickle"},{"providerID":"x","modelID":"y"}]}')
      // Nothing in its settings: the last picked model.
      expect(agentModel({ agentId: 'opencode' }, home)).toEqual({ model: 'opencode/big-pickle', effort: null, source: 'picked' })
      put('.config/opencode/opencode.json', '{"model":"anthropic/claude-sonnet-5"}')
      const t = fs.statSync(f).mtimeMs
      // Picked before the pane started: its settings win.
      expect(agentModel({ agentId: 'opencode', launchedAt: t + 60000 }, home).model).toBe('anthropic/claude-sonnet-5')
      // Picked while it runs: that one.
      expect(agentModel({ agentId: 'opencode', launchedAt: t - 60000 }, home).source).toBe('picked')
    } finally {
      if (old !== undefined) process.env.XDG_CONFIG_HOME = old
      if (oldState !== undefined) process.env.XDG_STATE_HOME = oldState
    }
  })

  it('Copilot: the running session, in the pane folder first', () => {
    const ev = (o) => JSON.stringify(o)
    const session = (id, cwd, lines, pid) => {
      put(`.copilot/session-state/${id}/workspace.yaml`, `id: ${id}\ncwd: ${cwd}\n`)
      put(`.copilot/session-state/${id}/events.jsonl`, lines.map(ev).join('\n') + '\n')
      if (pid) put(`.copilot/session-state/${id}/inuse.${pid}.lock`, String(pid))
    }
    const dead = 999999 // no such process
    session('a', 'C:\\Old', [{ type: 'assistant.message', data: { model: 'gpt-old' } }], dead)
    session('b', 'C:\\Other', [{ type: 'assistant.message', data: { model: 'gpt-other' } }], process.pid)
    session(
      'c',
      'C:\\Proj',
      [
        { type: 'session.model_change', data: { newModel: 'auto', reasoningEffort: null } },
        { type: 'assistant.message', data: { model: 'mai-code-1.1-flash' } }
      ],
      process.pid
    )
    expect(agentModel({ agentId: 'copilot', cwd: 'C:\\Proj\\' }, home)).toEqual({
      model: 'mai-code-1.1-flash',
      effort: null,
      source: 'session'
    })
    // Not in its folder: the running one still counts, never the closed one.
    expect(agentModel({ agentId: 'copilot', cwd: 'C:\\Old' }, home).model).not.toBe('gpt-old')
  })

  it('nothing found: null, never a guess', () => {
    expect(agentModel({ agentId: 'copilot' }, home)).toBe(null)
    expect(agentModel({}, home)).toBe(null)
    put('.qwen/settings.json', '{ broken')
    expect(agentModel({ agentId: 'qwen' }, home)).toBe(null)
  })
})

describe('Ollama', () => {
  it('the model in its command, else the only one it has running', async () => {
    expect(modelFromCommand('ollama run glm-5.2:cloud')).toBe('glm-5.2:cloud')
    expect(modelFromCommand('"C:\\x\\ollama.exe" run --keepalive 5m --verbose qwen3:8b hi')).toBe('qwen3:8b')
    expect(modelFromCommand('claude ollama launch claude --model glm-5.2:cloud')).toBe('glm-5.2:cloud')
    expect(modelFromCommand('ollama serve')).toBe(null)
    const one = async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama4:scout' }] }) })
    const two = async () => ({ ok: true, json: async () => ({ models: [{ name: 'a' }, { name: 'b' }] }) })
    const down = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await agentModelLive({ agentId: 'ollama', command: 'ollama' }, home, one)).toEqual({
      model: 'llama4:scout',
      effort: null,
      source: 'running'
    })
    expect(await agentModelLive({ agentId: 'ollama', command: 'ollama' }, home, two)).toBe(null)
    expect(await agentModelLive({ agentId: 'ollama', command: 'ollama' }, home, down)).toBe(null)
    expect((await agentModelLive({ agentId: 'ollama', command: 'ollama run phi5' }, home, one)).model).toBe('phi5')
    // Other agents never ask Ollama.
    expect(await agentModelLive({ agentId: 'copilot' }, home, one)).toBe(null)
  })
})

describe('Cline', () => {
  it('the open session of a running Cline, in the pane folder first', () => {
    const alive = (pid) => pid !== 1
    const rows = [
      { pid: 1, model: 'gone-model', cwd: 'C:\\Proj', ended_at: null, is_subagent: 0, updated_at: '2026-09-26T19:30:00Z' },
      { pid: 2, model: 'other-folder', cwd: 'C:\\Else', ended_at: null, is_subagent: 0, updated_at: '2026-09-26T19:29:00Z' },
      { pid: 3, model: 'deepseek/deepseek-v4-flash', cwd: 'C:\\Proj', ended_at: null, is_subagent: 0, updated_at: '2026-09-26T19:00:00Z' },
      { pid: 4, model: 'sub', cwd: 'C:\\Proj', ended_at: null, is_subagent: 1, updated_at: '2026-09-26T19:31:00Z' }
    ]
    expect(clineSessionModel(rows, 'C:/Proj/', alive).model).toBe('deepseek/deepseek-v4-flash')
    expect(clineSessionModel(rows, 'C:\\Nowhere', alive).model).toBe('other-folder')
    expect(clineSessionModel([], 'C:\\Proj', alive)).toBe(null)
  })

  it('reads sessions.db, else the provider settings', () => {
    const sqlite = process.getBuiltinModule && process.getBuiltinModule('node:sqlite')
    const old = { dir: process.env.CLINE_DIR, data: process.env.CLINE_DATA_DIR }
    delete process.env.CLINE_DIR
    delete process.env.CLINE_DATA_DIR
    try {
      put('.cline/data/settings/providers.json', JSON.stringify({
        version: 1,
        lastUsedProvider: 'openrouter',
        providers: { openrouter: { settings: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' } } }
      }))
      // Its settings file is older than the session written below.
      const old2 = new Date(Date.now() - 3600 * 1000)
      fs.utimesSync(join(home, '.cline/data/settings/providers.json'), old2, old2)
      expect(agentModel({ agentId: 'cline', cwd: 'C:\\Proj' }, home)).toEqual({
        model: 'anthropic/claude-sonnet-5',
        effort: null,
        source: 'settings'
      })
      if (!sqlite) return
      fs.mkdirSync(join(home, '.cline/data/db'), { recursive: true })
      const db = new sqlite.DatabaseSync(join(home, '.cline/data/db/sessions.db'))
      db.exec('CREATE TABLE sessions (session_id TEXT, pid INTEGER, model TEXT, cwd TEXT, ended_at TEXT, is_subagent INTEGER, updated_at TEXT)')
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run('s1', process.pid, 'gpt-5.5', 'C:\\Proj', null, 0, new Date().toISOString())
      db.close()
      expect(agentModel({ agentId: 'cline', cwd: 'C:\\Proj' }, home)).toEqual({ model: 'gpt-5.5', effort: null, source: 'session' })
    } finally {
      if (old.dir !== undefined) process.env.CLINE_DIR = old.dir
      if (old.data !== undefined) process.env.CLINE_DATA_DIR = old.data
    }
  })
})

describe('watching', () => {
  it('a model file change calls back with its agent, once', async () => {
    put('.local/state/opencode/model.json', '{}')
    put('.codex/config.toml', 'model = "a"')
    const oldState = process.env.XDG_STATE_HOME
    delete process.env.XDG_STATE_HOME
    const seen = []
    const stop = watchModelFiles((a) => seen.push(a), home)
    try {
      await new Promise((r) => setTimeout(r, 100))
      fs.writeFileSync(join(home, '.local/state/opencode/model.json'), '{"recent":[]}')
      fs.writeFileSync(join(home, '.local/state/opencode/model.json'), '{"recent":[{}]}')
      fs.writeFileSync(join(home, '.codex/other.txt'), 'x') // not a model file
      await new Promise((r) => setTimeout(r, 1500))
      expect(seen).toEqual(['opencode'])
    } finally {
      stop()
      if (oldState !== undefined) process.env.XDG_STATE_HOME = oldState
    }
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
