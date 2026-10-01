// The model (and effort, fast mode) each agent runs with, from Orca's "model
// per agent" system (github.com/stablyai/orca, MIT, Copyright (c) 2026
// Lovecast Inc.): src/shared/agent-session-option-catalog*.ts,
// agent-session-option-agent-args.ts, agent-cli-flag-detection.ts,
// agent-session-option-launch.ts and native-chat-session-option-defaults.ts.
//
// Each agent has a catalog: its models (a seed, completed by what the agent's
// own CLI lists, see agentModelProbe.js), the options of each model (effort,
// fast mode), how a value goes on the command line (launchArgs) and how it is
// changed in a running session (midSession: a slash command, a toggle, or the
// agent's own picker).
//
// Orca's rule, kept here: no flag unless the user explicitly selected
// something. An untouched agent keeps whatever its own CLI and settings say.
//
// Labels here are English; the interface translates them
// (renderer/src/sessionOptionLabels.js).
import { composeCursorModel, decomposeCursorModel } from './cursorModels'

// --- Arguments (agent-session-option-agent-args.ts, agent-cli-flag-detection.ts)

// The options part of an argument list: everything before a bare "--".
export function agentArgOptionTokens(tokens) {
  const terminator = tokens.indexOf('--')
  return terminator === -1 ? tokens : tokens.slice(0, terminator)
}

// Matches an exact token, the `flag=value` form, and clustered single-dash
// flags (`-mopus`).
export function hasFlag(tokens, flags) {
  return agentArgOptionTokens(tokens).some((token) =>
    flags.some(
      (flag) =>
        token === flag ||
        token.startsWith(`${flag}=`) ||
        (flag.startsWith('-') && !flag.startsWith('--') && token.startsWith(flag))
    )
  )
}

export function removeAgentArgOption(tokens, aliases) {
  const result = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      result.push(...tokens.slice(index))
      break
    }
    const exact = aliases.includes(token)
    const matched = aliases.some(
      (alias) =>
        token.startsWith(`${alias}=`) ||
        (alias.startsWith('-') && !alias.startsWith('--') && token.startsWith(alias) && token.length > alias.length)
    )
    if (!exact && !matched) {
      result.push(token)
      continue
    }
    if (exact && tokens[index + 1] && !tokens[index + 1].startsWith('-')) index += 1
  }
  return result
}

// Words of an argument text as a shell would split them (quotes group,
// and are removed). Enough to find a flag in the user's own arguments.
export function tokenizeArgs(text) {
  const out = []
  const s = String(text || '')
  let cur = ''
  let quote = null
  let has = false
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      continue
    }
    if (/\s/.test(ch)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
      continue
    }
    cur += ch
  }
  if (has || cur) out.push(cur)
  return out
}

// --- Claude and Codex (agent-session-option-catalog-claude-codex.ts) -------

function hasCodexEffortOverride(tokens) {
  if (hasFlag(tokens, ['--reasoning-effort'])) return true
  const optionTokens = agentArgOptionTokens(tokens)
  return optionTokens.some((token, index) => {
    const previous = optionTokens[index - 1]
    return (
      (token.startsWith('model_reasoning_effort=') && (previous === '-c' || previous === '--config')) ||
      token.startsWith('-cmodel_reasoning_effort=') ||
      token.startsWith('-c=model_reasoning_effort=') ||
      token.startsWith('--config=model_reasoning_effort=')
    )
  })
}

function removeCodexEffortOverride(tokens) {
  const withoutFlag = removeAgentArgOption(tokens, ['--reasoning-effort'])
  const result = []
  for (let index = 0; index < withoutFlag.length; index += 1) {
    const token = withoutFlag[index]
    if (token === '--') {
      result.push(...withoutFlag.slice(index))
      break
    }
    const next = withoutFlag[index + 1]
    if ((token === '-c' || token === '--config') && next && next.startsWith('model_reasoning_effort=')) {
      index += 1
      continue
    }
    if (
      token.startsWith('-cmodel_reasoning_effort=') ||
      token.startsWith('-c=model_reasoning_effort=') ||
      token.startsWith('--config=model_reasoning_effort=')
    )
      continue
    result.push(token)
  }
  return result
}

const STANDARD_EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

const EXTENDED_EFFORT_CHOICES = [...STANDARD_EFFORT_CHOICES, { value: 'xhigh', label: 'Extra high' }, { value: 'max', label: 'Max' }]

