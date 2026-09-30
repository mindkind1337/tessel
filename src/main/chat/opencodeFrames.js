// OpenCode `serve` events (the /event SSE bus, v1 `message.*` / `session.*`)
// -> the chat adapter's normalized events (claudeChat.js / codexChat.js
// names). Pure (no I/O): tested against the frames recorded from opencode
// 1.18.33 (__tests__/fixtures/opencode-real-frames.jsonl).
//
// What the recording showed (plan, sections 3b and 3c):
// - one user turn = several assistant messages, one per step, each with
//   step-start -> parts -> step-finish {reason, tokens, cost}; the turn is
//   over at a step-finish 'stop', then session.idle;
// - text and reasoning deltas both come as message.part.delta (field
//   'text'): the part's type is known from its earlier message.part.updated;
// - every final assistant message.updated comes twice, and the user's
//   message.updated is sent again at each step: deduplicated here;
// - a failed turn: session.error, then idle, then the assistant's
//   message.updated with the same error, then idle AGAIN (settled once);
// - a sub-agent is a `task` tool part whose metadata.sessionId is the child
//   session; the child's events come on the same bus.
// The v2 `session.next.*` family is ignored on purpose.
import { clipText, TOOL_OUTPUT_MAX_BYTES } from './claudeFrames'
import { createSubagentTracker, subagentId } from './subagents.js'

const KEEP = 4096 // ids remembered for deduplication, per kind
const SETTLED_KEEP = 50

const str = (v) => (typeof v === 'string' ? v : '')
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function remember(set, value) {
  set.add(value)
  if (set.size > KEEP) set.delete(set.values().next().value)
}
function rememberMap(map, key, value) {
  map.set(key, value)
  if (map.size > KEEP) map.delete(map.keys().next().value)
}

// ---- permission posture ------------------------------------------------------

// The tools that may run without asking in Manual: they read, or keep
// OpenCode's own lists. Reads of .env files keep OpenCode's built-in ask.
// Everything else ("*": edit, bash, webfetch, websearch, task, MCP tools…)
// asks. The key order matters: OpenCode turns the object into rules in that
// order, and the last matching rule wins.
export const READ_RULES = { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask', '*.env.example': 'allow' }
export function strictPermission() {
  return {
    '*': 'ask',
    // Named too: a user's own map for these (merged key by key with ours)
    // is then replaced, never left after our catch-all.
    edit: 'ask',
    bash: 'ask',
    webfetch: 'ask',
    websearch: 'ask',
    codesearch: 'ask',
    read: { ...READ_RULES },
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    skill: 'allow',
    todowrite: 'allow',
    todoread: 'allow',
    // Asked on a card (QUESTIONS.md); it runs nothing.
    question: 'allow',
    external_directory: 'ask',
    doom_loop: 'ask'
  }
}
// Every agent a chat can use or a `task` call can reach gets the strict map:
// sub-agent sessions do NOT inherit the parent session's rules (recorded).
export const KNOWN_AGENTS = ['build', 'plan', 'general', 'explore']
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// The config given in OPENCODE_CONFIG_CONTENT (applied after the user's and
// the project's config files): the same strict rules for every agent, no
// sharing, no self-update. extraAgents: user or project agents seen in
// GET /agent (a restart adds them).
export function opencodeConfig({ extraAgents = [], plugins = [] } = {}) {
  const agent = {}
  const names = [...KNOWN_AGENTS, ...extraAgents.filter((n) => typeof n === 'string' && NAME.test(n) && !KNOWN_AGENTS.includes(n))]
  for (const name of names) {
    const permission = strictPermission()
    // Plan only reads and plans: its edits stay refused.
    if (name === 'plan') permission.edit = 'deny'
    agent[name] = { permission }
  }
  return {
    share: 'disabled',
    autoupdate: false,
    permission: strictPermission(),
    agent,
    ...(plugins.length ? { plugin: plugins.filter((x) => typeof x === 'string' && x) } : {})
  }
}

// A permission config map -> OpenCode's ordered rules.
export function rulesFromConfig(map) {
  const out = []
  for (const [permission, value] of Object.entries(obj(map))) {
    if (typeof value === 'string') out.push({ permission, pattern: '*', action: value })
    else for (const [pattern, action] of Object.entries(obj(value))) out.push({ permission, pattern, action })
  }
  return out
}

// The session's own ruleset (merged after the agent's when a tool runs, so it
// decides for the root session): Manual asks like the config. A `task` call
// asks too, except for the sub-agents the posture check verified (their tools
// still ask under their own agent's rules); Plan adds edit deny; Yolo allows
// everything.
export function sessionRuleset(mode, taskAgents = []) {
  if (mode === 'yolo') return [{ permission: '*', pattern: '*', action: 'allow' }]
  const rules = rulesFromConfig(strictPermission())
  rules.push({ permission: 'task', pattern: '*', action: 'ask' })
  for (const name of [...new Set(taskAgents)]) if (typeof name === 'string' && NAME.test(name)) rules.push({ permission: 'task', pattern: name, action: 'allow' })
  if (mode === 'plan') rules.push({ permission: 'edit', pattern: '*', action: 'deny' })
  return rules
}

// OpenCode's wildcard: '*' any run of characters, '?' one; the whole string.
export function wildcardMatch(pattern, value) {
  if (typeof pattern !== 'string' || typeof value !== 'string') return false
  const re = new RegExp(
    '^' +
      pattern
        .split('')
        .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\/-]/g, '\\$&')))
        .join('') +
      '$',
    's'
  )
  return re.test(value)
}

