// Asking an agent's CLI for its models (Orca's probes): parsing real outputs
// (fixtures: Claude Code 2.1's list_models answer, `codex debug models`).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLAUDE_MODEL_LIST_ARGS,
  CLAUDE_MODEL_LIST_STDIN,
  MODEL_PROBES,
  parseClaudeModelList,
  parseCodexModelList,
  parseGrokModelList,
  parseOpenCodeModelList,
  OPENCODE_MODEL_LIST_ARGS,
  finalizeProbeOutput,
  listedToCatalogModels,
  validListedModels,
  labelFromModelId
} from '../agentModelProbe'

const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

describe('Claude Code: one list_models control request', () => {
  it("runs --print with stream-json in and out (Orca's arguments), no prompt", () => {
    expect(CLAUDE_MODEL_LIST_ARGS).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])
    const req = JSON.parse(CLAUDE_MODEL_LIST_STDIN)
    expect(req).toEqual({ type: 'control_request', request_id: 'orca-model-discovery', request: { subtype: 'list_models' } })
    expect(MODEL_PROBES.claude.stdin).toBe(CLAUDE_MODEL_LIST_STDIN)
  })

  it('reads the models; skips "default" and disabled placeholder rows', () => {
    const models = parseClaudeModelList(fixture('claude-list-models.jsonl'))
    expect(models.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku', 'claude-opus-4-6'])
    const opus = models[0]
    expect(opus.label).toBe('Opus 5.5')
    expect(opus.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(opus.supportsFastMode).toBe(true)
    expect(models.find((m) => m.id === 'haiku').effortLevels).toEqual([])
    expect(models.find((m) => m.id === 'claude-opus-4-6').effortLevels).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('catalog rows get their own efforts and fast mode', () => {
    const rows = listedToCatalogModels('claude', parseClaudeModelList(fixture('claude-list-models.jsonl')))
    expect(rows[0].options.map((o) => o.id)).toEqual(['effort', 'fastMode'])
    expect(rows.find((m) => m.id === 'haiku').options).toEqual([])
    expect(rows.find((m) => m.id === 'claude-opus-4-6').options[0].kind.choices.map((c) => c.value)).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('an older CLI answering an error lists nothing (the seed stays)', () => {
    const err = JSON.stringify({ type: 'control_response', response: { subtype: 'error', error: 'Unknown' } })
    expect(parseClaudeModelList(err)).toEqual([])
    expect(parseClaudeModelList('not json\n{broken')).toEqual([])
  })
})

describe('Codex: codex debug models', () => {
  it('reads slug, name, efforts and default; leaves out the hidden rows', () => {
    const models = parseCodexModelList(fixture('codex-debug-models.json'))
    expect(models.map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.5'])
    const sol = models.find((m) => m.id === 'gpt-5.6-sol')
    expect(sol.label).toBe('GPT-5.6-Sol')
    expect(sol.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(sol.defaultEffort).toBe('low')
    const rows = listedToCatalogModels('codex', models)
    expect(rows.find((m) => m.id === 'gpt-5.5').options[0].kind.choices.map((c) => c.value)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(parseCodexModelList('nope')).toEqual([])
  })
})

describe('Grok: grok models', () => {
  it('reads the bullets under "Available models:" and the (default) mark', () => {
    const out = ['Logged in as a.b@c.d', 'Default model: grok-4.6', '', 'Available models:', '* grok-4.6 (default)', '- grok-4.5', '', '- hint row'].join('\n')
    expect(parseGrokModelList(out)).toEqual([
      { id: 'grok-4.6', label: 'Grok 4.6', isDefault: true },
      { id: 'grok-4.5', label: 'Grok 4.5' }
    ])
    expect(labelFromModelId('gpt-5.5-codex')).toBe('GPT 5.5 Codex')
  })
})

describe('OpenCode: opencode models', () => {
  it('runs `opencode models` with stdin closed (no prompt)', () => {
    expect(OPENCODE_MODEL_LIST_ARGS).toEqual(['models'])
    expect(MODEL_PROBES.opencode).toMatchObject({ exe: 'opencode', args: ['models'], stdin: null })
  })

  it('reads one provider/model per line; skips log lines and duplicates', () => {
    const models = parseOpenCodeModelList(fixture('opencode-models.txt'))
    expect(models[0]).toEqual({ id: 'opencode/big-pickle', label: 'Opencode Big Pickle' })
    expect(models.map((m) => m.id)).toEqual([
      'opencode/big-pickle',
      'opencode/ling-3.0-flash-fin-free',
      'opencode/longcat-2.5-preview-free',
      'opencode/mimo-v2.6-flash-free',
      'opencode/muse-spark-1.3-contributor-free',
      'opencode/nemotron-3-ultra-free',
      'opencode/nemotron-3.5-lightning-free',
      'opencode/space-bunny-free',
      'openrouter/qwen/qwen3-coder:free'
    ])
    expect(parseOpenCodeModelList('a/b\r\nc/d\re/f')).toHaveLength(3)
    expect(parseOpenCodeModelList('no-slash\n/nope\nx/y z\n-x/y\n{"id":"a/b"}')).toEqual([])
  })

  it('bounded: at most 300 rows, and nothing from an oversized output', () => {
    const many = Array.from({ length: 400 }, (_, i) => `p/m-${i}`).join('\n')
    expect(parseOpenCodeModelList(many)).toHaveLength(300)
    expect(parseOpenCodeModelList('p/m\n' + 'x'.repeat(5 * 1024 * 1024))).toEqual([])
  })

  it('catalog rows have no options (no effort at launch); the checked rows keep the ids', () => {
    const listed = validListedModels(parseOpenCodeModelList(fixture('opencode-models.txt')))
    expect(listed).toHaveLength(9)
    expect(listedToCatalogModels('opencode', listed).every((m) => m.options.length === 0)).toBe(true)
    expect(finalizeProbeOutput('opencode', fixture('opencode-models.txt'), '', 0).models).toHaveLength(9)
    expect(finalizeProbeOutput('opencode', '', 'Error: something\n', 0)).toEqual({ ok: false, reason: 'empty', detail: '' })
  })
})

describe('a finished probe', () => {
  it("exit code, empty answers, stderr (Orca's finalize)", () => {
    expect(finalizeProbeOutput('codex', '', 'boom\nnot signed in', 1)).toEqual({ ok: false, reason: 'failed', detail: '1: boom not signed in' })
    expect(finalizeProbeOutput('codex', '{"models":[]}', '', 0)).toEqual({ ok: false, reason: 'empty', detail: '' })
    const ok = finalizeProbeOutput('claude', '', fixture('claude-list-models.jsonl'), 0)
    expect(ok.ok).toBe(true)
    expect(ok.models).toHaveLength(4)
    expect(finalizeProbeOutput('aider', '', '', 0).reason).toBe('unsupported')
  })

  it('rows from disk or IPC are checked', () => {
    expect(
      validListedModels([
        { id: 'opus', label: 'Opus', effortLevels: ['low', 'BAD', 3], supportsFastMode: true },
        { id: 'x y', label: 'bad' },
        { id: 'opus', label: 'dup' },
        null
      ])
    ).toEqual([{ id: 'opus', label: 'Opus', effortLevels: ['low'], supportsFastMode: true }])
  })
})