function claudeEffort(extended) {
  return claudeEffortWithChoices(extended ? EXTENDED_EFFORT_CHOICES : STANDARD_EFFORT_CHOICES)
}

function claudeEffortWithChoices(choices) {
  return {
    id: 'effort',
    label: 'Effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices,
      defaultValue: choices.some((choice) => choice.value === 'high') ? 'high' : choices[0] ? choices[0].value : 'high'
    },
    apply: {
      launchArgs: (value) => ['--effort', String(value)],
      agentArgsOverride: (tokens) => hasFlag(tokens, ['--effort']),
      removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--effort']),
      midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
    }
  }
}

const CLAUDE_FAST_MODE = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', defaultValue: false },
  apply: { midSession: { kind: 'toggle-command', command: '/fast' } }
}

export function createClaudeCatalogOptions({ effortLevelIds, supportsFastMode }) {
  const effortChoices = EXTENDED_EFFORT_CHOICES.filter((choice) => effortLevelIds.includes(choice.value))
  return [...(effortChoices.length > 0 ? [claudeEffortWithChoices(effortChoices)] : []), ...(supportsFastMode ? [CLAUDE_FAST_MODE] : [])]
}

export const CLAUDE_SESSION_OPTION_CATALOG = {
  // Why (Orca): these ids are Claude CLI aliases that resolve to the newest
  // model of each family on the host's CLI, so pinned version labels would lie
  // on part of the fleet. The probed list overlays exact per-host names.
  models: [
    { id: 'fable', label: 'Fable', description: 'Most capable for the hardest, longest-running tasks', options: [claudeEffort(true)] },
    { id: 'opus', label: 'Opus', description: 'Best for everyday, complex tasks', options: [claudeEffort(true), CLAUDE_FAST_MODE] },
    { id: 'sonnet', label: 'Sonnet', description: 'Efficient for routine tasks', isDefault: true, options: [claudeEffort(true)] },
    { id: 'haiku', label: 'Haiku', description: 'Fastest for quick answers', options: [] }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model']),
    midSession: {
      kind: 'command',
      build: (value) => `/model ${String(value)}`,
      pickerCommand: '/model',
      // Claude sometimes confirms a cached-history switch: the prompt is
      // detected and accepted (claudeModelSwitch.js).
      detectAgentInteraction: 'claude-model-switch-confirmation'
    }
  },
  unknownModelOptions: [claudeEffort(true)],
  probed: true
}

const CODEX_EFFORT_CHOICES = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' }
]

// Why (Orca): Codex can clamp higher values, so expose only each model's
// advertised levels.
function codexEffort(ceiling) {
  const ceilingIndex = CODEX_EFFORT_CHOICES.findIndex((choice) => choice.value === ceiling)
  return codexEffortWithChoices(CODEX_EFFORT_CHOICES.slice(0, ceilingIndex + 1))
}

function codexEffortWithChoices(choices, defaultValue = 'medium') {
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: { type: 'select', choices, defaultValue },
    apply: {
      launchArgs: (value) => ['-c', `model_reasoning_effort=${String(value)}`],
      agentArgsOverride: hasCodexEffortOverride,
      removeAgentArgs: removeCodexEffortOverride,
      midSession: { kind: 'agent-picker', command: '/model', delivery: 'type' }
    }
  }
}

// A Codex model the CLI listed (agentModelProbe.js): its own effort levels.
export function createCodexCatalogOptions({ effortLevelIds, defaultEffort }) {
  const known = CODEX_EFFORT_CHOICES.filter((choice) => effortLevelIds.includes(choice.value))
  if (!known.length) return [codexEffort('xhigh')]
  const def = known.some((c) => c.value === defaultEffort) ? defaultEffort : known.some((c) => c.value === 'medium') ? 'medium' : known[0].value
  return [codexEffortWithChoices(known, def)]
}