// The action the last matching rule gives (OpenCode: last match wins); no
// match: 'ask' (OpenCode's default).
export function lastMatch(rules, permission, pattern = '*') {
  let action = 'ask'
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || typeof r !== 'object') continue
    if (wildcardMatch(r.permission, permission) && wildcardMatch(r.pattern, pattern)) action = r.action
  }
  return action
}

// What must never run without asking in Manual. The last name stands for any
// tool OpenCode has no rule for (an MCP tool): the catch-all must ask.
export const GUARDED = ['edit', 'bash', 'webfetch', 'websearch', 'codesearch', 'external_directory', 'tessel_unknown_tool']
const SAFE = new Set(['ask', 'deny'])

// One permission in one ordered rule list -> null when it can never run
// without asking, else what allows it. The last catch-all rule (pattern '*')
// must ask or deny, and NO allow rule may come after it, whatever its
// pattern (a `bash "git *": allow` placed after it would win for those
// commands). external_directory is the one exception for pattern-specific
// allows: OpenCode itself appends its own folders (tool-output, skill
// folders) after every config, and a tool leaving the project still asks
// for its own permission (edit, bash).
export function guardedProblem(rules, permission) {
  const list = Array.isArray(rules) ? rules.filter((r) => r && typeof r === 'object') : []
  let last = -1
  list.forEach((r, i) => {
    if (r.pattern === '*' && wildcardMatch(r.permission, permission)) last = i
  })
  if (last >= 0 && !SAFE.has(list[last].action)) return `${permission} ${String(list[last].action)}`
  if (permission === 'external_directory') return null
  for (let i = last + 1; i < list.length; i++) {
    const r = list[i]
    if (r.action === 'allow' && wildcardMatch(r.permission, permission)) return `${permission} allow ${String(r.pattern).slice(0, 80)}`
  }
  return null
}
function agentProblem(rules) {
  for (const p of GUARDED) {
    const why = guardedProblem(rules, p)
    if (why) return why
  }
  return null
}

// agents: GET /agent, every one of them (hidden and primary ones included:
// OpenCode's own all-deny agents pass). primary: the agents the chat runs
// the session with (build, plan): the session's rules follow theirs. ->
// null when Manual holds, else what is wrong (English, logged).
export function opencodePostureProblem(agents, { sessionRules = null, primary = ['build', 'plan'] } = {}) {
  if (!Array.isArray(agents) || !agents.length) return 'no agents reported'
  const byName = new Map(agents.filter((a) => a && typeof a.name === 'string').map((a) => [a.name, a]))
  if (!byName.has('build')) return 'agent build missing'
  for (const a of byName.values()) {
    const own = Array.isArray(a.permission) ? a.permission : []
    const rules = primary.includes(a.name) ? [...own, ...(Array.isArray(sessionRules) ? sessionRules : [])] : own
    const why = agentProblem(rules)
    if (why) return `agent ${a.name}: ${why}`
  }
  return null
}

