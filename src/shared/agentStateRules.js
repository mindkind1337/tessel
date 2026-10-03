// Agent-state detection rules as data: the screen texts that say an agent
// hit its usage limit, asks for an approval, works or was interrupted. The
// built-in rules ship in ./agentStateRules/<agent>.json ("common" applies to
// every agent). The user can fix a detection without waiting for an update
// with an override file in Tessel's user data folder (agent-state-rules.json,
// read by the main process, src/main/agentStateRulesFile.js), validated here
// against a strict schema and merged over the built-ins.
// After the reference app's agent-state-rules (MIT, Copyright (c) 2026
// Lovecast Inc.): one JSON file per agent, strict validation, regex patterns
// refused when they can backtrack exponentially. No Node or Electron here:
// main and renderer both use it.
import common from './agentStateRules/common.json'
import claude from './agentStateRules/claude.json'
import codex from './agentStateRules/codex.json'

export const RULES_ENGINE_VERSION = 1
export const COMMON_RULES_ID = 'common'
export const OVERRIDE_FILE_NAME = 'agent-state-rules.json'
export const BUILTIN_RULE_FILES = [common, claude, codex]

// What each kind means (agentLimit.js, agentStatus.js):
//   limit          the agent hit its usage limit (any rule matches the screen)
//   limit-reset    its reset time: the first rule that matches, its first group
//                  (with the rule's prefix: "in 2 hours")
//   approval       the agent asks you to approve something
//   busy-footer    the screen's last lines say it works (or an approval waits)
//   running-footer the screen's last lines say it works (never an approval)
//   working-line   one line of the screen is its working spinner
//   interrupted    the line above its input says its turn was interrupted
//   interrupted-screen  the screen's last lines say it was interrupted
export const RULE_KINDS = [
  'limit',
  'limit-reset',
  'approval',
  'busy-footer',
  'running-footer',
  'working-line',
  'interrupted',
  'interrupted-screen'
]

export const MAX_PATTERN_LENGTH = 200
export const MAX_RULES_PER_AGENT = 32
export const MAX_DISABLED_PER_AGENT = 64
// A user rule reads at most the screen's last characters (a terminal screen
// is far shorter): bounds the work of a slow pattern.
export const MAX_SCREEN_TEXT = 8192
// A user rule that takes this long once is turned off until the file changes.
export const SLOW_RULE_MS = 50
const MAX_ID = 64
const MAX_WHY = 600
const MAX_PREFIX = 40
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// After the reference app's pattern safety: Node has no linear-time regex
// engine and a regex cannot be stopped once it runs, so a pattern that can
// backtrack exponentially is refused when the file loads. Overlapping
// adjacent quantifiers (`\s*\s*x`) are polynomial and not detected; the screen
// text cap above bounds them.
export function findUnsafePatternReason(pattern) {
  try {
    new RegExp(pattern)
  } catch {
    return 'does not compile'
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'uses a backreference'
  if (/\(\?<[=!]/.test(pattern)) return 'uses a lookbehind'
  // A repeated group inside a repeated group counts: its quantifier makes
  // the outer body vary.
  if (repeatsAVariableGroup(pattern)) return 'repeats a group that can match in more than one way'
  return null
}

const repeating = (c) => c === '*' || c === '+' || c === '{'

// A repeated group whose body varies, by a quantifier or an alternation:
// `(a+)*`, `(a?)+`, `(a|aa)+`. Such a body can split one input many ways, each
// of which a failed match retries.
function repeatsAVariableGroup(pattern) {
  const varies = []
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') i++
    else if (inClass) inClass = c !== ']'
    else if (c === '[') inClass = true
    else if (c === '(') {
      varies.push(false)
      if (pattern[i + 1] === '?') i++
    } else if (c === ')') {
      const body = varies.pop() ?? false
      if (body && repeating(pattern[i + 1])) return true
      if (body && varies.length) varies[varies.length - 1] = true
    } else if ((repeating(c) || c === '?' || c === '|') && varies.length) varies[varies.length - 1] = true
  }
  return false
}

// JSON with // and /* */ comments (the example file explains itself).
export function parseJsonc(text) {
  const s = String(text ?? '').replace(/^﻿/, '')
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1
      out += s.slice(i, j + 1)
      i = j
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2)
      if (end < 0) throw new Error('a /* comment is not closed')
      out += s.slice(i, end + 2).replace(/[^\n]/g, ' ')
      i = end + 1
    } else out += c
  }
  return JSON.parse(out)
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function unknownKey(obj, allowed) {
  return Object.keys(obj).find((k) => !allowed.includes(k)) ?? null
}