export const CODEX_SESSION_OPTION_CATALOG = {
  // Why (Orca): Codex model access depends on auth. Keep this seed short and
  // allow unknown persisted ids to pass through.
  models: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', options: [codexEffort('ultra')] },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', options: [codexEffort('ultra')] },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', options: [codexEffort('max')] },
    { id: 'gpt-5.5', label: 'GPT-5.5', options: [codexEffort('xhigh')] },
    { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', options: [codexEffort('xhigh')] }
  ],
  // Once Codex has listed its models (for this account and version), that
  // list decides which are offered: a seed model it no longer lists (GPT-5.2
  // Codex) is not shown. A pane's saved model still runs.
  discoveredModelsAreAuthoritative: true,
  modelApply: {
    launchArgs: (value) => ['-m', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['-m', '--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['-m', '--model']),
    // Codex classifies multi-character writes as pasted prose; type the bare
    // command and let its own picker apply the account-supported model.
    midSession: { kind: 'agent-picker', command: '/model', delivery: 'type' }
  },
  unknownModelOptions: [codexEffort('xhigh')],
  probed: true
}

// --- Gemini, Cursor (agent-session-option-catalog-gemini-cursor.ts) --------

const hasModelFlag = (tokens) => hasFlag(tokens, ['-m', '--model'])

export const GEMINI_SESSION_OPTION_CATALOG = {
  models: [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', options: [] },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', options: [] },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', options: [] },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', options: [] }
  ],
  modelApply: {
    launchArgs: (value) => ['-m', String(value)],
    agentArgsOverride: hasModelFlag,
    midSession: { kind: 'agent-picker', command: '/model' }
  }
}

const CURSOR_EFFORT = {
  id: 'effort',
  label: 'Effort',
  category: 'thought_level',
  kind: { type: 'select', choices: STANDARD_EFFORT_CHOICES, defaultValue: 'high' },
  apply: { composedIntoModel: true }
}
const CURSOR_FAST = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', defaultValue: false },
  apply: { composedIntoModel: true }
}
const CURSOR_THINKING = {
  id: 'thinking',
  label: 'Thinking',
  category: 'model_config',
  kind: { type: 'boolean', defaultValue: true },
  apply: { composedIntoModel: true }
}

export const CURSOR_SESSION_OPTION_CATALOG = {
  probed: true,
  // Its list is what the CLI accepts: a seed id it does not list (or one
  // composed the seed's way) would fail at launch. A pane's saved model
  // still runs.
  discoveredModelsAreAuthoritative: true,
  models: [
    { id: 'auto', label: 'Auto', isDefault: true, options: [] },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', options: [CURSOR_EFFORT, CURSOR_FAST] },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', options: [CURSOR_THINKING, CURSOR_EFFORT] }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: hasModelFlag,
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['-m', '--model']),
    midSession: { kind: 'command', build: (value) => `/model ${String(value)}` }
  },
  // model: the picker's row. A row grouped from Cursor's own list composes
  // into one of the ids it listed; the seed rows keep Orca's spelling.
  composeModelValue: (modelId, values, model) => {
    if (model && Array.isArray(model.variants)) return composeCursorModel(model, values)
    if (modelId === 'auto') return modelId
    if (modelId.startsWith('claude-')) {
      const thinking = values.thinking === true ? '-thinking' : ''
      const effort = typeof values.effort === 'string' ? `-${values.effort}` : ''
      return `${modelId}${thinking}${effort}`
    }
    const effort = typeof values.effort === 'string' ? `-${values.effort}` : ''
    const fast = values.fastMode === true ? '-fast' : ''
    return `${modelId}${effort}${fast}`
  }
}

// --- Grok (agent-session-option-catalog-grok.ts) ----------------------------

const GROK_EFFORT_CHOICES = [...STANDARD_EFFORT_CHOICES, { value: 'xhigh', label: 'Extra high' }]

function grokEffort(ceiling) {
  const ceilingIndex = GROK_EFFORT_CHOICES.findIndex((choice) => choice.value === ceiling)
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: { type: 'select', choices: GROK_EFFORT_CHOICES.slice(0, ceilingIndex + 1), defaultValue: 'high' },
    apply: {
      launchArgs: (value) => ['--reasoning-effort', String(value)],
      agentArgsOverride: (tokens) => hasFlag(tokens, ['--effort', '--reasoning-effort']),
      midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
    }
  }
}