// Agents our config does not name yet whose own rules fail the check: named
// in the strict config at the one restart.
export function unknownAgents(agents, known = KNOWN_AGENTS) {
  return (Array.isArray(agents) ? agents : [])
    .filter((a) => a && typeof a.name === 'string' && NAME.test(a.name) && !known.includes(a.name) && agentProblem(a.permission))
    .map((a) => a.name)
    .slice(0, 64)
}

// The sub-agents a `task` call may start without asking: every agent that
// can be one (mode subagent or all, not hidden), all checked above.
export function taskAgents(agents) {
  return (Array.isArray(agents) ? agents : [])
    .filter((a) => a && typeof a.name === 'string' && NAME.test(a.name) && a.hidden !== true && (a.mode === 'subagent' || a.mode === 'all'))
    .map((a) => a.name)
    .slice(0, 64)
}

// GET /config (the merged config, which PATCH /config could change behind
// the chat): sharing still off, and the global and every agent's own map
// still strict for the guarded permissions.
export function opencodeConfigProblem(config) {
  const c = obj(config)
  if (c.share != null && c.share !== 'disabled') return `share ${String(c.share).slice(0, 20)}`
  const global = rulesFromConfig(c.permission)
  for (const p of GUARDED) {
    const why = guardedProblem(global, p)
    if (why) return `config permission: ${why}`
  }
  for (const [name, a] of Object.entries(obj(c.agent))) {
    const rules = [...global, ...rulesFromConfig(obj(a).permission)]
    for (const p of GUARDED) {
      const why = guardedProblem(rules, p)
      if (why) return `config agent ${name}: ${why}`
    }
  }
  return null
}

// The version OpenCode reports -> true when it is at least `min`.
export const MIN_VERSION = '1.18.33'
export function versionAtLeast(version, min = MIN_VERSION) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''))
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const a = parse(version)
  const b = parse(min)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}

export const sameRules = (a, b) => JSON.stringify(Array.isArray(a) ? a : null) === JSON.stringify(Array.isArray(b) ? b : null)

// OpenCode 1.18.33 APPENDS a PATCHed ruleset to the session's (checked
// live). Each of our rulesets starts with a catch-all '*' rule, and the last
// match wins: whatever comes before it no longer decides anything. So the
// session holds our posture when its rules END with ours.
export function endsWithRules(stored, rules) {
  if (!Array.isArray(stored) || !Array.isArray(rules) || !rules.length || stored.length < rules.length) return false
  const first = rules[0]
  if (!first || first.permission !== '*' || first.pattern !== '*') return false
  return sameRules(stored.slice(stored.length - rules.length), rules)
}

// ---- errors --------------------------------------------------------------------

// The error OpenCode reports -> a short message. Never its response headers
// or body (request ids): only data.message and the name.
export function opencodeErrorMessage(error) {
  const e = obj(error)
  const data = obj(e.data)
  const message = str(data.message) || str(e.message)
  const name = str(e.name)
  const text = message || name || 'error'
  return clipText(text, 2000)
}
export const isAbortError = (error) => str(obj(error).name) === 'MessageAbortedError'
const AUTH_TEXT = /opencode auth login|not (logged|signed) in|unauthori[sz]ed|invalid[ _]api[ _]key|api key (is )?(missing|invalid)/i
export function isOpencodeAuthError(error) {
  const e = obj(error)
  if (e.name === 'ProviderAuthError') return true
  const data = obj(e.data)
  if (e.name === 'APIError' && (data.statusCode === 401 || data.statusCode === 403)) return true
  return AUTH_TEXT.test(str(data.message))
}

// ---- tools -------------------------------------------------------------------------

const TOOL_NAMES = {
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  patch: 'Edit',
  apply_patch: 'Edit',
  multiedit: 'Edit',
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  list: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Agent',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
  skill: 'Skill',
  question: 'AskUserQuestion'
}
export function toolName(tool) {
  const t = str(tool)
  return TOOL_NAMES[t] || `tool:${t || 'unknown'}`
}

