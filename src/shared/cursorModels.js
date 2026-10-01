// Cursor CLI's model list (`cursor-agent --list-models`) names every variant
// as its own id: the effort, Fast and Thinking are baked in
// ("gpt-5.3-codex-high-fast", "claude-opus-5-thinking-max"). The pickers show
// one row per base model with those as options (as for Claude and Codex), and
// the chosen combination goes back to Cursor as the exact id it listed.
//
// Naming rules, from the list Cursor prints:
// - `-fast` is always last.
// - an effort comes before it: none, minimal, low, medium, high, xhigh (also
//   spelled extra-high), max. Without one, the id is the model's middle
//   setting (gpt-5.3-codex sits between -low and -high): Medium.
// - `-thinking` comes before the effort (claude-opus-5-thinking-high) or,
//   on older Claude ids, after it (claude-4.6-opus-high-thinking).
// - the label says the effort ("Low", "Extra High"), "Fast" and "Thinking";
//   the variant Cursor treats as the model's own setting has no effort word
//   ("Claude Opus 5 1M" is claude-opus-5-high). "1M" and "(NO ZDR)" are notes
//   of the model, kept; some labels carry double spaces and zero-width marks.

// Effort ids in their order (the picker's order, and how "closest" is told).
export const CURSOR_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
// Longest first: "-extra-high" before "-high".
const EFFORT_SUFFIXES = { 'extra-high': 'xhigh', minimal: 'minimal', medium: 'medium', xhigh: 'xhigh', none: 'none', high: 'high', low: 'low', max: 'max' }
// The word each effort has in a label (stripped from the base row's name).
const EFFORT_WORDS = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' }
// English labels; the interface translates them (sessionOptionLabels.js).
const EFFORT_LABELS = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

// An id -> { base, effort ('' = none in the id), fast, thinking }, from its
// spelling alone.
export function parseCursorModelId(id) {
  let rest = String(id || '')
  let fast = false
  let thinking = false
  let effort = ''
  if (rest.endsWith('-fast')) {
    fast = true
    rest = rest.slice(0, -5)
  }
  if (rest.endsWith('-thinking')) {
    thinking = true
    rest = rest.slice(0, -9)
  }
  for (const [suffix, value] of Object.entries(EFFORT_SUFFIXES)) {
    if (rest.endsWith(`-${suffix}`) && rest.length > suffix.length + 1) {
      effort = value
      rest = rest.slice(0, -(suffix.length + 1))
      break
    }
  }
  if (!thinking && rest.endsWith('-thinking')) {
    thinking = true
    rest = rest.slice(0, -9)
  }
  return { base: rest || String(id || ''), effort, fast, thinking }
}

const ZERO_WIDTH = /[​-‍⁠﻿]/g
function tidy(label) {
  return String(label || '').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim()
}
// Removes a whole word (the last one: names come first) from a label.
function withoutWord(label, word) {
  const words = label.split(' ')
  const drop = word.split(' ')
  for (let i = words.length - drop.length; i >= 0; i--) {
    if (drop.every((w, j) => words[i + j] === w)) return [...words.slice(0, i), ...words.slice(i + drop.length)].join(' ')
  }
  return label
}
// A variant's label -> the base model's name ("Codex 5.3 Low Fast" -> "Codex 5.3").
function baseLabel(label, parsed, rawEffort) {
  let out = tidy(label)
  if (parsed.fast) out = withoutWord(out, 'Fast')
  if (parsed.thinking) out = withoutWord(out, 'Thinking')
  if (rawEffort) out = withoutWord(out, EFFORT_WORDS[rawEffort])
  return tidy(out)
}
// The effort word a label shows, or null (the model's own setting).
function labelHasEffort(label, effort) {
  if (!effort) return false
  return ` ${tidy(label)} `.includes(` ${EFFORT_WORDS[effort]} `)
}

const variantKey = (effort, thinking, fast) => `${effort}|${thinking ? 1 : 0}|${fast ? 1 : 0}`