export const GROK_SESSION_OPTION_CATALOG = {
  models: [
    { id: 'grok-4.6', label: 'Grok 4.6', description: "xAI's latest frontier model", isDefault: true, options: [grokEffort('xhigh')] },
    { id: 'grok-4.5', label: 'Grok 4.5', description: "xAI's previous frontier model", options: [grokEffort('high')] }
  ],
  modelApply: {
    launchArgs: (value) => ['-m', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['-m', '--model']),
    midSession: { kind: 'command', build: (value) => `/model ${String(value)}` }
  },
  unknownModelOptions: [grokEffort('xhigh')],
  // Why (Orca): grok's selectable ids retire between releases, so a stale
  // seed entry must be droppable: picking one is a fatal launch.
  discoveredModelsAreAuthoritative: true,
  defaultModelIsCliDefault: true,
  probed: true
}

// --- Antigravity (agent-session-option-catalog-antigravity.ts) --------------

const ANTIGRAVITY_EFFORT = {
  id: 'effort',
  label: 'Reasoning effort',
  category: 'thought_level',
  kind: { type: 'select', choices: STANDARD_EFFORT_CHOICES, defaultValue: 'high' },
  apply: {
    launchArgs: (value) => ['--effort', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--effort']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--effort']),
    midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
  }
}

export const ANTIGRAVITY_SESSION_OPTION_CATALOG = {
  // Model availability is account-scoped: no seed.
  models: [],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model']),
    midSession: { kind: 'agent-picker', command: '/model' }
  },
  unknownModelOptions: [ANTIGRAVITY_EFFORT],
  probed: true
}

// --- OpenCode (Orca's commit-message-agent-specs-primary.ts: `--model
// provider/model`, models from `opencode models`) ---------------------------

export const OPENCODE_SESSION_OPTION_CATALOG = {
  // Which providers and models exist depends on the user's sign-ins and
  // config (the free opencode/* ones rotate): no seed, the CLI's list only.
  models: [],
  modelApply: {
    // The TUI (`opencode [project]`) takes -m/--model provider/model. Its
    // --variant (effort) exists on `opencode run` only, so no effort option.
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['-m', '--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['-m', '--model']),
    // A running TUI switches model in its own /models picker.
    midSession: { kind: 'agent-picker', command: '/models', delivery: 'type' }
  },
  unknownModelOptions: [],
  probed: true
}

// --- Pi, Amp, Kimi and Copilot (commit-message-agent-specs-primary.ts /
// secondary.ts, MIT, Copyright (c) 2026 Lovecast Inc.). See MODEL_PICKERS.md
// for CLI verification and deliberately omitted, unconfirmed options.

function flagApply(flag, aliases = [flag], midSession) {
  return {
    launchArgs: (value) => [flag, String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, aliases),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, aliases),
    ...(midSession ? { midSession } : {})
  }
}

function flaggedEffort(choices, flag, aliases = [flag], midSession) {
  return {
    id: 'effort', label: 'Reasoning effort', category: 'thought_level',
    kind: { type: 'select', choices, defaultValue: 'low' },
    apply: flagApply(flag, aliases, midSession)
  }
}

const PI_EFFORT_CHOICES = [{ value: 'off', label: 'Off' }, ...STANDARD_EFFORT_CHOICES, { value: 'xhigh', label: 'Extra high' }]
export function createPiCatalogOptions(levels) {
  const choices = PI_EFFORT_CHOICES.filter((choice) => levels.includes(choice.value))
  return choices.length ? [flaggedEffort(choices, '--thinking', ['--thinking'], { kind: 'agent-picker', command: '/thinking' })] : []
}

export const PI_SESSION_OPTION_CATALOG = {
  models: [], probed: true,
  modelApply: flagApply('--model', ['--model'], { kind: 'agent-picker', command: '/model' }),
  unknownModelOptions: []
}

export const AMP_SESSION_OPTION_CATALOG = {
  models: ['smart', 'rush', 'large', 'deep'].map((id) => ({
    id, label: id.charAt(0).toUpperCase() + id.slice(1),
    options: ['large', 'deep'].includes(id) ? [flaggedEffort(STANDARD_EFFORT_CHOICES, '--effort')] : []
  })),
  modelApply: flagApply('--mode'),
  unknownModelOptions: []
}

export const KIMI_SESSION_OPTION_CATALOG = {
  models: [{ id: 'kimi-code/kimi-for-coding', label: 'Kimi K2.6', options: [] }],
  modelApply: flagApply('--model', ['-m', '--model']),
  unknownModelOptions: []
}