// OpenCode's inputs use camelCase paths (filePath): the chat reads file_path.
export function toolInput(tool, input) {
  const i = obj(input)
  const out = { ...i }
  if (typeof i.filePath === 'string') out.file_path = i.filePath
  if (str(tool) === 'task') {
    return { description: str(i.description), prompt: str(i.prompt), subagent_type: str(i.subagent_type) }
  }
  return out
}

function toolResult(state) {
  const s = obj(state)
  if (s.status === 'error') return { isError: true, text: str(s.error) }
  const out = typeof s.output === 'string' ? s.output : ''
  const exit = obj(s.metadata).exit
  return { isError: typeof exit === 'number' && exit !== 0, text: out }
}

// ---- permissions (asks) -----------------------------------------------------------

const DISPLAY = { bash: 'Bash', edit: 'Edit', webfetch: 'WebFetch', websearch: 'WebSearch', external_directory: 'Outside the folder', doom_loop: 'Repeated call', task: 'Agent' } // i18n-ignore tool names as the card shows them

// permission.asked -> the 'permission' event. The input holds everything the
// ask covers (patterns and metadata): the card shows it whole before Allow.
// "Allow for this session" answers 'always' with the ask's `always`
// patterns: offered only when there are some, and they are listed on the card.
export function permissionFromOpencode(requestId, ask, { scope = (v) => v } = {}) {
  const a = obj(ask)
  const permission = str(a.permission) || 'unknown'
  const md = obj(a.metadata)
  const patterns = Array.isArray(a.patterns) ? a.patterns.filter((p) => typeof p === 'string').slice(0, 200) : []
  // "Allow for this session" answers 'always' with these patterns. Offered
  // only when every one is a non-empty string of at most 300 characters, and
  // there are at most 50: anything else could not be shown whole.
  const rawAlways = a.always
  const always =
    Array.isArray(rawAlways) && rawAlways.length <= 50 && rawAlways.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 300) ? [...rawAlways] : []
  let input
  if (permission === 'bash') input = { command: str(md.command) || patterns.join('\n'), patterns, metadata: md }
  else if (permission === 'edit') input = { file_path: str(md.filepath) || str(md.filePath) || patterns[0] || '', patterns, metadata: md }
  else if (permission === 'webfetch') input = { url: str(md.url) || patterns[0] || '', patterns, metadata: md }
  else input = { permission, patterns, metadata: md }
  const toolName_ = { bash: 'Bash', edit: 'Edit', webfetch: 'WebFetch' }[permission] || permission
  const callId = str(obj(a.tool).callID)
  return {
    requestId,
    toolName: toolName_,
    permission,
    displayName: DISPLAY[permission] || permission,
    input,
    description: '',
    suggestions: [],
    sessionRules: always.map((content) => ({ kind: 'rule', tool: permission, content })),
    // The chat's vocabulary (sessions.js sessionAllowed).
    choices: always.length ? ['accept', 'acceptForSession', 'decline'] : ['accept', 'decline'],
    toolUseId: callId ? scope(callId) : null,
    reason: '',
    always
  }
}

// { behavior, session, message } -> the body of POST /permission/:id/reply.
export function opencodeReply({ behavior, session, message } = {}, always = []) {
  if (behavior === 'deny') return { reply: 'reject', ...(typeof message === 'string' && message ? { message } : {}) }
  if (behavior !== 'allow') return null
  if (session && Array.isArray(always) && always.length) return { reply: 'always' }
  return { reply: 'once' }
}

// ---- the normalizer ------------------------------------------------------------------

