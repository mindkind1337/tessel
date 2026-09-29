// Orca's "model per agent" (agentSessionOptions.js): catalog -> launch flags,
// the user's own flags win, and nothing without an explicit selection.
import { describe, it, expect } from 'vitest'
import {
  resolveAgentSessionOptionLaunch,
  sessionOptionLaunchText,
  resolveSessionOptionDefaults,
  updateSessionOptionDefaults,
  clearSessionOptionModel,
  clearSessionOptionValue,
  validSessionOptionSettings,
  validPaneSessionOptions,
  catalogModelsFor,
  getAgentSessionOptionCatalog,
  hasFlag,
  removeAgentArgOption,
  tokenizeArgs,
  modelOptions
} from '../agentSessionOptions'
import { effectiveAgent, launchSignature, launchIsYolo, launchSessionValues } from '../agentPrefs'
import { listedToCatalogModels } from '../agentModelProbe'

const claude = { id: 'claude', command: 'claude' }
const codex = { id: 'codex', command: 'codex' }

describe('catalog -> launch arguments', () => {
  it("Claude: --model <id> and --effort, Orca's flags", () => {
    expect(sessionOptionLaunchText('claude', { model: 'opus', effort: 'high' })).toBe('--model opus --effort high')
    expect(sessionOptionLaunchText('claude', { model: 'haiku' })).toBe('--model haiku')
  })

  it('Codex: -m <id> and -c model_reasoning_effort=', () => {
    expect(sessionOptionLaunchText('codex', { model: 'gpt-5.5', effort: 'xhigh' })).toBe('-m gpt-5.5 -c model_reasoning_effort=xhigh')
  })

  it("Grok's --reasoning-effort, Gemini's -m, Cursor's composed model name", () => {
    expect(sessionOptionLaunchText('grok', { model: 'grok-4.6', effort: 'low' })).toBe('-m grok-4.6 --reasoning-effort low')
    expect(sessionOptionLaunchText('gemini', { model: 'gemini-2.5-pro' })).toBe('-m gemini-2.5-pro')
    expect(sessionOptionLaunchText('cursor', { model: 'gpt-5.3-codex', effort: 'high', fastMode: true })).toBe('--model gpt-5.3-codex-high-fast')
  })

  it("Orca's resolver adds the catalog defaults when asked (Tessel never asks)", () => {
    expect(resolveAgentSessionOptionLaunch('claude', { model: 'opus' }).args).toEqual(['--model', 'opus', '--effort', 'high'])
    expect(resolveAgentSessionOptionLaunch('claude', { model: 'opus' }, [], false).args).toEqual(['--model', 'opus'])
  })

  it('an effort a model does not offer is dropped for an unknown model', () => {
    expect(sessionOptionLaunchText('codex', { model: 'gpt-9', effort: 'ultra' })).toBe('-m gpt-9')
    expect(sessionOptionLaunchText('codex', { model: 'gpt-9', effort: 'high' })).toBe('-m gpt-9 -c model_reasoning_effort=high')
  })

  it("a listed model keeps its own efforts (the CLI's list)", () => {
    const models = listedToCatalogModels('codex', [{ id: 'gpt-9', label: 'GPT-9', effortLevels: ['low', 'ultra'] }])
    expect(sessionOptionLaunchText('codex', { model: 'gpt-9', effort: 'ultra' }, '', models)).toBe('-m gpt-9 -c model_reasoning_effort=ultra')
  })

  it('an id a shell could misread is never typed', () => {
    expect(sessionOptionLaunchText('claude', { model: 'opus; rm -rf x' })).toBe('')
    expect(sessionOptionLaunchText('claude', { model: 'opus', effort: 'high&calc' })).toBe('')
    expect(sessionOptionLaunchText('claude', { model: 'opus[1m]' })).toBe('--model opus[1m]')
  })
})