const COPILOT_MODELS = [
  ['auto', 'Auto'], ['claude-haiku-4.5', 'Claude Haiku 4.5'],
  ['claude-sonnet-4.5', 'Claude Sonnet 4.5'], ['claude-sonnet-4.6', 'Claude Sonnet 4.6'],
  ['claude-opus-4.5', 'Claude Opus 4.5'], ['claude-opus-4.6', 'Claude Opus 4.6'],
  ['claude-opus-4.6-fast', 'Claude Opus 4.6 Fast'], ['claude-opus-4.7', 'Claude Opus 4.7'],
  ['gpt-4.1', 'GPT-4.1'], ['gpt-5-mini', 'GPT-5 mini'], ['gpt-5.2', 'GPT-5.2'],
  ['gpt-5.2-codex', 'GPT-5.2 Codex'], ['gpt-5.3-codex', 'GPT-5.3 Codex'],
  ['gpt-5.4', 'GPT-5.4'], ['gpt-5.4-mini', 'GPT-5.4 mini'], ['gpt-5.5', 'GPT-5.5']
]
export const COPILOT_SESSION_OPTION_CATALOG = {
  models: COPILOT_MODELS.map(([id, label]) => ({
    id, label,
    options: id.startsWith('gpt-5') ? [flaggedEffort(
      [...STANDARD_EFFORT_CHOICES, { value: 'xhigh', label: 'Extra high' }],
      '--reasoning-effort', ['--reasoning-effort', '--effort']
    )] : []
  })),
  modelApply: flagApply('--model', ['--model'], { kind: 'agent-picker', command: '/model' }),
  unknownModelOptions: []
}

// --- Catalog lookups (agent-session-option-catalog.ts) ----------------------

const CATALOGS = {
  pi: PI_SESSION_OPTION_CATALOG,
  amp: AMP_SESSION_OPTION_CATALOG,
  kimi: KIMI_SESSION_OPTION_CATALOG,
  copilot: COPILOT_SESSION_OPTION_CATALOG,
  antigravity: ANTIGRAVITY_SESSION_OPTION_CATALOG,
  claude: CLAUDE_SESSION_OPTION_CATALOG,
  codex: CODEX_SESSION_OPTION_CATALOG,
  gemini: GEMINI_SESSION_OPTION_CATALOG,
  cursor: CURSOR_SESSION_OPTION_CATALOG,
  grok: GROK_SESSION_OPTION_CATALOG,
  opencode: OPENCODE_SESSION_OPTION_CATALOG
}

export function getAgentSessionOptionCatalog(agent) {
  return (agent && Object.prototype.hasOwnProperty.call(CATALOGS, agent) && CATALOGS[agent]) || null
}

// Agents whose model a Tessel pane can choose (a catalog with models, or
// one that accepts any model id).
export function agentHasModelChoice(agent) {
  return !!getAgentSessionOptionCatalog(agent)
}

export function findCatalogModel(catalog, modelId) {
  return catalog.models.find((model) => model.id === modelId)
}

export function findCatalogOption(model, optionId) {
  return model ? model.options.find((option) => option.id === optionId) : undefined
}

// The options shown for a model: its own, or (a model the catalog does not
// know) the catalog's launch-safe ones.
export function modelOptions(catalog, models, modelId) {
  if (!catalog || !modelId) return []
  const model = (models || catalog.models).find((m) => m.id === modelId) || findCatalogModel(catalog, modelId)
  return model ? model.options : catalog.unknownModelOptions || []
}

/** Merge live rows over the static seed while retaining cataloged option mappings. */
export function mergeCatalogModels(seed, discovered) {
  const discoveredById = new Map(discovered.map((model) => [model.id, model]))
  const merged = seed.map((model) => {
    const live = discoveredById.get(model.id)
    if (!live) return model
    discoveredById.delete(model.id)
    return { ...model, ...live, options: model.options }
  })
  return [...merged, ...discoveredById.values()]
}

/** Discovery decides membership; the seed keeps its option menus. */
export function mergeDiscoveredAuthoritativeModels(seed, discovered) {
  const inheritedOptions = ((seed.find((model) => model.isDefault) || seed[0]) || {}).options || []
  return discovered.map((disc) => {
    const seedMatch = seed.find((model) => model.id === disc.id)
    // eslint-disable-next-line no-unused-vars
    // A row from Cursor's grouped list keeps its own options (none for a
    // model listed once): only those compose into ids the CLI listed.
    const { isDefault: _seeded, ...merged } = seedMatch ? { ...seedMatch, ...disc, options: disc.variants ? disc.options : seedMatch.options } : { ...disc, options: disc.options && disc.options.length ? disc.options : disc.variants ? [] : inheritedOptions }
    return disc.isDefault ? { ...merged, isDefault: true } : merged
  })
}