export function createOpencodeState({ sessionId = null, model = null, permissionMode = 'default', now = Date.now } = {}) {
  return {
    sessionId,
    model,
    permissionMode,
    version: null,
    contextWindow: null,
    subagents: createSubagentTracker(now),
    parts: new Map(), // partId -> { type, messageID }
    finalParts: new Set(), // text/reasoning parts already emitted final
    tools: new Map(), // scoped callID -> 'announced' | 'done'
    userMessages: new Set(), // user message ids (every session of ours)
    messages: new Map(), // assistant id -> { completed }
    steps: new Set(), // step-finish part ids counted
    childTokens: new Map(), // child session -> Map(messageId -> total)
    childErrors: new Set(),
    turn: null, // { id, started, settled, accepted, auto, uuids, userMessageId, lastText, error, aborted, stopSeen, usage, cost, startedAt }
    turnN: 0,
    settledTurns: new Set(),
    pending: [], // uuids sent, waiting for their echo
    sent: new Set(),
    interruptRequested: false,
    retrying: false,
    postureCheck: false,
    expectedRules: null // the session ruleset we set (Manual check on session.updated)
  }
}

function emptyUsage() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export function newOpencodeTurn(state, { auto = false } = {}) {
  state.turn = {
    id: `oc-turn-${++state.turnN}`,
    started: false,
    settled: false,
    accepted: false,
    auto,
    uuids: [],
    userMessageId: null,
    lastText: '',
    error: null,
    aborted: false,
    stopSeen: false,
    usage: emptyUsage(),
    cost: 0,
    steps: 0
  }
  return state.turn
}

const openTurn = (state) => (state.turn && !state.turn.settled ? state.turn : null)

function initEvent(state) {
  return {
    type: 'init',
    sessionId: state.sessionId,
    model: state.model,
    permissionMode: state.permissionMode,
    capabilities: [],
    mcpServers: [],
    tools: [],
    version: state.version
  }
}

function turnUsage(state, turn) {
  if (!turn.steps) return null
  const u = turn.usage
  return {
    input_tokens: u.input,
    cache_read_input_tokens: u.cacheRead,
    cache_creation_input_tokens: u.cacheWrite,
    output_tokens: u.output,
    reasoning_output_tokens: u.reasoning,
    total_tokens: u.total,
    context_window: typeof state.contextWindow === 'number' ? state.contextWindow : null
  }
}

// The open turn ends: turnEnd then state idle. Once.
export function settleOpencodeTurn(state, status, { error = null } = {}) {
  const turn = openTurn(state)
  if (!turn) return []
  turn.settled = true
  remember(state.settledTurns, turn.id)
  if (state.settledTurns.size > SETTLED_KEEP) state.settledTurns.delete(state.settledTurns.values().next().value)
  state.interruptRequested = false
  state.retrying = false
  const err = error || turn.error
  const message = status === 'failed' && err ? opencodeErrorMessage(err) : ''
  const out = []
  state.subagents.settle(groupOf(turn), status, out, turn)
  out.push(
    {
      type: 'turnEnd',
      status,
      result: status === 'completed' ? turn.lastText : message,
      isError: status !== 'completed',
      usage: turnUsage(state, turn),
      modelUsage: null,
      costUsd: turn.steps ? turn.cost : null,
      durationMs: null,
      userMessageUuids: [...turn.uuids],
      terminalReason: status,
      permissionDenials: [],
      errors: message ? [message] : [],
      turnId: turn.id
    },
    { type: 'state', state: 'idle' }
  )
  return out
}

const groupOf = (turn) => subagentId(turn && (turn.userMessageId || turn.id)) || null

// The session this event is about, and whether it is ours: the root, or a
// child in the tracker. -> 'root' | 'child' | null.
function whose(state, sid) {
  if (!sid) return null
  if (sid === state.sessionId) return 'root'
  return state.subagents.get(sid) ? 'child' : null
}

function sessionOf(type, p) {
  if (typeof p.sessionID === 'string') return p.sessionID
  if (type === 'message.updated') return str(obj(p.info).sessionID)
  if (type === 'message.part.updated') return str(obj(p.part).sessionID)
  if (type === 'session.created' || type === 'session.updated') return str(obj(p.info).id)
  return ''
}