const RULE_KEYS = ['id', 'why', 'kind', 'regex', 'ignoreCase', 'prefix']

// One rule. builtin: Tessel's own (reviewed) patterns skip the length cap and
// the backtracking heuristic, never the rest. -> error text or null.
export function ruleError(rule, { builtin = false } = {}) {
  if (!isObject(rule)) return 'must be an object'
  const extra = unknownKey(rule, RULE_KEYS)
  if (extra) return `unknown field "${extra}"`
  if (typeof rule.id !== 'string' || !rule.id || rule.id.length > MAX_ID || !ID_RE.test(rule.id))
    return 'id must be letters, digits, ".", "_" or "-" (64 at most)'
  if (!RULE_KINDS.includes(rule.kind)) return `kind must be one of ${RULE_KINDS.join(', ')}`
  if (typeof rule.regex !== 'string' || !rule.regex) return 'regex must be a pattern text'
  if (!builtin && rule.regex.length > MAX_PATTERN_LENGTH) return `regex is longer than ${MAX_PATTERN_LENGTH} characters`
  if (rule.ignoreCase !== undefined && typeof rule.ignoreCase !== 'boolean') return 'ignoreCase must be true or false'
  if (rule.why !== undefined && (typeof rule.why !== 'string' || rule.why.length > MAX_WHY))
    return `why must be a text (${MAX_WHY} characters at most)`
  if (rule.prefix !== undefined) {
    if (rule.kind !== 'limit-reset') return 'prefix is for limit-reset rules'
    if (typeof rule.prefix !== 'string' || rule.prefix.length > MAX_PREFIX) return `prefix must be a text (${MAX_PREFIX} characters at most)`
  }
  let re
  try {
    re = new RegExp(rule.regex, rule.ignoreCase ? 'i' : '')
  } catch (err) {
    return `regex does not compile: ${err.message}`
  }
  if (!builtin) {
    const unsafe = findUnsafePatternReason(rule.regex)
    if (unsafe) return `regex ${unsafe}`
    if (re.test('')) return 'regex matches empty text (it would match every screen)'
  }
  if (rule.kind === 'limit-reset' && !/\((?!\?)/.test(rule.regex.replace(/\\./g, '')))
    return 'a limit-reset regex needs a group around the reset time'
  return null
}

// A built-in file (tests check every shipped one).
export function validateRuleFile(file, { builtin = true } = {}) {
  if (!isObject(file)) return { ok: false, error: 'must be an object' }
  const extra = unknownKey(file, ['id', 'engineVersion', 'rules'])
  if (extra) return { ok: false, error: `unknown field "${extra}"` }
  if (typeof file.id !== 'string' || !file.id) return { ok: false, error: 'id is missing' }
  if (file.engineVersion !== RULES_ENGINE_VERSION) return { ok: false, error: `engineVersion must be ${RULES_ENGINE_VERSION}` }
  if (!Array.isArray(file.rules)) return { ok: false, error: 'rules must be a list' }
  const ids = new Set()
  for (const [i, rule] of file.rules.entries()) {
    const error = ruleError(rule, { builtin })
    if (error) return { ok: false, error: `rules[${i}]: ${error}` }
    if (ids.has(rule.id)) return { ok: false, error: `rules[${i}]: id "${rule.id}" is used twice` }
    ids.add(rule.id)
  }
  return { ok: true, error: null }
}

const builtinIds = (builtins, agent) =>
  new Set((builtins.find((f) => f.id === agent)?.rules || []).map((r) => r.id))

// The user's override file, parsed:
//   { engineVersion: 1,
//     agents: { "common" | "<agent id>": { rules: [rule…], disable: ["rule id"…] } } }
// A rule whose id is a built-in one replaces it (in place), a new id adds it;
// disable turns built-in or common rules off for that agent ("common": for all).
// knownAgents: the agent ids Tessel knows (null: any id).
// -> { ok, error, override } (override: the value, ready to merge).
export function validateOverride(value, { knownAgents = null, builtins = BUILTIN_RULE_FILES } = {}) {
  const fail = (error) => ({ ok: false, error, override: null })
  if (!isObject(value)) return fail('the file must hold one JSON object')
  const extra = unknownKey(value, ['engineVersion', 'agents'])
  if (extra) return fail(`unknown field "${extra}"`)
  if (value.engineVersion !== RULES_ENGINE_VERSION) return fail(`engineVersion must be ${RULES_ENGINE_VERSION}`)
  if (!isObject(value.agents)) return fail('agents must be an object: { "claude": { "rules": [...] } }')
  const commonOwn = new Set(builtinIds(builtins, COMMON_RULES_ID))
  for (const r of value.agents[COMMON_RULES_ID]?.rules || []) if (r && typeof r.id === 'string') commonOwn.add(r.id)
  for (const [agent, entry] of Object.entries(value.agents)) {
    const at = `agents.${agent}`
    if (agent !== COMMON_RULES_ID && knownAgents && !knownAgents.includes(agent))
      return fail(`${at}: "${agent}" is not an agent Tessel knows`)
    if (!isObject(entry)) return fail(`${at}: must be an object`)
    const extraKey = unknownKey(entry, ['rules', 'disable'])
    if (extraKey) return fail(`${at}: unknown field "${extraKey}"`)
    const rules = entry.rules ?? []
    if (!Array.isArray(rules)) return fail(`${at}.rules: must be a list`)
    if (rules.length > MAX_RULES_PER_AGENT) return fail(`${at}.rules: ${MAX_RULES_PER_AGENT} rules at most`)
    const ids = new Set()
    for (const [i, rule] of rules.entries()) {
      const error = ruleError(rule)
      if (error) return fail(`${at}.rules[${i}]: ${error}`)
      if (ids.has(rule.id)) return fail(`${at}.rules[${i}]: id "${rule.id}" is used twice`)
      ids.add(rule.id)
    }
    const disable = entry.disable ?? []
    if (!Array.isArray(disable)) return fail(`${at}.disable: must be a list of rule ids`)
    if (disable.length > MAX_DISABLED_PER_AGENT) return fail(`${at}.disable: ${MAX_DISABLED_PER_AGENT} ids at most`)
    const known = agent === COMMON_RULES_ID ? commonOwn : new Set([...commonOwn, ...builtinIds(builtins, agent), ...ids])
    for (const [i, id] of disable.entries()) {
      if (typeof id !== 'string') return fail(`${at}.disable[${i}]: must be a rule id`)
      if (!known.has(id)) return fail(`${at}.disable[${i}]: no rule "${id}" to turn off`)
    }
  }
  return { ok: true, error: null, override: value }
}

// How many rules the override adds, replaces or turns off (Settings).
export function overrideSize(override) {
  let n = 0
  for (const entry of Object.values(override?.agents || {})) n += (entry.rules?.length || 0) + (entry.disable?.length || 0)
  return n
}

// Built-ins with the override applied: { files: { agent: [rule…] },
// disable: { agent: Set } }. A user rule carries user: true.
export function mergeRules(builtins = BUILTIN_RULE_FILES, override = null) {
  const files = {}
  for (const f of builtins) files[f.id] = f.rules.map((r) => ({ ...r }))
  const disable = {}
  for (const [agent, entry] of Object.entries(override?.agents || {})) {
    const list = (files[agent] ||= [])
    for (const rule of entry.rules || []) {
      const at = list.findIndex((r) => r.id === rule.id)
      const own = { ...rule, user: true }
      if (at >= 0) list[at] = own
      else list.push(own)
    }
    if (entry.disable?.length) disable[agent] = new Set(entry.disable)
  }
  return { files, disable }
}

// The rules one agent's screen is read with: the common ones, then its own
// (an own rule with a common rule's id replaces it there).
export function resolveRules(merged, provider) {
  const off = (agent) => merged.disable[agent] || new Set()
  const offCommon = off(COMMON_RULES_ID)
  const offOwn = provider && provider !== COMMON_RULES_ID ? off(provider) : new Set()
  const list = (merged.files[COMMON_RULES_ID] || []).filter((r) => !offCommon.has(r.id) && !offOwn.has(r.id))
  if (provider && provider !== COMMON_RULES_ID)
    for (const rule of merged.files[provider] || []) {
      if (offOwn.has(rule.id)) continue
      const at = list.findIndex((r) => r.id === rule.id)
      if (at >= 0) list[at] = rule
      else list.push(rule)
    }
  return list
}

// A rule set ready to read a screen with: by kind, in order.
//   test(kind, text)  -> does any rule of that kind match
//   exec(kind, text)  -> { match, rule } of the first that matches, or null
//   has(kind)         -> any rule of that kind
export function compileRuleSet(rules, { log = null, now = () => Date.now() } = {}) {
  const byKind = {}
  for (const kind of RULE_KINDS) byKind[kind] = []
  for (const rule of rules) {
    let re
    try {
      re = new RegExp(rule.regex, rule.ignoreCase ? 'i' : '')
    } catch {
      continue
    }
    byKind[rule.kind]?.push({ id: rule.id, re, prefix: rule.prefix || '', user: !!rule.user, off: false })
  }
  function run(entry, text) {
    if (entry.off) return null
    if (!entry.user) return entry.re.exec(text)
    const input = text.length > MAX_SCREEN_TEXT ? text.slice(-MAX_SCREEN_TEXT) : text
    const start = now()
    const m = entry.re.exec(input)
    const took = now() - start
    if (took > SLOW_RULE_MS) {
      entry.off = true
      log?.(`agent-state rule "${entry.id}" took ${Math.round(took)} ms: turned off until the rules file changes`)
    }
    return m
  }
  return {
    has: (kind) => (byKind[kind] || []).length > 0,
    test(kind, text) {
      const s = String(text ?? '')
      return (byKind[kind] || []).some((e) => !!run(e, s))
    },
    exec(kind, text) {
      const s = String(text ?? '')
      for (const e of byKind[kind] || []) {
        const match = run(e, s)
        if (match) return { match, rule: e }
      }
      return null
    }
  }
}

// The rule sets per agent, compiled on first use.
export function createRuleEngine(override = null, opts = {}) {
  const merged = mergeRules(BUILTIN_RULE_FILES, override)
  const cache = new Map()
  return {
    forProvider(provider) {
      const key = provider || ''
      if (!cache.has(key)) cache.set(key, compileRuleSet(resolveRules(merged, provider), opts))
      return cache.get(key)
    }
  }
}

// The file "Open rules file" creates: no rule active, examples in comments.
export const OVERRIDE_TEMPLATE = `// Tessel's agent-state detection rules: your fixes over the built-in ones.
// Saved changes apply at once. A file with an error is ignored (Settings >
// Agents > Detection rules says why) and the built-in rules stay in use.
//
// "agents" holds one entry per agent id ("claude", "codex", "gemini", ...)
// or "common" (every agent). In an entry:
//   "rules":   rules to add; a rule with a built-in rule's id replaces it.
//   "disable": ids of rules to turn off (built-in or common ones).
// A rule: { "id", "kind", "regex", "ignoreCase"?, "prefix"?, "why"? }
// Kinds: ${RULE_KINDS.join(', ')}.
// A regex is at most ${MAX_PATTERN_LENGTH} characters, with no backreference,
// no lookbehind and no repeated group that can match in several ways
// ("(a+)+", "(a|aa)*"); it reads the screen's last ${MAX_SCREEN_TEXT} characters.
//
// Examples (remove the // to use them):
// "agents": {
//   "common": {
//     "rules": [
//       { "id": "approval-my-tool", "kind": "approval", "regex": "Continue\\\\? \\\\(yes/no\\\\)", "ignoreCase": true }
//     ],
//     "disable": ["approval-press-enter"]
//   },
//   "claude": {
//     "rules": [
//       { "id": "limit-claude-new", "kind": "limit", "regex": "out of usage for now", "ignoreCase": true }
//     ]
//   }
// }
{
  "engineVersion": ${RULES_ENGINE_VERSION},
  "agents": {}
}
`