// The models a picker lists for an agent: the seed, with what its CLI listed
// (Orca's native-chat-session-option-enrichment.ts: Claude's own list
// replaces the seed; an authoritative list decides membership; otherwise
// live rows are merged over the seed).
export function catalogModelsFor(agent, discovered) {
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog) return []
  if (!Array.isArray(discovered) || discovered.length === 0) return catalog.models
  if (agent === 'claude') return [...discovered]
  if (catalog.discoveredModelsAreAuthoritative) return mergeDiscoveredAuthoritativeModels(catalog.models, discovered)
  return mergeCatalogModels(catalog.models, discovered)
}

// The exact id the agent runs for a model row and its values (Cursor's
// grouped rows compose into one listed id; others are the row's id).
export function composedModelId(agent, values, models = null) {
  const catalog = getAgentSessionOptionCatalog(agent)
  const modelId = values && typeof values.model === 'string' ? values.model : null
  if (!catalog || !modelId || !catalog.composeModelValue) return modelId
  const model = (Array.isArray(models) && models.find((m) => m.id === modelId)) || findCatalogModel(catalog, modelId)
  if (!model) return modelId
  const opts = model.options || []
  const picked = Object.fromEntries(opts.filter((o) => values[o.id] !== undefined && values[o.id] !== null).map((o) => [o.id, values[o.id]]))
  return catalog.composeModelValue(modelId, picked, model)
}

// An id the agent reports (or a pane saved) -> the picker row it belongs to
// and the values that make it: { model, effort?, fastMode?, thinking? }.
// A listed row's own id -> { model: id }; an unknown id -> null.
export function listedModelValues(models, id) {
  if (typeof id !== 'string' || !id) return null
  return decomposeCursorModel(models, id) || ((models || []).some((m) => m.id === id) ? { model: id } : null)
}

// Values whose model is an exact variant id (gpt-5.3-codex-high-fast, a
// choice saved from Cursor's flat list or reported by the agent) -> its row's
// id with the options that make it, so a picker shows that row selected.
export function valuesOnListedRow(models, values) {
  if (!values || typeof values.model !== 'string' || (models || []).some((m) => m.id === values.model)) return values
  const listed = decomposeCursorModel(models, values.model)
  return listed ? { ...values, ...listed } : values
}

export function sessionOptionValueIsValid(value) {
  return typeof value === 'string' || typeof value === 'boolean'
}

// --- Launch (agent-session-option-launch.ts) --------------------------------

export function removeOverriddenAgentSessionArgs(agent, values, tokens) {
  const catalog = getAgentSessionOptionCatalog(agent)
  const modelId = values && typeof values.model === 'string' ? values.model : null
  if (!catalog || !values || !modelId) return [...tokens]
  let result = catalog.modelApply.removeAgentArgs ? catalog.modelApply.removeAgentArgs(tokens) : [...tokens]
  const model = findCatalogModel(catalog, modelId)
  const opts = model ? model.options : catalog.unknownModelOptions || []
  for (const option of opts) {
    if (values[option.id] !== undefined && option.apply.removeAgentArgs) result = option.apply.removeAgentArgs(result)
  }
  return result
}