describe("the user's own arguments win", () => {
  it('a --model in the agent arguments: Tessel adds no model flag at all', () => {
    expect(sessionOptionLaunchText('claude', { model: 'opus', effort: 'high' }, '--model sonnet')).toBe('')
    expect(sessionOptionLaunchText('claude', { model: 'opus' }, '--model=sonnet')).toBe('')
    expect(sessionOptionLaunchText('codex', { model: 'gpt-5.5' }, '-m o3')).toBe('')
    expect(sessionOptionLaunchText('codex', { model: 'gpt-5.5' }, '--model o3')).toBe('')
  })

  it('an own --effort drops only the effort flag', () => {
    expect(sessionOptionLaunchText('claude', { model: 'opus', effort: 'high' }, '--effort low')).toBe('--model opus')
    expect(sessionOptionLaunchText('codex', { model: 'gpt-5.5', effort: 'high' }, '-c model_reasoning_effort=low')).toBe('-m gpt-5.5')
    expect(sessionOptionLaunchText('codex', { model: 'gpt-5.5', effort: 'high' }, '--config=model_reasoning_effort=low')).toBe('-m gpt-5.5')
  })

  it('effectiveAgent puts the chosen flags before your arguments, which win', () => {
    const prefs = { claude: { args: '--effort low --verbose' } }
    expect(effectiveAgent(claude, prefs, 'manual', { model: 'opus', effort: 'max' }).args).toBe('--model opus --effort low --verbose')
    expect(effectiveAgent(claude, { claude: { args: '--model haiku' } }, 'manual', { model: 'opus' }).args).toBe('--model haiku')
  })

  it("with Yolo: the model flags, then Yolo's", () => {
    const launch = effectiveAgent(claude, {}, 'yolo', { model: 'sonnet' })
    expect(launch.args).toBe('--model sonnet --dangerously-skip-permissions')
    expect(launchIsYolo('claude', launch)).toBe(true)
  })

  it("flag detection: Orca's forms (=value, clustered short flags, stops at --)", () => {
    expect(hasFlag(['-mopus'], ['-m'])).toBe(true)
    expect(hasFlag(['--', '--model', 'x'], ['--model'])).toBe(false)
    expect(removeAgentArgOption(['--model', 'x', '--verbose'], ['--model'])).toEqual(['--verbose'])
    expect(tokenizeArgs('--append "a b" -c \'x=y\'')).toEqual(['--append', 'a b', '-c', 'x=y'])
  })
})

describe('no flags without an explicit selection', () => {
  it('untouched settings: no values, no flags', () => {
    expect(resolveSessionOptionDefaults(undefined, 'claude')).toBeUndefined()
    expect(resolveSessionOptionDefaults({}, 'claude')).toBeUndefined()
    expect(resolveSessionOptionDefaults({ claude: { valuesByModel: { opus: { effort: 'max' } } } }, 'claude')).toBeUndefined()
    expect(effectiveAgent(claude, {}, 'manual', launchSessionValues(null, {}, 'claude')).args).toBe('')
    expect(sessionOptionLaunchText('claude', null)).toBe('')
    expect(sessionOptionLaunchText('claude', { effort: 'high' })).toBe('')
  })

  it("a chosen model brings its saved values; an unset effort stays the agent's", () => {
    let persisted = updateSessionOptionDefaults({ persisted: {}, agent: 'claude', modelId: 'opus', optionId: 'model', value: 'opus' })
    expect(resolveSessionOptionDefaults(persisted, 'claude')).toEqual({ model: 'opus' })
    persisted = updateSessionOptionDefaults({ persisted, agent: 'claude', modelId: 'opus', optionId: 'effort', value: 'max' })
    expect(resolveSessionOptionDefaults(persisted, 'claude')).toEqual({ model: 'opus', effort: 'max' })
    persisted = clearSessionOptionValue({ persisted, agent: 'claude', modelId: 'opus', optionId: 'effort' })
    expect(resolveSessionOptionDefaults(persisted, 'claude')).toEqual({ model: 'opus' })
    // Back to the agent's default: no model, the per-model values are kept.
    persisted = updateSessionOptionDefaults({ persisted, agent: 'claude', modelId: 'opus', optionId: 'effort', value: 'low' })
    persisted = clearSessionOptionModel(persisted, 'claude')
    expect(resolveSessionOptionDefaults(persisted, 'claude')).toBeUndefined()
    expect(persisted.claude.valuesByModel.opus).toEqual({ effort: 'low' })
  })

  it("a pane's own choice wins over the default from Settings", () => {
    const persisted = { codex: { model: 'gpt-5.5', valuesByModel: {} } }
    expect(launchSessionValues(null, persisted, 'codex')).toEqual({ model: 'gpt-5.5' })
    expect(launchSessionValues({ model: 'gpt-5.6-sol' }, persisted, 'codex')).toEqual({ model: 'gpt-5.6-sol' })
  })
})

describe('restart to apply', () => {
  it('a model change changes the launch signature', () => {
    const before = launchSignature(effectiveAgent(codex, {}, 'manual', null))
    const withModel = launchSignature(effectiveAgent(codex, {}, 'manual', { model: 'gpt-5.5' }))
    const otherEffort = launchSignature(effectiveAgent(codex, {}, 'manual', { model: 'gpt-5.5', effort: 'high' }))
    expect(withModel).not.toBe(before)
    expect(otherEffort).not.toBe(withModel)
    // Your own --model wins, so the chosen one changes nothing.
    const own = { codex: { args: '-m o3' } }
    expect(launchSignature(effectiveAgent(codex, own, 'manual', { model: 'gpt-5.5' }))).toBe(launchSignature(effectiveAgent(codex, own, 'manual', null)))
  })
})