// A new user message in the root session: the delivery proof of the oldest
// send still waiting for one.
function userMessage(state, info, out) {
  const id = str(info.id)
  if (!id || state.userMessages.has(id)) return
  remember(state.userMessages, id)
  let turn = openTurn(state)
  if (!state.pending.length) {
    // Not ours (a command's own message, a message another client sent):
    // the turn it starts is the agent's own.
    if (!turn) turn = newOpencodeTurn(state, { auto: true })
    if (!turn.userMessageId) turn.userMessageId = id
    return
  }
  const uuid = state.pending.shift()
  if (!turn) turn = newOpencodeTurn(state)
  turn.accepted = true
  if (!turn.userMessageId) turn.userMessageId = id
  turn.uuids.push(uuid)
  out.push({ type: 'accepted', uuid })
}

function addStep(state, turn, part) {
  const t = obj(part.tokens)
  const c = obj(t.cache)
  turn.steps++
  turn.usage.input += num(t.input)
  turn.usage.output += num(t.output)
  turn.usage.reasoning += num(t.reasoning)
  turn.usage.cacheRead += num(c.read)
  turn.usage.cacheWrite += num(c.write)
  turn.usage.total += num(t.total)
  turn.cost += num(part.cost)
}

// A tool part (root or child): tool_use once its input is known, the result
// once it completed or failed. scope: namespacing of a child's ids.
function toolPart(state, part, out, provenance, scope) {
  const callId = str(part.callID)
  if (!callId) return
  const id = scope(callId)
  const s = obj(part.state)
  const status = str(s.status)
  const input = obj(s.input)
  const seen = state.tools.get(id)
  if (seen === 'done') return
  if (!seen) {
    // 'pending' has no input yet: announced from 'running' (or the end).
    if (status === 'pending' || (status === 'running' && !Object.keys(input).length)) return
    rememberMap(state.tools, id, 'announced')
    out.push({ type: 'assistant', messageId: id, blocks: [{ type: 'tool_use', id, name: toolName(part.tool), input: toolInput(part.tool, input) }], ...provenance })
  }
  if (status === 'completed' || status === 'error') {
    rememberMap(state.tools, id, 'done')
    const r = toolResult(s)
    out.push({ type: 'toolResult', toolUseId: id, isError: r.isError, text: clipText(r.text, TOOL_OUTPUT_MAX_BYTES), ...provenance })
  }
}

// The root's task part: the child it runs (metadata.sessionId), its end.
function taskPart(state, part, out) {
  const s = obj(part.state)
  const md = obj(s.metadata)
  const child = subagentId(str(md.sessionId))
  if (!child || child === state.sessionId) return
  const turn = openTurn(state)
  const known = state.subagents.get(child)
  const input = obj(s.input)
  const status = str(s.status)
  let st
  if (status === 'error') st = 'failed'
  else if (status === 'completed') st = /state="(error|failed)"/.test(str(s.output)) ? 'failed' : 'completed'
  state.subagents.upsert(
    child,
    known ? known.groupId : groupOf(turn) || child,
    {
      ...(st ? { state: st } : {}),
      owner: known ? undefined : turn || undefined,
      description: str(input.description) || str(s.title) || undefined,
      subagentType: str(input.subagent_type) || undefined,
      parentToolUseId: str(part.callID) || undefined,
      model: md.model && typeof md.model === 'object' ? `${str(md.model.providerID)}/${str(md.model.modelID)}` : undefined
    },
    out
  )
}

