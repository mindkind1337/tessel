// Asking an agent's own CLI which models it offers, from Orca
// (github.com/stablyai/orca, MIT, Copyright (c) 2026 Lovecast Inc.):
// src/shared/claude-model-list-probe.ts, commit-message-model-parsers.ts
// (parseCodexModels), grok-model-list-probe.ts, model-id-label.ts,
// agent-model-probe-spec.ts, commit-message-agent-specs-primary.ts
// (OpenCode's modelDiscovery, parseLineModels) and
// src/main/text-generation/commit-message-model-discovery-policy.ts.
//
// Never an interactive session, never a prompt:
// - Claude Code: one `list_models` control request over --print stream-json
//   returns the CLI's /model picker catalog without starting an API turn.
// - Codex: `codex debug models` renders its model catalog as JSON.
// - Grok: `grok models` prints its listing.
// - OpenCode: `opencode models` prints one provider/model id per line.
// - Muse Code: `muse serve` answers model/list (its session protocol, a
//   query: no session, no turn) with each model, its efforts and its default
//   (src/main/museServe.js).
// The CLI may use its own sign-in and network to answer, so Tessel runs a
// probe only when asked (Settings > Agents > Refresh models) and keeps the
// answer (agentModelList.js).
import { createClaudeCatalogOptions, createCodexCatalogOptions, createPiCatalogOptions, createAntigravityCatalogOptions, createMuseCatalogOptions } from './agentSessionOptions'
import { groupCursorModels } from './cursorModels'
import { groupAntigravityModels } from './antigravityModels'

// Why (Orca): the Claude CLI has no model-listing subcommand (`claude models`
// starts a chat session). CLIs that predate the request answer
// {"subtype":"error"} and still exit 0: no models, the seed list stays.
export const CLAUDE_MODEL_LIST_STDIN = `${JSON.stringify({
  type: 'control_request',
  request_id: 'orca-model-discovery',
  request: { subtype: 'list_models' }
})}\n`

// Why (Orca): --print rejects stream-json output unless --verbose is set.
export const CLAUDE_MODEL_LIST_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']

export const CODEX_MODEL_LIST_ARGS = ['debug', 'models']
export const GROK_MODEL_LIST_ARGS = ['models']
export const OPENCODE_MODEL_LIST_ARGS = ['models']
export const PI_MODEL_LIST_ARGS = ['--list-models']
export const CURSOR_MODEL_LIST_ARGS = ['--list-models']
export const ANTIGRAVITY_MODEL_LIST_ARGS = ['models']

// Orca's limits (source-control-generation-limits.ts).
export const MODEL_PROBE_TIMEOUT_MS = 60_000
export const MODEL_PROBE_MAX_OUTPUT = 4 * 1024 * 1024
const MAX_LINE = 512 * 1024

export function labelFromModelId(id) {
  return String(id)
    .split(/[/-]/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return 'GPT'
      return part.length <= 3 && /^\d/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

function toListedClaudeModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = typeof value.value === 'string' ? value.value.trim() : ''
  // Why (Orca): the CLI advertises models it cannot run yet as disabled
  // placeholder rows; selecting one sends that sentinel straight to --model.
  if (!id || value.disabled === true) return null
  const label = typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName : id
  const description = typeof value.description === 'string' && value.description.trim() ? value.description : undefined
  const effortLevels =
    value.supportsEffort === true && Array.isArray(value.supportedEffortLevels)
      ? value.supportedEffortLevels.filter((level) => typeof level === 'string')
      : []
  // The exact model an alias row runs (fable -> claude-fable-5-2): what
  // Tessel sends, since a running Claude Code can take "/model fable" as an
  // older Fable than the one its own picker lists.
  const resolved = typeof value.resolvedModel === 'string' ? value.resolvedModel.trim() : ''
  let runs = resolved !== id && /^claude-[a-z0-9.-]+(\[1m\])?$/i.test(resolved) ? resolved : ''
  // A 1M row runs its 1M context even if the CLI named the model without it.
  if (runs && /\[1m\]$/i.test(id) && !/\[1m\]$/i.test(runs)) runs += '[1m]'
  return { id, label, ...(description ? { description } : {}), effortLevels, supportsFastMode: value.supportsFastMode === true, ...(runs ? { runs } : {}) }
}

// A family alias row listed before Tessel kept what it runs: its exact id
// from its label ("fable" + "Fable 5.2" -> claude-fable-5-2), only for a
// "<Family> <4+>.<n>" label (the ids those take: claude-haiku-4-5, not a
// "Sonnet 4" or "Haiku 3.5" guess); '' otherwise.
export function claudeAliasRuns(id, label) {
  const fam = /^(fable|opus|sonnet|haiku)$/i.exec(String(id || ''))
  const m = /^(fable|opus|sonnet|haiku) (\d{1,2})\.(\d{1,2})$/i.exec(String(label || '').trim())
  if (!fam || !m || m[1].toLowerCase() !== fam[1].toLowerCase() || Number(m[2]) < 4) return ''
  return `claude-${m[1].toLowerCase()}-${m[2]}-${m[3]}`
}

// -> [{ id, label, description?, effortLevels, supportsFastMode }]
export function parseClaudeModelList(stdout) {
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('{') || !line.includes('control_response') || line.length > MAX_LINE) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || parsed.type !== 'control_response' || !parsed.response || parsed.response.subtype !== 'success') continue
    const models = parsed.response.response && parsed.response.response.models
    if (!Array.isArray(models)) continue
    const seen = new Set()
    const listed = []
    for (const entry of models.slice(0, 200)) {
      const model = toListedClaudeModel(entry)
      // Why (Orca): the `default` row mirrors whichever entry it resolves to;
      // the pickers manage their own default selection.
      if (!model || model.id === 'default' || seen.has(model.id)) continue
      seen.add(model.id)
      listed.push(model)
    }
    if (listed.length > 0) return listed
  }
  return []
}