// Listed rows ({ id, label, isDefault? }) -> picker rows: one per base model,
// { id: base, label, variants: [{ id, effort, fast, thinking }], efforts,
// defaultEffort, hasFast, hasThinking, defaultThinking, options }. A model
// listed once (auto, gemini-3.1-pro) stays a row with its listed id and no
// options.
export function groupCursorModels(rows) {
  const groups = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.id !== 'string' || !row.id) continue
    const parsed = parseCursorModelId(row.id)
    const rawEffort = parsed.effort
    const g = groups.get(parsed.base) || { base: parsed.base, rows: [] }
    g.rows.push({ row, parsed, rawEffort })
    groups.set(parsed.base, g)
  }
  const out = []
  for (const g of groups.values()) {
    // An id without an effort is the model's middle setting: Medium, unless
    // the list has an explicit -medium too (then it stays a row of its own).
    const explicitMedium = g.rows.some((r) => r.rawEffort === 'medium')
    const plain = g.rows.filter((r) => !r.rawEffort)
    if (plain.length && explicitMedium) {
      for (const r of plain) out.push(plainRow(r.row))
      g.rows = g.rows.filter((r) => r.rawEffort)
    }
    if (g.rows.length === 0) continue
    if (g.rows.length === 1) {
      out.push(plainRow(g.rows[0].row))
      continue
    }
    const hasEfforts = g.rows.some((r) => r.rawEffort)
    const variants = g.rows.map((r) => ({
      id: r.row.id,
      effort: r.rawEffort || (hasEfforts ? 'medium' : ''),
      fast: r.parsed.fast,
      thinking: r.parsed.thinking
    }))
    const efforts = CURSOR_EFFORT_ORDER.filter((e) => variants.some((v) => v.effort === e))
    const hasFast = variants.some((v) => v.fast) && variants.some((v) => !v.fast)
    const hasThinking = variants.some((v) => v.thinking) && variants.some((v) => !v.thinking)
    // The plain variant (no Fast, no Thinking when there is a choice) whose
    // label has no effort word, or whose id has none: the model's own setting.
    const plainVariants = g.rows.filter((r) => !r.parsed.fast && (!hasThinking || !r.parsed.thinking))
    const own = plainVariants.find((r) => !r.rawEffort) || plainVariants.find((r) => !labelHasEffort(r.row.label, r.rawEffort))
    const ownEffort = own ? own.rawEffort || (hasEfforts ? 'medium' : '') : ''
    const defaultEffort = efforts.includes(ownEffort) ? ownEffort : efforts[Math.floor((efforts.length - 1) / 2)] || ''
    const defaultThinking = hasThinking ? false : variants.every((v) => v.thinking)
    // The name: the longest cleaned label (Cursor drops "1M" from some
    // Fast variants' labels).
    const labels = g.rows.map((r) => baseLabel(r.row.label, r.parsed, r.rawEffort)).filter(Boolean)
    const label = labels.reduce((best, l) => (l.length > best.length ? l : best), '') || g.base
    const options = [
      ...(efforts.length > 1 ? [cursorEffortOption(efforts, defaultEffort)] : []),
      ...(hasFast ? [CURSOR_LISTED_FAST] : []),
      ...(hasThinking ? [CURSOR_LISTED_THINKING] : [])
    ]
    out.push({
      id: g.base,
      label,
      ...(g.rows.some((r) => r.row.isDefault) ? { isDefault: true } : {}),
      variants,
      efforts,
      defaultEffort,
      hasFast,
      hasThinking,
      defaultThinking,
      options
    })
  }
  return sortCursorModels(out)
}

// The order the pickers show: Auto first, then by family (Claude, GPT and
// Codex, Gemini, Grok, Composer, Kimi, the rest), newest version first;
// Claude by tier (Fable, Opus, Sonnet, Haiku), then newest first.
const FAMILIES = [/claude|fable|opus|sonnet|haiku/, /gpt|codex/, /gemini/, /grok/, /composer/, /kimi/]
const CLAUDE_TIERS = ['fable', 'opus', 'sonnet', 'haiku']
function familyRank(id) {
  const i = FAMILIES.findIndex((re) => re.test(id))
  return i < 0 ? FAMILIES.length : i
}
// The version as its name says it ("Claude Opus 5.5 1M" -> 5.5, "Kimi K3"
// -> 3): Cursor writes it two ways in ids (claude-opus-5-5, claude-4.6-opus).
function versionOf(model) {
  const m = /(?:^|[\s-]K?)(\d+(?:\.\d+)?)(?![\dM])/i.exec(String(model.label || model.id || ''))
  return m ? parseFloat(m[1]) : 0
}
function tierRank(id) {
  const i = CLAUDE_TIERS.findIndex((tier) => id.includes(tier))
  return i < 0 ? CLAUDE_TIERS.length : i
}
export function sortCursorModels(models) {
  const key = (m) => String(m.id || '').toLowerCase()
  return [...models].sort((a, b) => {
    const ia = key(a)
    const ib = key(b)
    if (ia === 'auto' || ib === 'auto') return ia === 'auto' ? (ib === 'auto' ? 0 : -1) : 1
    return (
      familyRank(ia) - familyRank(ib) ||
      // Claude: Fable, Opus, Sonnet, Haiku, each newest first.
      (familyRank(ia) === 0 ? tierRank(ia) - tierRank(ib) : 0) ||
      versionOf(b) - versionOf(a) ||
      String(a.label || ia).localeCompare(String(b.label || ib))
    )
  })
}