describe('OpenCode', () => {
  it('--model provider/model at launch, no effort, its own -m/--model wins', () => {
    expect(sessionOptionLaunchText('opencode', { model: 'opencode/big-pickle' })).toBe('--model opencode/big-pickle')
    expect(sessionOptionLaunchText('opencode', { model: 'openrouter/qwen/qwen3-coder:free' })).toBe('--model openrouter/qwen/qwen3-coder:free')
    expect(sessionOptionLaunchText('opencode', { model: 'opencode/big-pickle', effort: 'high' })).toBe('--model opencode/big-pickle')
    expect(sessionOptionLaunchText('opencode', { model: 'opencode/big-pickle' }, '-m x/y')).toBe('')
    expect(sessionOptionLaunchText('opencode', { model: 'opencode/big-pickle' }, '--model=x/y')).toBe('')
    expect(sessionOptionLaunchText('opencode', null)).toBe('')
  })

  it('a running session opens its own /models picker (typed)', () => {
    const catalog = getAgentSessionOptionCatalog('opencode')
    expect(catalog.modelApply.midSession).toEqual({ kind: 'agent-picker', command: '/models', delivery: 'type' })
    expect(modelOptions(catalog, catalog.models, 'opencode/big-pickle')).toEqual([])
  })

  it('no seed: the picker lists what `opencode models` listed', () => {
    expect(catalogModelsFor('opencode', null)).toEqual([])
    const listed = listedToCatalogModels('opencode', [
      { id: 'opencode/big-pickle', label: 'Opencode Big Pickle' },
      { id: 'anthropic/claude-sonnet-5', label: 'Anthropic Claude Sonnet 5' }
    ])
    expect(catalogModelsFor('opencode', listed).map((m) => m.id)).toEqual(['opencode/big-pickle', 'anthropic/claude-sonnet-5'])
  })
})

describe('model lists', () => {
  it("Claude's listed models replace the seed; others merge; Grok's list decides", () => {
    const listed = listedToCatalogModels('claude', [{ id: 'opus[1m]', label: 'Opus (1M context)', effortLevels: ['low', 'high'], supportsFastMode: true }])
    const claudeModels = catalogModelsFor('claude', listed)
    expect(claudeModels.map((m) => m.id)).toEqual(['opus[1m]'])
    expect(claudeModels[0].options.map((o) => o.id)).toEqual(['effort', 'fastMode'])
    expect(claudeModels[0].options[0].kind.choices.map((c) => c.value)).toEqual(['low', 'high'])
    const codexModels = catalogModelsFor('codex', listedToCatalogModels('codex', [{ id: 'gpt-5.5', label: 'GPT-5.5 (live)' }, { id: 'gpt-7', label: 'GPT-7' }]))
    expect(codexModels.find((m) => m.id === 'gpt-5.5').label).toBe('GPT-5.5 (live)')
    expect(codexModels.at(-1).id).toBe('gpt-7')
    expect(catalogModelsFor('grok', [{ id: 'grok-5', label: 'Grok 5', options: [] }]).map((m) => m.id)).toEqual(['grok-5'])
    expect(catalogModelsFor('claude', null).map((m) => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })

  it('options of a model the catalog does not know are the launch-safe ones', () => {
    const catalog = getAgentSessionOptionCatalog('claude')
    expect(modelOptions(catalog, catalog.models, 'claude-opus-4-8').map((o) => o.id)).toEqual(['effort'])
    expect(modelOptions(catalog, catalog.models, 'haiku')).toEqual([])
  })
})

describe('saved values are checked', () => {
  it('settings from disk keep only well-formed entries', () => {
    const v = validSessionOptionSettings({
      claude: { model: 'opus', valuesByModel: { opus: { effort: 'high', fastMode: true, 'bad id': 'x', evil: 'a b' } } },
      codex: { model: 'x; y' },
      'bad agent!': { model: 'opus' },
      gemini: 'nope'
    })
    expect(v).toEqual({ claude: { model: 'opus', valuesByModel: { opus: { effort: 'high', fastMode: true } } }, codex: { valuesByModel: {} } })
    expect(validPaneSessionOptions({ model: 'sonnet', effort: 'low', x: {} })).toEqual({ model: 'sonnet', effort: 'low' })
    expect(validPaneSessionOptions({ effort: 'low' })).toBeNull()
    expect(validPaneSessionOptions({ model: '$(calc)' })).toBeNull()
  })
})