// -> { args, appliedValues }: the flags for these values (Orca's
// resolveAgentSessionOptionLaunch). trailingAgentArgs: the user's own
// arguments, which win (a value they override is not "applied").
// models: the list the picker showed (the seed with what the CLI listed), so
// a listed model the seed does not know keeps its own options.
export function resolveAgentSessionOptionLaunch(agent, values, trailingAgentArgs = [], includeCatalogDefaults = true, models = null) {
  const catalog = getAgentSessionOptionCatalog(agent)
  const modelId = values && typeof values.model === 'string' ? values.model : null
  if (!catalog || !values || !modelId) return { args: [], appliedValues: {} }

  const model = (Array.isArray(models) && models.find((m) => m.id === modelId)) || findCatalogModel(catalog, modelId)
  const appliedValues = {}
  const args = []
  const opts = model ? model.options : catalog.unknownModelOptions || []
  const modelValues = Object.fromEntries(
    opts.flatMap((option) => {
      const explicitValue = values[option.id]
      if (explicitValue !== undefined) {
        if (!model && option.kind.type === 'select' && !option.kind.choices.some((choice) => choice.value === explicitValue)) return []
        return [[option.id, explicitValue]]
      }
      return model && includeCatalogDefaults ? [[option.id, option.kind.defaultValue]] : []
    })
  )
  const composedModelId = catalog.composeModelValue ? catalog.composeModelValue(modelId, modelValues, model) : modelId
  const modelOverridden = !!(catalog.modelApply.agentArgsOverride && catalog.modelApply.agentArgsOverride(trailingAgentArgs) === true)

  if (catalog.modelApply.launchArgs) {
    args.push(...catalog.modelApply.launchArgs(composedModelId))
    if (!modelOverridden) appliedValues.model = modelId
  }
  for (const option of opts) {
    const value = modelValues[option.id]
    if (value === undefined) continue
    if (option.apply.composedIntoModel) {
      if (catalog.modelApply.launchArgs && !modelOverridden) appliedValues[option.id] = value
      continue
    }
    if (!option.apply.launchArgs) continue
    args.push(...option.apply.launchArgs(value))
    if (!modelOverridden && !(option.apply.agentArgsOverride && option.apply.agentArgsOverride(trailingAgentArgs))) appliedValues[option.id] = value
  }
  return { args, appliedValues }
}

// A value Tessel may type into a shell after the agent's command: model ids
// and effort levels only ever look like this (never quotes, spaces, ; & | $).
const SAFE_ARG = /^[A-Za-z0-9._:/@[\]=+-]{1,160}$/
// A value (model id, option value) starts with a letter or digit: never a
// flag of its own (--yolo, -y) slipped in as a "model".
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]=+-]{0,159}$/
export function safeSessionValue(v) {
  return typeof v === 'string' && SAFE_VALUE.test(v)
}

// The flags Tessel adds to an agent's launch line for these values, as
// text. Orca's rules: nothing without an explicitly selected model; an option
// only when it was explicitly selected too (Tessel never adds a catalog
// default the user did not pick); a flag the user's own arguments set wins
// (Tessel leaves its own out, so the CLI never sees it twice).
export function sessionOptionLaunchText(agent, values, userArgs = '', models = null) {
  if (!values || !safeSessionValue(values.model)) return ''
  for (const [id, v] of Object.entries(values)) if (id !== 'model' && v != null && typeof v !== 'boolean' && !safeSessionValue(v)) return ''
  const userTokens = tokenizeArgs(userArgs)
  const { args } = resolveAgentSessionOptionLaunch(agent, values, userTokens, false, models)
  if (!args.length) return ''
  const catalog = getAgentSessionOptionCatalog(agent)
  const modelOverridden = !!(catalog.modelApply.agentArgsOverride && catalog.modelApply.agentArgsOverride(userTokens))
  if (modelOverridden) return ''
  const kept = removeUserOverridden(agent, values, args, userTokens, models)
  if (!kept.every((a) => SAFE_ARG.test(a))) return ''
  return kept.join(' ')
}

// Drops each option's flag the user's own arguments already set.
function removeUserOverridden(agent, values, args, userTokens, models) {
  const catalog = getAgentSessionOptionCatalog(agent)
  const model = (Array.isArray(models) && models.find((m) => m.id === values.model)) || findCatalogModel(catalog, values.model)
  const opts = model ? model.options : catalog.unknownModelOptions || []
  let kept = [...args]
  for (const option of opts) {
    if (values[option.id] === undefined || !option.apply.launchArgs || option.apply.composedIntoModel) continue
    if (option.apply.agentArgsOverride && option.apply.agentArgsOverride(userTokens)) {
      const own = option.apply.launchArgs(values[option.id])
      const at = indexOfRun(kept, own)
      if (at >= 0) kept = [...kept.slice(0, at), ...kept.slice(at + own.length)]
    }
  }
  return kept
}

function indexOfRun(list, run) {
  for (let i = 0; i + run.length <= list.length; i++) {
    if (run.every((x, j) => list[i + j] === x)) return i
  }
  return -1
}