// `codex debug models` -> [{ id, label, description?, effortLevels,
// defaultEffort? }]. Tessel leaves out the rows Codex itself hides from its
// /model picker (visibility "hide").
export function parseCodexModelList(stdout) {
  let parsed
  try {
    const text = String(stdout || '')
    if (text.length > MODEL_PROBE_MAX_OUTPUT) return []
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const rows = parsed && Array.isArray(parsed.models) ? parsed.models : []
  const seen = new Set()
  const out = []
  for (const model of rows.slice(0, 300)) {
    if (!model || typeof model !== 'object') continue
    if (typeof model.slug !== 'string' || !model.slug || typeof model.display_name !== 'string' || !model.display_name) continue
    if (model.visibility === 'hide' || seen.has(model.slug)) continue
    seen.add(model.slug)
    const levels = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels.map((level) => level && level.effort).filter((e) => typeof e === 'string' && e)
      : []
    out.push({
      id: model.slug,
      label: model.display_name,
      ...(typeof model.description === 'string' && model.description.trim() ? { description: model.description.trim() } : {}),
      effortLevels: levels,
      ...(typeof model.default_reasoning_level === 'string' ? { defaultEffort: model.default_reasoning_level } : {})
    })
  }
  return out
}

const AVAILABLE_MODELS_HEADER = 'Available models:'
const MODEL_BULLET = /^\s*[*-]\s+([^\s(]+)(.*)$/
const DEFAULT_MARKER = /\(default\)/

// `grok models` -> [{ id, label, isDefault? }] (Orca's parseGrokModelList).
export function parseGrokModelList(stdout) {
  const lines = String(stdout || '').split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => line.trim() === AVAILABLE_MODELS_HEADER)
  if (headerIndex === -1) return []
  const byId = new Map()
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim() === '' && byId.size > 0) break
    const match = MODEL_BULLET.exec(line)
    const id = match && match[1]
    if (!id) continue
    const model = byId.get(id) || { id, label: labelFromModelId(id) }
    if (DEFAULT_MARKER.test(match[2])) model.isDefault = true
    byId.set(id, model)
  }
  return [...byId.values()]
}

// `opencode models` -> [{ id, label }] (Orca's parseLineModels): one
// provider/model id per line; any other line (a log line, a hint, a line
// with spaces) is skipped. At most 300 rows.
const OPENCODE_MODEL_ID = /^[A-Za-z0-9][\w.@+-]*\/[A-Za-z0-9._:/@[\]=+-]{1,150}$/
// "opencode/big-pickle" -> "Big Pickle": the model's own name; another
// provider stays as a hint, "anthropic/claude-sonnet-5" -> "Claude Sonnet 5
// (anthropic)".
export function openCodeModelLabel(id) {
  const slash = String(id).indexOf('/')
  if (slash < 0) return labelFromModelId(id)
  const provider = id.slice(0, slash)
  const name = labelFromModelId(id.slice(slash + 1))
  return provider.toLowerCase() === 'opencode' ? name : `${name} (${provider})`
}
export function parseOpenCodeModelList(stdout) {
  const text = String(stdout || '')
  if (text.length > MODEL_PROBE_MAX_OUTPUT) return []
  const seen = new Set()
  const out = []
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const id = rawLine.trim()
    if (!id || id.length > 160 || !OPENCODE_MODEL_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label: openCodeModelLabel(id) })
    if (out.length >= 300) break
  }
  return out
}

