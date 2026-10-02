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

// --- The running CLI's own picker and status line ---------------------------
// Cursor's TUI (2026.10) groups its models the same way: one row per model
// ("GPT-5.6 Sol"), its context, effort and Fast as parameters ("272K High
// Fast", Tab to change them). Its /model <text> only FILTERS that picker by
// name (an id such as gpt-5.6-sol-high matches nothing), and the line under
// its prompt says what this session runs: "GPT-5.6 Sol 272K High Fast".

// Notes in a listed label that the TUI shows as a parameter, or not at all:
// a context size ("1M", "272K") and "(NO ZDR)".
function plainName(label) {
  return tidy(label)
    .replace(/\(NO ZDR\)/gi, ' ')
    .split(' ')
    .filter((w) => w && !/^\d+(?:\.\d+)?[KM]$/i.test(w))
    .join(' ')
}

// A grouped row -> the text that filters Cursor's picker down to it
// ("GPT-5.6 Luna 1M" -> "GPT-5.6 Luna"). '' when there is nothing to type.
export function cursorPickerFilter(model) {
  if (!model) return ''
  const name = plainName(model.label || model.id)
  return /^[\w .()+-]{1,80}$/.test(name) ? name : ''
}

const STATUS_EFFORTS = Object.entries(EFFORT_WORDS).sort((a, b) => b[1].length - a[1].length)

// The line Cursor shows under its prompt ("GPT-5.6 Sol 272K High Fast") and
// the grouped rows -> { model: the listed id it is, row, effort, fastMode,
// thinking } or null. The whole line must be a row's name followed only by
// parameters (a context size, an effort, Fast, Thinking), so text in the
// conversation is never taken for it.
export function cursorModelFromStatusLine(line, models) {
  const text = tidy(line)
  if (!text || text.length > 120) return null
  let best = null
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || !m.label) continue
    const name = plainName(m.label)
    if (!name || (text !== name && !text.startsWith(name + ' '))) continue
    if (best && best.name.length >= name.length) continue
    const values = statusParameters(text.slice(name.length).trim())
    if (values) best = { name, model: m, values }
  }
  if (!best) return null
  const { model, values } = best
  const fastMode = values.fast
  const thinking = values.thinking
  const effort = values.effort && model.efforts && model.efforts.includes(values.effort) ? values.effort : null
  const picked = { ...(effort ? { effort } : {}), fastMode, ...(thinking ? { thinking } : {}) }
  const id = Array.isArray(model.variants) ? composeCursorModel(model, picked) : model.id
  return {
    model: id,
    row: model.id,
    name: [best.name, fastMode ? 'Fast' : '', thinking ? 'Thinking' : ''].filter(Boolean).join(' '),
    effort: effort || (model.efforts && model.efforts.length > 1 ? model.defaultEffort || null : null),
    fastMode: !!fastMode,
    thinking: !!thinking
  }
}
// "272K High Fast" -> { effort: 'high', fast: true, thinking: false }, or
// null when a word is none of those.
function statusParameters(rest) {
  const out = { effort: '', fast: false, thinking: false }
  let s = ` ${rest} `
  for (const [effort, word] of STATUS_EFFORTS) {
    if (s.includes(` ${word} `)) {
      out.effort = effort
      s = s.replace(` ${word} `, ' ')
      break
    }
  }
  for (const w of s.split(' ').filter(Boolean)) {
    if (/^\d+(?:\.\d+)?[KM]$/i.test(w)) continue
    if (w === 'Fast') out.fast = true
    else if (w === 'Thinking') out.thinking = true
    else return null
  }
  return out
}

// Cursor's model picker is open on screen (its rows look like status lines:
// "Grok 4.7   256K High Fast").
export function cursorPickerShown(lines) {
  return (Array.isArray(lines) ? lines : []).some((l) => /Type to filter|Enter to select|^\s*(?:Available models|Models matching)\b/.test(String(l || '')))
}

// The model Cursor's screen shows: its status line among the last lines (read
// from the bottom up). lines: the screen's lines, top to bottom. null while
// its picker is open.
export function cursorModelOnScreen(lines, models) {
  if (cursorPickerShown(lines)) return null
  const list = (Array.isArray(lines) ? lines : []).map((l) => String(l || '')).filter((l) => l.trim())
  for (let i = list.length - 1; i >= 0; i--) {
    const found = cursorStatusLine(list[i], models)
    if (found) return found.model
  }
  return null
}

// Once a conversation has begun, Cursor adds to that line what it knows of the
// context, after " · ": "GPT-5.6 Sol 272K High · MAX · 12.3% · 2 files
// edited" (the share of the model's window used, else "45.2k tokens" while
// the window is unknown); a label of its own may come first. The line ->
// { model, segment: its model's part, rest: the parts after it } or null.
// Every part after the model must be one of those, so text in the
// conversation is never taken for it.
const STATUS_TAIL = [/^MAX$/, /^\d+(?:\.\d+)?%$/, /^\d+(?:\.\d+)?[kM]? tokens?$/, /^\d+ files? edited$/]
function cursorStatusLine(line, models) {
  const parts = tidy(line).split(' · ')
  if (parts.length > 6) return null
  for (let i = 0; i < Math.min(parts.length, 2); i++) {
    const model = cursorModelFromStatusLine(parts[i], models)
    if (!model) continue
    const rest = parts.slice(i + 1)
    return rest.every((p) => STATUS_TAIL.some((re) => re.test(p))) ? { model, segment: parts[i], rest } : null
  }
  return null
}

// "272K" / "1M" -> tokens (Cursor's sizes are thousands and millions).
function sizeTokens(word) {
  const m = /^(\d+(?:\.\d+)?)([KM])$/i.exec(word || '')
  return m ? Math.round(Number(m[1]) * (m[2].toUpperCase() === 'M' ? 1_000_000 : 1_000)) : 0
}

// The context Cursor's status line shows (its own count: the share of the
// window its last request used) -> { usedTokens, windowTokens, percentage }
// | { none: true } (the status line, with nothing about the context yet: a
// new conversation) | null (no status line on screen, or its picker is open).
// The window is the size the line gives with the model ("272K"), else the
// one in the listed model's label; unknown: nothing is shown.
export function cursorContextOnScreen(lines, models) {
  if (cursorPickerShown(lines)) return null
  const list = (Array.isArray(lines) ? lines : []).map((l) => String(l || '')).filter((l) => l.trim())
  for (let i = list.length - 1; i >= 0; i--) {
    const found = cursorStatusLine(list[i], models)
    if (!found) continue
    const listed = (Array.isArray(models) ? models : []).find((m) => m && m.id === found.model.row)
    const windowTokens =
      found.segment.split(' ').map(sizeTokens).find((n) => n > 0) || tidy(listed && listed.label).split(' ').map(sizeTokens).find((n) => n > 0) || 0
    const pct = found.rest.find((p) => p.endsWith('%'))
    const count = found.rest.find((p) => / tokens?$/.test(p))
    if (!windowTokens || (!pct && !count)) return { none: true }
    let used = 0
    if (pct) used = Math.round((Number(pct.slice(0, -1)) / 100) * windowTokens)
    else {
      const m = /^(\d+(?:\.\d+)?)([kM]?) /.exec(count)
      used = m ? Math.round(Number(m[1]) * (m[2] === 'M' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1)) : 0
    }
    if (!(used > 0) || used > windowTokens * 1.5) return { none: true }
    return { usedTokens: used, windowTokens, percentage: Math.round((used / windowTokens) * 100) }
  }
  return null
}