// --- Saved defaults (native-chat-session-option-defaults.ts) ----------------
// Settings: { [agent]: { model?, valuesByModel: { [model]: { effort, … } } } }

export function resolveSessionOptionDefaults(persisted, agent) {
  const entry = persisted && persisted[agent]
  // Why (Orca): untouched settings must preserve the agent CLI's configured
  // defaults; only a model explicitly selected by the user authorizes launch
  // flags.
  const modelId = entry && typeof entry.model === 'string' && entry.model.trim() ? entry.model : undefined
  if (!modelId) return undefined
  const values = { model: modelId }
  const storedValues = entry.valuesByModel && entry.valuesByModel[modelId]
  if (storedValues && typeof storedValues === 'object') {
    for (const [id, value] of Object.entries(storedValues)) {
      if (sessionOptionValueIsValid(value)) values[id] = value
    }
  }
  return values
}

export function updateSessionOptionDefaults({ persisted, agent, modelId, optionId, value, adoptModelAsLaunchDefault }) {
  const currentAgent = (persisted && persisted[agent]) || {}
  const currentModelValues = (currentAgent.valuesByModel && currentAgent.valuesByModel[modelId]) || {}
  const valuesByModel = {
    ...currentAgent.valuesByModel,
    ...(optionId === 'model' ? {} : { [modelId]: { ...currentModelValues, [optionId]: value } })
  }
  return {
    ...persisted,
    [agent]: {
      ...currentAgent,
      ...(adoptModelAsLaunchDefault === false ? {} : { model: optionId === 'model' ? String(value) : modelId }),
      valuesByModel
    }
  }
}

// Removes an option value (back to the agent's own default).
export function clearSessionOptionValue({ persisted, agent, modelId, optionId }) {
  const currentAgent = (persisted && persisted[agent]) || {}
  const values = { ...((currentAgent.valuesByModel && currentAgent.valuesByModel[modelId]) || {}) }
  delete values[optionId]
  return { ...persisted, [agent]: { ...currentAgent, valuesByModel: { ...currentAgent.valuesByModel, [modelId]: values } } }
}

/** Drops only `model` (Orca's clearNativeChatSessionOptionModel): the agent
 *  runs its own default again; the per-model values stay for a later pick. */
export function clearSessionOptionModel(persisted, agent) {
  const currentAgent = persisted && persisted[agent]
  if (!currentAgent || !currentAgent.model) return { ...persisted }
  // eslint-disable-next-line no-unused-vars
  const { model: _dropped, ...rest } = currentAgent
  return { ...persisted, [agent]: rest }
}

const ID_RE = /^[\w.-]{1,60}$/
const VALUE_ID_RE = /^[A-Za-z][\w]{0,39}$/
const shortString = (v) => typeof v === 'string' && v.length > 0 && v.length <= 160

// Only well-formed entries (settings from disk).
export function validSessionOptionSettings(v) {
  const out = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [agent, entry] of Object.entries(v).slice(0, 60)) {
    if (!ID_RE.test(agent) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const e = {}
    if (shortString(entry.model) && SAFE_VALUE.test(entry.model)) e.model = entry.model
    const byModel = {}
    if (entry.valuesByModel && typeof entry.valuesByModel === 'object' && !Array.isArray(entry.valuesByModel)) {
      for (const [modelId, values] of Object.entries(entry.valuesByModel).slice(0, 100)) {
        if (!shortString(modelId) || !values || typeof values !== 'object' || Array.isArray(values)) continue
        const kept = {}
        for (const [id, value] of Object.entries(values).slice(0, 10)) {
          if (!VALUE_ID_RE.test(id)) continue
          if (typeof value === 'boolean' || (shortString(value) && SAFE_VALUE.test(value))) kept[id] = value
        }
        byModel[modelId] = kept
      }
    }
    e.valuesByModel = byModel
    out[agent] = e
  }
  return out
}

// A pane's own choice ({ model, effort?, fastMode? }) from a saved layout,
// or null.
export function validPaneSessionOptions(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  if (!shortString(v.model) || !SAFE_VALUE.test(v.model)) return null
  const out = { model: v.model }
  for (const [id, value] of Object.entries(v).slice(0, 10)) {
    if (id === 'model' || !VALUE_ID_RE.test(id)) continue
    if (typeof value === 'boolean' || (shortString(value) && SAFE_VALUE.test(value))) out[id] = value
  }
  return out
}