// Pi, Cursor and Antigravity formats from commit-message-model-parsers.ts
// (MIT, Copyright (c) 2026 Lovecast Inc.). Reject shell syntax in identifiers;
// Antigravity's obsolete human-name-only format cannot be launched safely.
const PROBED_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]=+-]{0,159}$/
function parseModelLines(stdout, parseLine) {
  const text = String(stdout || '')
  if (text.length > MODEL_PROBE_MAX_OUTPUT) return []
  const seen = new Set()
  const out = []
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.length > 4096) continue
    const row = parseLine(line.trim())
    if (!row || !PROBED_MODEL_ID.test(row.id) || seen.has(row.id)) continue
    seen.add(row.id)
    out.push({ ...row, label: row.label.slice(0, 120) })
    if (out.length === 300) break
  }
  return out
}

export function parsePiModelList(stdout) {
  return parseModelLines(stdout, (line) => {
    const fields = line.split(/\s+/, 6)
    if (fields.length !== 6 || fields[0].toLowerCase() === 'provider' || !/^(yes|no)$/i.test(fields[4])) return null
    const id = `${fields[0]}/${fields[1]}`
    return { id, label: labelFromModelId(id), effortLevels: /^yes$/i.test(fields[4]) ? ['off', 'low', 'medium', 'high', 'xhigh'] : [] }
  })
}

export function parseCursorModelList(stdout) {
  return parseModelLines(stdout, (line) => {
    const match = /^(\S+)\s+-\s+(.+)$/.exec(line)
    if (!match) return null
    // "Auto (current, default)": the marks are not part of the name.
    const marks = /\s*\(((?:current|default)(?:,\s*(?:current|default))*)\)/
    const mark = marks.exec(match[2])
    const label = match[2].replace(marks, '').trim()
    return label ? { id: match[1], label, ...(mark && /default/.test(mark[1]) ? { isDefault: true } : {}) } : null
  })
}

export function parseAntigravityModelList(stdout) {
  return parseModelLines(stdout, (line) => {
    const fields = line.split('\t')
    if (fields.length !== 2 || /^(id|model)$/i.test(fields[0]) || !fields[1].trim()) return null
    return { id: fields[0], label: fields[1].trim() }
  })
}

