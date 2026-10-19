// Live Share: which of the host's agents (and which of their models) a
// guest may use, as one rule.
//
// A rule rides with a person's, an invitation's or a trusted person's rights
// (rights.agents, src/shared/liveShareRights.js), so it is saved, copied and
// checked wherever rights are. No rule (null, and every record saved before
// rules existed) means "as the share's setting says"; the share's setting
// with no rule means every agent and every model. A rule is:
//
//   { deny: [agent ids], later: bool, known: [agent ids],
//     models: { agent id: [model ids] } }
//
// - deny: the agents left out (a list of what is refused, so an agent the
//   host had when the rule was made and that is not in it stays allowed);
// - known: the agents the host had when the rule was last changed. An agent
//   not in it was installed (or subscribed to) later: allowed only when
//   `later` is on ("Allow agents I add later", on by default);
// - models: for an agent, the only models allowed (no entry: all of them).
//
// The host's Tessel enforces it (src/main/liveShare/shareHost.js: opening an
// agent, typing in an agent's pane, switching its model with /model); a
// guest's menu shows only what it allows, which is a convenience: the
// host's check is what counts.

// The same agent ids the host lists (shareHost.js isAgentId).
const AGENT_ID = /^[A-Za-z0-9][\w.-]{0,39}$/
// A model id as the agents' catalogs and CLIs name them (claude-opus-4-7,
// openai/gpt-5.1-codex, opus[1m]): one word, no control characters.
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const MODEL_ID = /^[^\s\u0000-\u001f\u007f]{1,120}$/
export const MAX_RULE_AGENTS = 64
export const MAX_RULE_MODELS = 64

export const isRuleAgentId = (id) => typeof id === 'string' && AGENT_ID.test(id)
export const isModelId = (id) => typeof id === 'string' && MODEL_ID.test(id)

const ids = (list, max, ok) => [...new Set((Array.isArray(list) ? list : []).filter(ok))].slice(0, max)

// A rule as given by anyone (a peer, a saved file, the window) -> a clean
// rule, or null (none: the share's setting counts).
export function cleanAgentRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null
  const models = {}
  const given = rule.models && typeof rule.models === 'object' && !Array.isArray(rule.models) ? rule.models : {}
  for (const id of Object.keys(given).filter(isRuleAgentId).slice(0, MAX_RULE_AGENTS)) {
    if (!Array.isArray(given[id])) continue
    models[id] = ids(given[id], MAX_RULE_MODELS, isModelId)
  }
  return {
    deny: ids(rule.deny, MAX_RULE_AGENTS, isRuleAgentId),
    later: rule.later !== false,
    known: ids(rule.known, MAX_RULE_AGENTS, isRuleAgentId),
    models
  }
}

// The rule that counts for someone: its own, else the share's (else none:
// everything).
export const effectiveAgentRule = (own, fallback) => cleanAgentRule(own) || cleanAgentRule(fallback)

// Whether an agent may be used under a rule.
export function agentAllowed(rule, agent) {
  const r = cleanAgentRule(rule)
  if (!r) return true
  if (!isRuleAgentId(agent) || r.deny.includes(agent)) return false
  // (An agent none of whose models is allowed is not allowed either.)
  if (Object.hasOwn(r.models, agent) && !r.models[agent].length) return false
  return r.known.includes(agent) || r.later
}

// The only models allowed for an agent (a list), or null (all of them).
export function allowedModels(rule, agent) {
  const r = cleanAgentRule(rule)
  return r && Object.hasOwn(r.models, agent) ? [...r.models[agent]] : null
}

// The same model id, as a catalog and a CLI may write it.
const sameModel = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

// Whether an agent may run that model. An empty model (not known yet, or the
// agent's own default) counts as allowed here: opening picks an allowed one
// (the host's window, liveShareWindow.js), and typing goes by the model the
// pane shows once it shows one.
export function modelAllowed(rule, agent, model) {
  if (!agentAllowed(rule, agent)) return false
  const list = allowedModels(rule, agent)
  if (!list || !model) return true
  return list.some((m) => sameModel(m, model))
}

// Whether a guest may type in a pane running this agent with this model
// ({ agent, model }: a shell has no agent, and is always allowed here).
export function paneTypeAllowed(rule, pane) {
  const agent = pane && typeof pane.agent === 'string' ? pane.agent : null
  if (!agent) return true
  return modelAllowed(rule, agent, pane.model || '')
}

// The host's agents a guest may see in its "open" menu: the allowed ones,
// each with its allowed models when the rule limits them (else no models:
// the host's default). list: [{ id, name, models? }].
export function agentsForGuest(rule, list) {
  const out = []
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || !agentAllowed(rule, a.id)) continue
    const only = allowedModels(rule, a.id)
    const entry = { id: a.id, name: a.name }
    if (only) {
      const known = Array.isArray(a.models) ? a.models : []
      entry.models = only.map((id) => known.find((m) => m && sameModel(m.id, id)) || { id, label: id })
    }
    out.push(entry)
  }
  return out
}