function childEvent(state, type, p, sid, out) {
  const entry = state.subagents.get(sid)
  if (!entry) return
  const provenance = { agentId: entry.id, parentToolUseId: entry.parentToolUseId || entry.id }
  const scope = (value) => (value ? `${entry.id}:${value}` : '')
  switch (type) {
    case 'message.updated': {
      const info = obj(p.info)
      if (info.role === 'user') {
        remember(state.userMessages, str(info.id))
        break
      }
      if (info.error && !isAbortError(info.error)) remember(state.childErrors, sid)
      const t = obj(info.tokens)
      if (info.time && info.time.completed && typeof t.total === 'number') {
        let per = state.childTokens.get(sid)
        if (!per) {
          per = new Map()
          rememberMap(state.childTokens, sid, per)
        }
        per.set(str(info.id), t.total)
        // The latest step's total is the child's context: what it uses now.
        state.subagents.upsert(entry.id, entry.groupId, { tokens: t.total }, out)
      }
      break
    }
    case 'message.part.updated': {
      const part = obj(p.part)
      const pid = str(part.id)
      if (pid) rememberMap(state.parts, pid, { type: str(part.type), messageID: str(part.messageID) })
      if (state.userMessages.has(str(part.messageID))) break
      if ((part.type === 'text' || part.type === 'reasoning') && obj(part.time).end && !state.finalParts.has(pid)) {
        remember(state.finalParts, pid)
        const text = str(part.text)
        if (!text) break
        out.push({ type: 'assistant', messageId: scope(pid), blocks: [{ type: part.type === 'text' ? 'text' : 'thinking', text }], ...provenance })
      } else if (part.type === 'tool' && entry.state === 'working') {
        const before = out.length
        toolPart(state, part, out, provenance, scope)
        for (const ev of out.slice(before)) {
          if (ev.type === 'assistant') state.subagents.progress(entry.id, { id: ev.blocks[0].id, name: ev.blocks[0].name, status: 'running' }, out)
          if (ev.type === 'toolResult') state.subagents.progress(entry.id, { id: ev.toolUseId, status: ev.isError ? 'failed' : 'completed' }, out)
        }
      }
      break
    }
    case 'message.part.delta': {
      const part = state.parts.get(str(p.partID))
      if (p.field === 'text' && part && part.type === 'text' && typeof p.delta === 'string' && p.delta)
        out.push({ type: 'textDelta', messageId: scope(str(p.partID)), index: 0, text: p.delta, ...provenance })
      break
    }
    case 'session.error':
      if (!isAbortError(p.error)) remember(state.childErrors, sid)
      break
    case 'session.idle':
      state.subagents.upsert(entry.id, entry.groupId, { state: state.childErrors.has(sid) ? 'failed' : 'completed' }, out)
      break
    case 'session.status': {
      const t = str(obj(p.status).type)
      if (t === 'idle') state.subagents.upsert(entry.id, entry.groupId, { state: state.childErrors.has(sid) ? 'failed' : 'completed' }, out)
      break
    }
    default:
      break
  }
}