// Muse Code's model/list answer (JSON): { models: [{ modelId, displayLabel,
// description, isDefault, variants: [efforts] | 'unknown',
// defaultReasoningEffort }] }, newest first.
const MUSE_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export function parseMuseModelList(stdout) {
  let data
  try {
    data = JSON.parse(String(stdout || ''))
  } catch {
    return []
  }
  const rows = data && Array.isArray(data.models) ? data.models : []
  const out = []
  const seen = new Set()
  for (const m of rows.slice(0, 300)) {
    const id = m && typeof m.modelId === 'string' ? m.modelId.trim() : ''
    if (!PROBED_MODEL_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    const label = typeof m.displayLabel === 'string' && m.displayLabel.trim() ? m.displayLabel.trim().slice(0, 120) : labelFromModelId(id)
    const described = Array.isArray(m.reasoningEffortVariants) ? m.reasoningEffortVariants.map((v) => v && v.tier) : []
    const levels = (Array.isArray(m.variants) ? m.variants : described).filter((e) => MUSE_EFFORTS.includes(e))
    const row = { id, label }
    if (typeof m.description === 'string' && m.description.trim()) row.description = m.description.trim().slice(0, 300)
    if (levels.length) row.effortLevels = levels
    if (MUSE_EFFORTS.includes(m.defaultReasoningEffort)) row.defaultEffort = m.defaultReasoningEffort
    if (m.isDefault === true) row.isDefault = true
    out.push(row)
  }
  return out
}

// How each agent is asked: its program, arguments, what goes on stdin.
// msp: asked over the agent's own protocol (that method), not by its output.
export const MODEL_PROBES = {
  claude: { exe: 'claude', args: CLAUDE_MODEL_LIST_ARGS, stdin: CLAUDE_MODEL_LIST_STDIN, parse: parseClaudeModelList },
  codex: { exe: 'codex', args: CODEX_MODEL_LIST_ARGS, stdin: null, parse: parseCodexModelList },
  grok: { exe: 'grok', args: GROK_MODEL_LIST_ARGS, stdin: null, parse: parseGrokModelList },
  opencode: { exe: 'opencode', args: OPENCODE_MODEL_LIST_ARGS, stdin: null, parse: parseOpenCodeModelList },
  pi: { exe: 'pi', args: PI_MODEL_LIST_ARGS, stdin: null, parse: parsePiModelList },
  cursor: { exe: 'cursor-agent', args: CURSOR_MODEL_LIST_ARGS, stdin: null, parse: parseCursorModelList },
  antigravity: { exe: 'agy', args: ANTIGRAVITY_MODEL_LIST_ARGS, stdin: null, parse: parseAntigravityModelList },
  muse: { exe: 'muse', args: ['serve'], stdin: null, msp: 'model/list', parse: parseMuseModelList }
}

export function canProbeModels(agent) {
  return Object.prototype.hasOwnProperty.call(MODEL_PROBES, agent)
}

// A finished probe -> { ok: true, models } | { ok: false, reason, detail }.
// reason: 'failed' (exit code), 'empty' (nothing listed). Orca's
// finalizeModelDiscoveryOutput: stderr is read too when stdout lists nothing.
export function finalizeProbeOutput(agent, stdout, stderr, code) {
  const spec = MODEL_PROBES[agent]
  if (!spec) return { ok: false, reason: 'unsupported', detail: '' }
  if (code !== 0) {
    const line = String(stderr || stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
    return { ok: false, reason: 'failed', detail: `${code}: ${line}`.slice(0, 300) }
  }
  let models = spec.parse(stdout)
  if (models.length === 0 && String(stderr || '').trim()) models = spec.parse(stderr)
  if (models.length === 0) return { ok: false, reason: 'empty', detail: '' }
  return { ok: true, models }
}

// What a probe listed (plain data, kept on disk and sent to the window) ->
// catalog rows with their options (effort, fast mode).
export function listedToCatalogModels(agent, rows) {
  if (!Array.isArray(rows)) return []
  // Cursor lists each effort / Fast / Thinking variant as its own id: one
  // row per base model, those as its options (cursorModels.js).
  if (agent === 'cursor') return groupCursorModels(rows)
  // Antigravity lists each effort variant as its own id too: one row per
  // model, its efforts as its option (antigravityModels.js).
  if (agent === 'antigravity')
    return groupAntigravityModels(rows).map(({ efforts, ...row }) => ({
      id: row.id,
      label: row.label,
      ...(row.description ? { description: row.description } : {}),
      ...(row.isDefault ? { isDefault: true } : {}),
      options: createAntigravityCatalogOptions(efforts),
      ...(efforts ? { efforts } : {})
    }))
  return rows.map((row) => {
    const base = { id: row.id, label: row.label, ...(row.description ? { description: row.description } : {}), ...(row.isDefault ? { isDefault: true } : {}) }
    if (agent === 'claude') {
      const runs = row.runs || claudeAliasRuns(row.id, row.label)
      return { ...base, ...(runs ? { runs } : {}), options: createClaudeCatalogOptions({ effortLevelIds: row.effortLevels || [], supportsFastMode: !!row.supportsFastMode }) }
    }
    if (agent === 'codex')
      return { ...base, options: row.effortLevels && row.effortLevels.length ? createCodexCatalogOptions({ effortLevelIds: row.effortLevels, defaultEffort: row.defaultEffort }) : [] }
    if (agent === 'pi') return { ...base, options: createPiCatalogOptions(row.effortLevels || []) }
    if (agent === 'muse') return { ...base, options: createMuseCatalogOptions(row.effortLevels || [], row.defaultEffort) }
    return { ...base, options: [] }
  })
}

const LISTED_ID = /^[A-Za-z0-9._:/@[\]=+-]{1,160}$/
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined)

// Listed rows from disk or IPC: only well-formed ones, at most 300.
export function validListedModels(rows) {
  if (!Array.isArray(rows)) return []
  const out = []
  const seen = new Set()
  for (const r of rows.slice(0, 300)) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !LISTED_ID.test(r.id) || seen.has(r.id)) continue
    seen.add(r.id)
    const row = { id: r.id, label: text(r.label, 120) || r.id }
    const d = text(r.description, 300)
    if (d) row.description = d
    if (Array.isArray(r.effortLevels)) row.effortLevels = r.effortLevels.filter((e) => typeof e === 'string' && /^[a-z]{1,20}$/.test(e)).slice(0, 12)
    if (typeof r.defaultEffort === 'string' && /^[a-z]{1,20}$/.test(r.defaultEffort)) row.defaultEffort = r.defaultEffort
    if (r.supportsFastMode === true) row.supportsFastMode = true
    if (r.isDefault === true) row.isDefault = true
    if (typeof r.runs === 'string' && /^claude-[a-z0-9.-]+(\[1m\])?$/i.test(r.runs) && r.runs.length <= 160) row.runs = r.runs
    out.push(row)
  }
  return out
}