// --- Changing a rule (the rights editors) ---------------------------------------
// Each change starts from the rule as it is (none: everything) and the
// agents the host has now (hostIds): an agent added since the rule was last
// changed is taken in as it counts now (refused when `later` is off), so a
// change to one agent never lets another one in by the way.
const EVERYTHING = () => ({ deny: [], later: true, known: [], models: {} })
function absorb(rule, hostIds) {
  const r = cleanAgentRule(rule) || EVERYTHING()
  for (const id of ids(hostIds, MAX_RULE_AGENTS, isRuleAgentId)) {
    if (r.known.includes(id)) continue
    if (!r.later && !r.deny.includes(id)) r.deny.push(id)
    if (r.known.length < MAX_RULE_AGENTS) r.known.push(id)
  }
  r.deny = r.deny.slice(0, MAX_RULE_AGENTS)
  return r
}

// An agent allowed or not.
export function setAgentAllowed(rule, agent, on, hostIds = []) {
  if (!isRuleAgentId(agent)) return cleanAgentRule(rule)
  const r = absorb(rule, hostIds)
  r.deny = on ? r.deny.filter((x) => x !== agent) : [...new Set([...r.deny, agent])].slice(0, MAX_RULE_AGENTS)
  if (!r.known.includes(agent) && r.known.length < MAX_RULE_AGENTS) r.known.push(agent)
  return cleanAgentRule(r)
}

// "Allow agents I add later" on or off.
export function setAgentLater(rule, on, hostIds = []) {
  const r = absorb(rule, hostIds)
  r.later = !!on
  return cleanAgentRule(r)
}

// An agent's models: a list (only those), or null (all of them).
export function setAgentModels(rule, agent, models, hostIds = []) {
  if (!isRuleAgentId(agent)) return cleanAgentRule(rule)
  const r = absorb(rule, hostIds)
  if (Array.isArray(models)) r.models[agent] = ids(models, MAX_RULE_MODELS, isModelId)
  else delete r.models[agent]
  return cleanAgentRule(r)
}

// The same rule (none and none, or the same agents, models and "later").
export function sameAgentRule(a, b) {
  const x = cleanAgentRule(a)
  const y = cleanAgentRule(b)
  if (!x || !y) return !x && !y
  const sameSet = (p, q) => p.length === q.length && p.every((v) => q.includes(v))
  if (x.later !== y.later || !sameSet(x.deny, y.deny) || !sameSet(x.known, y.known)) return false
  const keys = Object.keys(x.models)
  return sameSet(keys, Object.keys(y.models)) && keys.every((k) => sameSet(x.models[k], y.models[k]))
}

// --- Switching models by typing ---------------------------------------------------
// A guest switching an allowed agent to another model types /model (Claude
// Code, Codex, Gemini, Grok...). What it types in a pane is followed here as
// the agent's input line would read it (each guest and pane its own line):
// printable text added, Backspace taking one back, Ctrl+C or Ctrl+U
// clearing it, Enter submitting it. -> { line (what stays typed), submitted
// (the lines Enter sent) }.
const MAX_LINE = 400
export function followTypedLine(line, data) {
  let cur = typeof line === 'string' ? line : ''
  const submitted = []
  const text = typeof data === 'string' ? data : ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r' || ch === '\n') {
      submitted.push(cur)
      cur = ''
    } else if (ch === '\x7f' || ch === '\b') cur = cur.slice(0, -1)
    else if (ch === '\x03' || ch === '\x15') cur = ''
    else if (ch === '\x1b') {
      // An escape sequence (arrows, bracketed paste marks): skipped whole.
      // eslint-disable-next-line no-control-regex -- escape sequences are what it skips
      const m = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.)/.exec(text.slice(i))
      if (m) i += m[0].length - 1
    } else if (ch >= ' ') cur = (cur + ch).slice(-MAX_LINE)
  }
  return { line: cur, submitted }
}

// Whether a submitted line switches to a model the rule refuses for this
// agent: "/model" with no model (it opens the agent's own picker, where any
// model can be chosen) or with one not allowed. Only for an agent whose
// models the rule limits.
export function refusedModelSwitch(rule, agent, submitted) {
  const list = allowedModels(rule, agent)
  if (!list) return false
  const m = /^\s*\/model\b\s*(\S*)/i.exec(String(submitted || ''))
  if (!m) return false
  return !m[1] || !list.some((x) => sameModel(x, m[1]))
}