// One SSE event -> zero or more normalized events. The adapter handles the
// ones that need an answer (permission.*, question.*) itself.
export function normalizeOpencodeEvent(evt, state) {
  const out = []
  const e = obj(evt)
  const type = str(e.type)
  const p = obj(e.properties)
  const sid = sessionOf(type, p)

  // A child session of ours (its parent is the root or one of ours).
  if (type === 'session.created') {
    const info = obj(p.info)
    const parent = str(info.parentID)
    const id = subagentId(str(info.id))
    if (id && parent && id !== state.sessionId && (parent === state.sessionId || state.subagents.get(parent))) {
      const turn = openTurn(state)
      const known = state.subagents.get(id)
      const parentEntry = state.subagents.get(parent)
      const title = str(info.title).replace(/\s*\(@[\w.-]+ subagent\)\s*$/, '')
      state.subagents.upsert(
        id,
        known ? known.groupId : parentEntry ? parentEntry.groupId : groupOf(turn) || id,
        { owner: known ? undefined : turn || undefined, description: title || undefined, subagentType: str(info.agent) || undefined },
        out
      )
    }
    return out
  }

  const who = whose(state, sid)
  if (who === 'child') {
    childEvent(state, type, p, sid, out)
    return out
  }
  if (who !== 'root') {
    // Another session's (not ours) or a global event.
    if (type === 'session.error' && !sid) {
      const turn = openTurn(state)
      if (turn && !isAbortError(p.error)) turn.error = turn.error || obj(p.error)
    }
    return out
  }

  switch (type) {
    case 'message.updated': {
      const info = obj(p.info)
      if (info.role === 'user') {
        userMessage(state, info, out)
        break
      }
      if (info.role !== 'assistant') break
      const id = str(info.id)
      const turn = openTurn(state)
      const model = str(info.providerID) && str(info.modelID) ? `${info.providerID}/${info.modelID}` : null
      if (model && model !== state.model) {
        state.model = model
        out.push(initEvent(state))
      }
      if (!turn) break
      const completed = !!obj(info.time).completed
      const prior = state.messages.get(id)
      if (prior && prior.completed) break // the duplicate final update
      rememberMap(state.messages, id, { completed })
      if (completed && info.error) {
        if (isAbortError(info.error)) turn.aborted = true
        else turn.error = turn.error || obj(info.error)
      }
      if (completed && info.finish === 'stop') turn.stopSeen = true
      break
    }
    case 'message.part.updated': {
      const part = obj(p.part)
      const pid = str(part.id)
      if (pid) rememberMap(state.parts, pid, { type: str(part.type), messageID: str(part.messageID) })
      if (state.userMessages.has(str(part.messageID))) break
      const turn = openTurn(state)
      if (part.type === 'text' || part.type === 'reasoning') {
        if (!obj(part.time).end || state.finalParts.has(pid)) break
        remember(state.finalParts, pid)
        const text = str(part.text)
        if (!text || part.synthetic === true) break
        if (part.type === 'text' && turn) turn.lastText = text
        out.push({ type: 'assistant', messageId: pid, blocks: [{ type: part.type === 'text' ? 'text' : 'thinking', text }], parentToolUseId: null })
      } else if (part.type === 'tool') {
        if (part.tool === 'task') taskPart(state, part, out)
        toolPart(state, part, out, { parentToolUseId: null }, (v) => v)
      } else if (part.type === 'step-finish') {
        if (!pid || state.steps.has(pid) || !turn) break
        remember(state.steps, pid)
        addStep(state, turn, part)
        if (part.reason === 'stop') turn.stopSeen = true
      }
      break
    }
    case 'message.part.delta': {
      const part = state.parts.get(str(p.partID))
      // Reasoning deltas are not streamed (the chat has no live thinking
      // row): the reasoning comes whole with its final part.
      if (p.field === 'text' && part && part.type === 'text' && typeof p.delta === 'string' && p.delta) {
        if (!openTurn(state)) newOpencodeTurn(state, { auto: true })
        out.push({ type: 'textDelta', messageId: str(p.partID), index: 0, text: p.delta, parentToolUseId: null })
      }
      break
    }
    case 'session.status': {
      const st = obj(p.status)
      const t = str(st.type)
      if (t === 'busy') {
        state.retrying = false
        let turn = openTurn(state)
        // Busy with a send still unconfirmed: the echo will come (never a
        // turn of its own).
        if (!turn && state.pending.length) break
        if (!turn) turn = newOpencodeTurn(state, { auto: true })
        if (!turn.started) {
          turn.started = true
          out.push({ type: 'state', state: 'running' }, initEvent(state))
        }
      } else if (t === 'retry') {
        state.retrying = true
        out.push({ type: 'retry', message: clipText(str(st.message), 2000), attempt: num(st.attempt) })
      } else if (t === 'idle') {
        out.push(...idle(state))
      }
      break
    }
    case 'session.idle':
      out.push(...idle(state))
      break
    case 'session.error': {
      const error = obj(p.error)
      const turn = openTurn(state)
      if (isAbortError(error)) {
        if (turn) turn.aborted = true
        break
      }
      if (isOpencodeAuthError(error)) out.push({ type: 'authError', message: opencodeErrorMessage(error) })
      if (turn) turn.error = turn.error || error
      else out.push({ type: 'opencodeError', message: opencodeErrorMessage(error) })
      break
    }
    case 'session.updated': {
      const info = obj(p.info)
      if (state.postureCheck && Array.isArray(info.permission) && !endsWithRules(info.permission, state.expectedRules))
        out.push({ type: 'postureMismatch', reason: 'session permission changed' })
      break
    }
    default:
      break
  }
  return out
}

// The root session is idle. Settles the open turn once, unless it is only a
// send whose echo has not come yet (the duplicate idle of the turn before).
function idle(state) {
  const turn = openTurn(state)
  if (!turn) return []
  if (!turn.accepted && !turn.auto && !turn.error && !turn.aborted && !state.interruptRequested) return []
  const status = state.interruptRequested || turn.aborted ? 'interrupted' : turn.error ? 'failed' : 'completed'
  return settleOpencodeTurn(state, status)
}