// A model listed once: its own id and name, no options (its one variant,
// so it is still known as a row of Cursor's own list).
function plainRow(row) {
  const parsed = parseCursorModelId(row.id)
  return {
    id: row.id,
    label: tidy(row.label) || row.id,
    ...(row.isDefault ? { isDefault: true } : {}),
    variants: [{ id: row.id, effort: '', fast: parsed.fast, thinking: parsed.thinking }],
    efforts: [],
    defaultEffort: '',
    hasFast: false,
    hasThinking: false,
    defaultThinking: parsed.thinking,
    options: []
  }
}

function cursorEffortOption(efforts, defaultValue) {
  return {
    id: 'effort',
    label: 'Effort',
    category: 'thought_level',
    kind: { type: 'select', choices: efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] })), defaultValue },
    apply: { composedIntoModel: true }
  }
}
const CURSOR_LISTED_FAST = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', defaultValue: false },
  apply: { composedIntoModel: true }
}
const CURSOR_LISTED_THINKING = {
  id: 'thinking',
  label: 'Thinking',
  category: 'model_config',
  kind: { type: 'boolean', defaultValue: false },
  apply: { composedIntoModel: true }
}

// A grouped row and the chosen values ({ effort?, fastMode?, thinking? }) ->
// the exact listed id. A combination Cursor does not list (Opus 5 Extra High
// without Thinking) gives the closest one it does: the effort matters most
// after Thinking, then Fast. Never an id the CLI did not list.
export function composeCursorModel(model, values = {}) {
  if (!model || !Array.isArray(model.variants) || !model.variants.length) return model ? model.id : ''
  const effort = typeof values.effort === 'string' && model.efforts.includes(values.effort) ? values.effort : model.defaultEffort
  const fast = model.hasFast ? values.fastMode === true : model.variants[0].fast
  const thinking = model.hasThinking ? (typeof values.thinking === 'boolean' ? values.thinking : model.defaultThinking) : model.variants[0].thinking
  const exact = model.variants.find((v) => variantKey(v.effort, v.thinking, v.fast) === variantKey(effort, thinking, fast))
  if (exact) return exact.id
  const at = (e) => CURSOR_EFFORT_ORDER.indexOf(e)
  let best = null
  let bestCost = Infinity
  for (const v of model.variants) {
    // Ties: the lower effort (cheaper), in list order.
    const diff = at(v.effort) - at(effort)
    const cost = Math.abs(diff) * 2 + (diff > 0 ? 0.5 : 0) + (v.thinking !== thinking ? 3 : 0) + (v.fast !== fast ? 1 : 0)
    if (cost < bestCost) {
      best = v
      bestCost = cost
    }
  }
  return best.id
}

// A listed id -> { model: its row's id, effort?, fastMode?, thinking? } (the
// values that compose back into it), or null when no grouped row has it.
export function decomposeCursorModel(models, id) {
  if (typeof id !== 'string' || !id) return null
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || !Array.isArray(m.variants)) continue
    const v = m.variants.find((x) => x.id === id)
    if (!v) continue
    return {
      model: m.id,
      ...(m.efforts.length > 1 ? { effort: v.effort } : {}),
      ...(m.hasFast ? { fastMode: v.fast } : {}),
      ...(m.hasThinking ? { thinking: v.thinking } : {})
    }
  }
  return null
}
