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

// Whether a rule keeps anything from guests (a rule that allows every agent,
// every model and the agents added later keeps nothing).
export function ruleRestricts(rule) {
  const r = cleanAgentRule(rule)
  return !!r && (r.deny.length > 0 || !r.later || Object.keys(r.models).length > 0)
}

// Whether a guest may type in a pane, from what runs in it: { agent, models,
// others } (agent: the pane's agent, null for a shell; models: the ids its
// model is known by, from each source that says it: all must be allowed,
// and none known counts as refused when the rule limits that agent's
// models; others: other agents found running in it, each checked too, their
// model unknown).
export function paneTypeAllowed(rule, pane) {
  if (!pane) return true
  const agent = typeof pane.agent === 'string' && pane.agent ? pane.agent : null
  const others = Array.isArray(pane.others) ? pane.others.filter((x) => typeof x === 'string' && x) : []
  for (const id of others) if (!agentAllowed(rule, id) || allowedModels(rule, id)) return false
  if (!agent) return true
  if (!agentAllowed(rule, agent)) return false
  const list = allowedModels(rule, agent)
  if (!list) return true
  const models = (Array.isArray(pane.models) ? pane.models : [pane.model]).filter((m) => typeof m === 'string' && m)
  return models.length > 0 && models.every((m) => list.some((x) => sameModel(x, m)))
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
// Code, Codex, Gemini, Grok...) or opens /config. What it types in a pane is
// followed as the agent's input line would read it (each person and pane its
// own line, across its reconnects): text inserted at the cursor, the arrows,
// Home and End, Backspace and Delete, Ctrl+W, Ctrl+U and Ctrl+K, Ctrl+C
// clearing it, Enter submitting it. Best effort: an agent's own keys can
// still change what it reads, so while a rule limits an agent's models, the
// keys that bring back or complete text Tessel can't see (Tab, Up and Down,
// Home, Ctrl+A, Alt+letter) are refused there outright (refusedKeys), and a
// switch Tessel did not see is caught afterwards (the host's safety net).
//
// state: { text, cursor, over } (over: the line went past MAX_LINE, its end
// not kept). -> { state, submitted: [{ text, over }] }
export const MAX_LINE = 400
const emptyLine = () => ({ text: '', cursor: 0, over: false })
export function followTypedLine(state, data) {
  const st = state && typeof state === 'object' && typeof state.text === 'string' ? { text: state.text, cursor: Math.max(0, Math.min(state.cursor | 0, state.text.length)), over: !!state.over } : emptyLine()
  const submitted = []
  const text = typeof data === 'string' ? data : ''
  const insert = (ch) => {
    if (st.text.length >= MAX_LINE) {
      st.over = true
      return
    }
    st.text = st.text.slice(0, st.cursor) + ch + st.text.slice(st.cursor)
    st.cursor += ch.length
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r' || ch === '\n') {
      submitted.push({ text: st.text, over: st.over })
      Object.assign(st, emptyLine())
    } else if (ch === '\x7f' || ch === '\b') {
      if (st.cursor > 0) {
        st.text = st.text.slice(0, st.cursor - 1) + st.text.slice(st.cursor)
        st.cursor--
      }
    } else if (ch === '\x03') Object.assign(st, emptyLine())
    else if (ch === '\x15') {
      st.text = st.text.slice(st.cursor)
      st.cursor = 0
    } else if (ch === '\x0b') st.text = st.text.slice(0, st.cursor)
    else if (ch === '\x17') {
      const before = st.text.slice(0, st.cursor).replace(/\S+\s*$/, '')
      st.text = before + st.text.slice(st.cursor)
      st.cursor = before.length
    } else if (ch === '\x01') st.cursor = 0
    else if (ch === '\x05') st.cursor = st.text.length
    else if (ch === '\x02') st.cursor = Math.max(0, st.cursor - 1)
    else if (ch === '\x06') st.cursor = Math.min(st.text.length, st.cursor + 1)
    else if (ch === '\x1b') {
      // eslint-disable-next-line no-control-regex -- escape sequences are what it reads
      const m = /^\x1b(?:\[([0-9;?]*)([ -/]*[@-~])|O(.)|(.))?/s.exec(text.slice(i))
      i += m[0].length - 1
      const key = m[2] ? (m[1] || '') + m[2] : m[3] ? 'O' + m[3] : ''
      if (key === 'D' || key === 'OD') st.cursor = Math.max(0, st.cursor - 1)
      else if (key === 'C' || key === 'OC') st.cursor = Math.min(st.text.length, st.cursor + 1)
      else if (key === 'H' || key === 'OH' || key === '1~' || key === '7~') st.cursor = 0
      else if (key === 'F' || key === 'OF' || key === '4~' || key === '8~') st.cursor = st.text.length
      else if (key === '3~') st.text = st.text.slice(0, st.cursor) + st.text.slice(st.cursor + 1)
    } else if (ch >= ' ') insert(ch)
  }
  return { state: st, submitted }
}

// Keys that bring back or complete text Tessel can't follow: Tab, Up and
// Down (history), Home and Ctrl+A (then an edit at the start), Alt+letter
// (agents' own shortcuts, Claude Code's Alt+P model picker included).
export function refusedKeys(data) {
  const text = typeof data === 'string' ? data : ''
  if (text.includes('\t') || text.includes('\x01')) return true
  // eslint-disable-next-line no-control-regex -- escape sequences are what it reads
  const re = /\x1b(?:\[([0-9;?]*)([ -/]*[@-~])|O(.)|(.))?/gs
  let m
  while ((m = re.exec(text))) {
    if (m[2] && /^(?:[0-9;]*[ABH]|1~|7~)$/.test((m[1] || '') + m[2])) return true
    if (m[3] && 'ABH'.includes(m[3])) return true
    // ESC then a character: Alt+that key (a lone Esc at the end is Esc).
    if (m[4] !== undefined && m[4] !== '\x1b') return true
  }
  return false
}

// A typed line as an agent's command reads it: compatibility forms folded
// (a fullwidth ／ is a /), invisible format characters dropped.
const commandText = (s) => String(s || '').normalize('NFKC').replace(/\p{Cf}/gu, '').trimStart()

// Whether a submitted line ({ text, over } or a string) may switch to a model
// the rule refuses for this agent: "/model" with no model (it opens the
// agent's own picker) or with one not allowed, a start of "/model" (the
// agent completes it), /models, /config or /settings (its model setting,
// Muse Code's picker and panel), or a command line too
// long to follow. Only for an agent whose models the rule limits.
export function refusedModelSwitch(rule, agent, submitted) {
  const list = allowedModels(rule, agent)
  if (!list) return false
  const entry = typeof submitted === 'string' ? { text: submitted, over: false } : submitted || {}
  const line = commandText(entry.text)
  if (!line.startsWith('/')) return false
  if (entry.over) return true
  const low = line.toLowerCase()
  const word = low.split(/\s/)[0]
  if (word.length >= 2 && '/model'.startsWith(word)) {
    if (word !== '/model') return true
  }
  if (word.length >= 4 && '/config'.startsWith(word)) return true
  if (/^\/config\b/.test(low)) return true
  // Muse Code's model picker (/models) and its settings panel (/settings),
  // where its model can be changed too.
  if (word === '/models' || (word.length >= 4 && '/settings'.startsWith(word))) return true
  const m = /^\/model\b\s*(\S*)/.exec(low)
  if (!m) return false
  return !m[1] || !list.some((x) => sameModel(x, m[1]))
}
