// One Codex chat: a long-lived `codex app-server` process speaking JSON-RPC
// over JSONL on stdio, with the same API and normalized events as
// claudeChat.js (the session manager does not know which one it drives).
// Protocol as recorded from codex-cli 0.158.0 (plan section 9.2):
// - ready = initialize answered, `initialized` sent, the thread opened;
// - approval policy and sandbox go explicitly on EVERY thread/start,
//   thread/resume and turn/start: an omitted field inherits config.toml
//   (often approval_policy="never" + danger-full-access) or, on a resume,
//   the thread's last posture;
// - a turn ends with turn/completed, or with an `error` notification that
//   has willRetry:false (then turn/completed may never come);
// - delivery proof = the userMessage item whose clientId is our uuid.
//
// Protocol handling informed by Orca's Codex app-server client
// (github.com/stablyai/orca, src/main/codex/, MIT licence).
import { EventEmitter } from 'events'
import { spawn as nodeSpawn } from 'child_process'
import { randomUUID } from 'crypto'
import { killClaudeTree } from './claudeChat'
import { clipText, toolResultText, TOOL_OUTPUT_MAX_BYTES } from './claudeFrames'
import { createSubagentTracker, subagentTokens } from './subagents.js'
import { observeCodexSubagents } from './codexSubagents.js'

export const PERMISSION_MODES = ['default', 'bypassPermissions', 'acceptEdits', 'plan']
// quitKill: how long a kill on quit waits for the exit before giving up.
export const DEFAULT_TIMEOUTS = { start: 30000, request: 30000, close: 3000, exitFlush: 1000, idleSettle: 10000, accountProbe: 5000, quitKill: 1500 }
export const killCodexTree = killClaudeTree
const STDERR_TAIL = 8 * 1024
export const MAX_LINE = 8 * 1024 * 1024 // a line longer than this is dropped (runaway output)
export const MAX_APPROVALS = 50 // pending approvals at once; more are declined
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/
// Model / effort names: plain words ("gpt-6-astra", "low"), never a flag.
const NAME = /^[A-Za-z0-9][\w.:[\]/-]{0,99}$/
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g
const SETTLED_KEEP = 50

export const COMMAND_APPROVAL = 'item/commandExecution/requestApproval'
export const FILE_APPROVAL = 'item/fileChange/requestApproval'
export const MCP_ELICITATION = 'mcpServer/elicitation/request'
const DEFAULT_CHOICES = ['accept', 'acceptForSession', 'decline', 'cancel']

// ---- permission posture ------------------------------------------------------

// Yolo: no prompts, no sandbox. Manual: prompts on request, writes confined to
// the workspace (not read-only: that would prompt for every file write).
// Thread requests take `sandbox` (a mode name), turn/start takes
// `sandboxPolicy` (an object); the reviewer is pinned to the user so a
// config.toml auto-review cannot answer in the user's place.
export function codexPolicy(permissions) {
  if (permissions === 'yolo') {
    return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  }
  return {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  }
}
// ---- what Codex applied (Manual) ------------------------------------------------

// Manual's posture as Codex reports it back: approvals on request, a sandbox
// that confines writes (an allow-list: full access, an external sandbox or an
// unknown kind are refused), and the user as the reviewer.
const SAFE_SANDBOXES = new Set(['workspaceWrite', 'workspace-write', 'workspace_write', 'readOnly', 'read-only', 'read_only'])
const ON_REQUEST = new Set(['on-request', 'onRequest', 'on_request'])

function field(o, camel, snake) {
  if (o[camel] != null) return o[camel]
  if (o[snake] != null) return o[snake]
  return undefined
}

function sandboxKind(v) {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && typeof v.type === 'string') return v.type
  return null
}

function shortJson(v) {
  try {
    return String(JSON.stringify(v)).slice(0, 80)
  } catch {
    return '?'
  }
}

// settings: a thread/start or thread/resume answer, or the threadSettings of
// thread/settings/updated (sandbox or sandboxPolicy, camel or snake case).
// strict (the start answer): approvalPolicy and the sandbox must be there,
// else the posture is unverified; otherwise only the fields present count.
// -> null when it is Manual's posture, else what is wrong (English, logged).
export function manualPostureProblem(settings, { strict = false } = {}) {
  const s = obj(settings)
  const policy = field(s, 'approvalPolicy', 'approval_policy')
  if (policy === undefined) {
    if (strict) return 'approvalPolicy missing'
  } else if (!ON_REQUEST.has(policy)) return `approvalPolicy ${shortJson(policy)}`
  let sandbox = field(s, 'sandboxPolicy', 'sandbox_policy')
  if (sandbox === undefined && s.sandbox != null) sandbox = s.sandbox
  if (sandbox === undefined) {
    if (strict) return 'sandbox missing'
  } else {
    const kind = sandboxKind(sandbox)
    if (!kind || !SAFE_SANDBOXES.has(kind)) return `sandbox ${kind || shortJson(sandbox)}`
  }
  const reviewer = field(s, 'approvalsReviewer', 'approvals_reviewer')
  if (reviewer !== undefined && reviewer !== 'user') return `approvalsReviewer ${shortJson(reviewer)}`
  return null
}

const threadPolicy = (p) => ({ approvalPolicy: p.approvalPolicy, approvalsReviewer: p.approvalsReviewer, sandbox: p.sandbox })
const turnPolicy = (p) => ({ approvalPolicy: p.approvalPolicy, approvalsReviewer: p.approvalsReviewer, sandboxPolicy: p.sandboxPolicy })

// The command line (argument array, never through a shell).
export function buildCodexArgs({ exeArgs = [] } = {}) {
  return [...exeArgs, 'app-server']
}

// ---- auth hints ----------------------------------------------------------------

// Wording Codex uses when it has no usable credentials. A guess from the CLI's
// messages (not recorded in the spike): only a hint where no structured
// field (codexErrorInfo 'unauthorized' / HTTP 401) says it.
const AUTH_TEXT = /not (logged|signed) in|codex login|unauthori[sz]ed|\b401\b|invalid[ _]api[ _]key|(access|refresh|authentication) token (has |is )?(expired|invalid|revoked)|(log|sign) ?in again/i
export function isCodexAuthText(text) {
  return typeof text === 'string' && AUTH_TEXT.test(text)
}

export function isCodexAuthError(err) {
  if (!err || typeof err !== 'object') return false
  const info = err.codexErrorInfo
  if (info === 'unauthorized') return true
  if (info && typeof info === 'object') {
    for (const v of Object.values(info)) if (v && typeof v === 'object' && v.httpStatusCode === 401) return true
  }
  return isCodexAuthText(err.message) || isCodexAuthText(err.additionalDetails)
}

// ---- pure frame normalization -------------------------------------------------

// The state the normalizer keeps between notifications of one process.
export function createCodexState({ threadId = null, model = null, permissionMode = 'default', now = Date.now } = {}) {
  return {
    threadId,
    subagents: createSubagentTracker(now),
    model,
    permissionMode,
    cliVersion: null,
    turn: null, // { id, started, settled, uuids, lastText, usageBase }
    settledTurns: new Set(), // ended turn ids: a late turn/completed is a duplicate
    sent: new Set(), // clientUserMessageIds of ours (the adapter adds them)
    accepted: new Set(),
    early: [], // accepted before their turn was known (echo before turn/started)
    interruptRequested: false,
    usage: null, // last ThreadTokenUsage
    mcpServers: new Map(), // name -> status
    tools: new Set(), // tool items reported started
    fileChanges: new Map(), // fileChange itemId -> changes (for its approval card)
    retrying: false,
    postureCheck: false // Manual: every thread/settings/updated is checked (manualPostureProblem)
  }
}

export function newTurn(state, id) {
  state.turn = { id, started: false, settled: false, uuids: state.early.splice(0), lastText: '', usageBase: state.usage && state.usage.total ? { ...state.usage.total } : null }
  return state.turn
}

const str = (v) => (typeof v === 'string' ? v : '')
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

// The shell wrapper ("powershell.exe -Command '…'") hides the command: one
// parsed action is the command as the model wrote it.
function displayCommand(command, actions) {
  const list = Array.isArray(actions) ? actions.filter((a) => a && typeof a.command === 'string' && a.command) : []
  return list.length === 1 ? list[0].command : str(command)
}

function commandInput(command, cwd, actions) {
  const shown = displayCommand(command, actions)
  return { command: shown, cwd: str(cwd), ...(shown !== str(command) && command ? { rawCommand: String(command) } : {}) }
}

function changesOf(item) {
  return (Array.isArray(item.changes) ? item.changes : [])
    .filter((c) => c && typeof c.path === 'string')
    .map((c) => ({ path: c.path, kind: str(obj(c.kind).type) || 'update', diff: clipText(str(c.diff)) }))
}

function toolUseOf(item, state) {
  switch (item.type) {
    case 'collabAgentToolCall':
      return { name: item.tool === 'spawnAgent' || item.tool === 'spawn_agent' ? 'Agent' : str(item.tool), input: { description: str(item.prompt), model: item.model ?? null, receiverThreadIds: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.slice(0, 64) : [] } }
    case 'commandExecution':
      return { name: 'Bash', input: commandInput(item.command, item.cwd, item.commandActions) }
    case 'fileChange': {
      const changes = changesOf(item)
      state.fileChanges.set(item.id, changes)
      return { name: 'Edit', input: { file_path: changes.length ? changes[0].path : '', changes } }
    }
    case 'mcpToolCall': {
      const args = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments) ? item.arguments : { arguments: item.arguments ?? null }
      return { name: `mcp:${str(item.server)}.${str(item.tool)}`, input: args }
    }
    case 'dynamicToolCall': {
      const args = item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments) ? item.arguments : { arguments: item.arguments ?? null }
      return { name: `tool:${item.namespace ? `${item.namespace}.` : ''}${str(item.tool)}`, input: args }
    }
    case 'webSearch': {
      const a = obj(item.action)
      return { name: 'WebSearch', input: { query: str(item.query) || str(a.query) || (Array.isArray(a.queries) ? a.queries.join(' | ') : '') || str(a.url) } }
    }
    default:
      return null
  }
}

function toolResultOf(item) {
  const status = str(item.status)
  switch (item.type) {
    case 'collabAgentToolCall':
      return { isError: status === 'failed', text: JSON.stringify(item.agentsStates || {}) }
    case 'commandExecution': {
      const out = str(item.aggregatedOutput)
      const failed = status === 'failed' || status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
      // i18n-ignore tool output text, like the CLI's own
      const text = status === 'declined' ? out || 'The command was declined.' : out
      return { isError: failed, text }
    }
    case 'fileChange': {
      const lines = changesOf(item).map((c) => `${c.kind} ${c.path}`)
      // i18n-ignore tool output text
      if (status === 'declined') lines.unshift('The change was declined.')
      return { isError: status !== 'completed', text: lines.join('\n') }
    }
    case 'mcpToolCall': {
      if (item.error && typeof item.error === 'object') return { isError: true, text: str(item.error.message) }
      const r = obj(item.result)
      let text = toolResultText(Array.isArray(r.content) ? r.content : [])
      if (!text && r.structuredContent != null) text = JSON.stringify(r.structuredContent)
      return { isError: status === 'failed', text }
    }
    case 'dynamicToolCall': {
      const items = Array.isArray(item.contentItems) ? item.contentItems : []
      const text = items.map((c) => (c && c.type === 'inputText' ? str(c.text) : `[${str(c && c.type) || 'content'}]`)).join('\n')
      return { isError: item.success === false || status === 'failed', text }
    }
    case 'webSearch': {
      const n = Array.isArray(item.results) ? item.results.length : null
      return { isError: false, text: n == null ? str(item.query) : `${str(item.query)} (${n} results)` }
    }
    default:
      return null
  }
}

function accept(state, item, out) {
  const id = item.clientId
  if (typeof id !== 'string' || !state.sent.has(id) || state.accepted.has(id)) return
  state.accepted.add(id)
  if (state.turn && !state.turn.settled) state.turn.uuids.push(id)
  else state.early.push(id)
  out.push({ type: 'accepted', uuid: id })
}

function turnUsage(state, turn) {
  const tu = state.usage
  if (!tu || !tu.total) return null
  const base = turn.usageBase || {}
  const d = (k) => Math.max(0, (Number(tu.total[k]) || 0) - (Number(base[k]) || 0))
  return {
    input_tokens: d('inputTokens'),
    cache_read_input_tokens: d('cachedInputTokens'),
    output_tokens: d('outputTokens'),
    reasoning_output_tokens: d('reasoningOutputTokens'),
    total_tokens: d('totalTokens'),
    context_window: typeof tu.modelContextWindow === 'number' ? tu.modelContextWindow : null
  }
}

function initEvent(state) {
  return {
    type: 'init',
    sessionId: state.threadId,
    model: state.model,
    permissionMode: state.permissionMode,
    capabilities: [],
    mcpServers: [...state.mcpServers].map(([name, status]) => ({ name, status })),
    tools: [],
    version: state.cliVersion
  }
}

// The open turn ends: turnEnd then state idle. Once per turn id.
function markSettled(state, id) {
  if (!id) return
  state.settledTurns.add(id)
  if (state.settledTurns.size > SETTLED_KEEP) state.settledTurns.delete(state.settledTurns.values().next().value)
}

// A turnId that is not the open turn's only marks that turn as ended.
export function settleTurn(state, status, { error = null, durationMs = null, turnId = null } = {}) {
  if (turnId && state.settledTurns.has(turnId)) return []
  let turn = state.turn && !state.turn.settled ? state.turn : null
  if (turn && turnId && turn.id && turn.id !== turnId) {
    markSettled(state, turnId)
    return []
  }
  if (!turn) turn = newTurn(state, turnId)
  else if (!turn.id && turnId) turn.id = turnId
  turn.settled = true
  markSettled(state, turn.id)
  state.interruptRequested = false
  state.retrying = false
  state.tools.clear()
  state.fileChanges.clear()
  const message = error ? str(error.message) : ''
  const subagentEvents = []
  // Its group, and every child first seen while it was open, whatever group.
  state.subagents.settle(turn.id || null, status, subagentEvents, turn)
  return [
    ...subagentEvents,
    {
      type: 'turnEnd',
      status,
      result: status === 'completed' ? turn.lastText : message,
      isError: status !== 'completed',
      usage: turnUsage(state, turn),
      modelUsage: null,
      costUsd: null,
      durationMs: typeof durationMs === 'number' ? durationMs : null,
      userMessageUuids: [...turn.uuids],
      terminalReason: status,
      permissionDenials: [],
      errors: message ? [message] : [],
      turnId: turn.id,
      codexErrorInfo: error && error.codexErrorInfo != null ? error.codexErrorInfo : null
    },
    { type: 'state', state: 'idle' }
  ]
}

function rateWindow(w) {
  if (!w || typeof w !== 'object' || typeof w.usedPercent !== 'number') return null
  return { utilization: w.usedPercent / 100, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null }
}

// primary / secondary by their length (the weekly window came as primary in
// the recording), in claudeChat's shape: utilization 0..1, resetsAt seconds.
export function rateLimitFromCodex(snapshot) {
  const s = obj(snapshot)
  let fiveHour = null
  let sevenDay = null
  for (const w of [s.primary, s.secondary]) {
    const mins = w && typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null
    if (mins == null) continue
    if (mins >= 240 && mins <= 360) fiveHour = rateWindow(w)
    else if (mins >= 9000 && mins <= 11000) sevenDay = rateWindow(w)
  }
  if (!fiveHour && !sevenDay) return null
  return { status: s.rateLimitReachedType ? 'rejected' : 'allowed', fiveHour, sevenDay, planType: typeof s.planType === 'string' ? s.planType : null }
}

// One notification -> zero or more normalized events (claudeChat's names).
export function normalizeCodexNotification(method, params, state) {
  const out = []
  const p = obj(params)
  // Only a child explicitly linked by this parent's collab item may contribute.
  if (typeof p.threadId === 'string' && state.threadId && p.threadId !== state.threadId) return normalizeCodexChild(method, p, state)
  out.push(...observeCodexSubagents(method, p, state))
  const turn = state.turn && !state.turn.settled ? state.turn : null
  if (turn && typeof p.turnId === 'string' && p.turnId === turn.id && method !== 'error') state.retrying = false
  switch (method) {
    case 'thread/started': {
      const t = obj(p.thread)
      if (typeof t.cliVersion === 'string') state.cliVersion = t.cliVersion
      break
    }
    case 'turn/started': {
      const id = str(obj(p.turn).id)
      if (!id || state.settledTurns.has(id)) break
      const t = turn && turn.id === id ? turn : newTurn(state, id)
      if (t.started) break
      t.started = true
      out.push({ type: 'state', state: 'running' }, initEvent(state))
      break
    }
    case 'turn/completed': {
      const t = obj(p.turn)
      const id = str(t.id)
      if (id && state.settledTurns.has(id)) break // after an error that ended it
      const status = ['completed', 'interrupted', 'failed'].includes(t.status) ? t.status : 'failed'
      const error = t.error && typeof t.error === 'object' ? t.error : null
      if (error && isCodexAuthError(error)) out.push({ type: 'authError', message: str(error.message) })
      out.push(...settleTurn(state, status, { error, durationMs: t.durationMs, turnId: id || null }))
      break
    }
    case 'error': {
      const error = obj(p.error)
      if (p.willRetry === true) {
        state.retrying = true
        out.push({ type: 'retry', message: str(error.message) })
        break
      }
      const id = typeof p.turnId === 'string' ? p.turnId : null
      if (id && state.settledTurns.has(id)) break
      if (isCodexAuthError(error)) out.push({ type: 'authError', message: str(error.message) })
      // Ends the turn: turn/completed may never follow.
      if (turn || id) out.push(...settleTurn(state, 'failed', { error, turnId: id || (turn && turn.id) }))
      else out.push({ type: 'codexError', message: str(error.message) })
      break
    }
    case 'item/started':
    case 'item/completed': {
      const item = obj(p.item)
      if (item.type === 'userMessage') {
        accept(state, item, out)
        break
      }
      if (method === 'item/completed' && item.type === 'agentMessage') {
        const text = str(item.text)
        if (turn) turn.lastText = text
        if (text) out.push({ type: 'assistant', messageId: str(item.id) || null, blocks: [{ type: 'text', text }], parentToolUseId: null })
        break
      }
      if (method === 'item/completed' && item.type === 'reasoning') {
        const parts = (Array.isArray(item.summary) && item.summary.length ? item.summary : Array.isArray(item.content) ? item.content : []).filter((s) => typeof s === 'string' && s)
        if (parts.length) out.push({ type: 'assistant', messageId: str(item.id) || null, blocks: [{ type: 'thinking', text: parts.join('\n\n') }], parentToolUseId: null })
        break
      }
      const id = str(item.id)
      if (!id) break
      if (!state.tools.has(id)) {
        const use = toolUseOf(item, state)
        if (!use) break
        state.tools.add(id)
        out.push({ type: 'assistant', messageId: id, blocks: [{ type: 'tool_use', id, name: use.name, input: use.input }], parentToolUseId: null })
      } else if (item.type === 'fileChange') {
        state.fileChanges.set(id, changesOf(item))
      }
      if (method === 'item/completed') {
        const r = toolResultOf(item)
        if (r) out.push({ type: 'toolResult', toolUseId: id, isError: r.isError, text: clipText(r.text, TOOL_OUTPUT_MAX_BYTES), parentToolUseId: null })
      }
      break
    }
    case 'item/agentMessage/delta': {
      if (typeof p.delta === 'string' && p.delta) out.push({ type: 'textDelta', messageId: str(p.itemId) || null, index: 0, text: p.delta, parentToolUseId: null })
      break
    }
    case 'thread/tokenUsage/updated': {
      const tu = p.tokenUsage
      if (!tu || typeof tu !== 'object' || !tu.total) break
      state.usage = tu
      out.push({ type: 'usage', total: tu.total, last: tu.last ?? null, contextWindow: typeof tu.modelContextWindow === 'number' ? tu.modelContextWindow : null })
      break
    }
    case 'account/rateLimits/updated': {
      const r = rateLimitFromCodex(p.rateLimits)
      if (r) out.push({ type: 'rateLimit', ...r })
      break
    }
    case 'model/rerouted': {
      if (typeof p.toModel === 'string' && p.toModel) {
        state.model = p.toModel
        out.push(initEvent(state))
      }
      break
    }
    case 'thread/settings/updated': {
      const settings = obj(p.threadSettings || p.settings)
      const m = settings.model
      if (typeof m === 'string' && m) state.model = m
      if (state.postureCheck) {
        const problem = manualPostureProblem(settings)
        if (problem) out.push({ type: 'postureMismatch', reason: problem })
      }
      break
    }
    case 'mcpServer/startupStatus/updated': {
      if (typeof p.name === 'string') state.mcpServers.set(p.name, str(p.status))
      break
    }
    default:
      break // hooks, deltas of tools, plans, warnings, unknown notifications
  }
  return out
}

function normalizeCodexChild(method, p, state) {
  const entry = state.subagents.get(p.threadId)
  if (!entry) return []
  const out = [], provenance = { agentId: entry.id, parentToolUseId: entry.parentToolUseId || entry.id }
  // Child item ids are namespaced: they must never meet the parent's or
  // another child's row (tools, messages).
  const scoped = (value) => (value ? `${entry.id}:${value}` : '')
  if (method === 'turn/completed') {
    const turn = obj(p.turn)
    const status = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'stopped' : 'failed'
    state.subagents.upsert(entry.id, entry.groupId, { state: status, durationMs: turn.durationMs }, out)
  } else if (method === 'thread/tokenUsage/updated') {
    state.subagents.upsert(entry.id, entry.groupId, { tokens: subagentTokens(p.tokenUsage?.total) }, out)
  } else if (method === 'thread/settings/updated') {
    const settings = obj(p.threadSettings || p.settings)
    state.subagents.upsert(entry.id, entry.groupId, { model: settings.model }, out)
    // Manual: a child thread must keep the parent's posture too.
    if (state.postureCheck) {
      const problem = manualPostureProblem(settings)
      if (problem) out.push({ type: 'postureMismatch', reason: `sub-agent thread: ${problem}` })
    }
  } else if (method === 'item/agentMessage/delta' && typeof p.delta === 'string' && p.delta) {
    out.push({ type: 'textDelta', messageId: scoped(str(p.itemId)) || null, index: 0, text: p.delta, ...provenance })
  } else if (method === 'item/started' || method === 'item/completed') {
    const item = obj(p.item), id = scoped(str(item.id)), completed = method === 'item/completed'
    if (completed && item.type === 'agentMessage') {
      if (item.text) out.push({ type: 'assistant', messageId: id, blocks: [{ type: 'text', text: str(item.text) }], ...provenance })
    } else if (completed && item.type === 'reasoning') {
      const parts = (Array.isArray(item.summary) && item.summary.length ? item.summary : Array.isArray(item.content) ? item.content : []).filter(value => typeof value === 'string')
      if (parts.length) out.push({ type: 'assistant', messageId: id, blocks: [{ type: 'thinking', text: parts.join('\n\n') }], ...provenance })
    } else if (id && entry.state === 'working') {
      // Scratch state prevents a child's file metadata affecting parent approvals.
      const use = toolUseOf(item, { fileChanges: new Map() })
      if (use) {
        const previous = entry.tools.get(id)
        if (previous === 'completed' || previous === 'failed') return out
        if (!previous) out.push({ type: 'assistant', messageId: id, blocks: [{ type: 'tool_use', id, name: use.name, input: use.input }], ...provenance })
        const result = completed ? toolResultOf(item) : null
        const status = result ? result.isError ? 'failed' : 'completed' : 'running'
        state.subagents.progress(entry.id, { id, name: use.name, status }, out)
        if (result && previous !== status) out.push({ type: 'toolResult', toolUseId: id, isError: result.isError, text: clipText(result.text), ...provenance })
      }
    }
  }
  return out
}

// An approval request -> the 'permission' event (claudeChat's fields + choices).
// What a request adds beyond its command or changes: each is shown on the card.
function requestExtras(p) {
  const out = {}
  for (const k of ['proposedExecpolicyAmendment', 'additionalPermissions', 'networkApprovalContext']) if (p[k] != null) out[k] = p[k]
  return out
}

export function permissionFromCodexRequest(requestId, method, params, state) {
  const p = obj(params)
  const choices = Array.isArray(p.availableDecisions) && p.availableDecisions.length ? p.availableDecisions : DEFAULT_CHOICES
  const reason = str(p.reason)
  if (method === FILE_APPROVAL) {
    const changes = (state && state.fileChanges.get(p.itemId)) || []
    // A new write root and unknown changes come first (JSON keeps this order);
    // unknown changes wait for "Show all" (shared/chatApproval.js).
    return {
      requestId,
      toolName: 'Edit',
      displayName: 'Edit',
      input: {
        ...(p.grantRoot ? { grantRoot: String(p.grantRoot) } : {}),
        ...(changes.length ? {} : { changesUnknown: true }),
        ...requestExtras(p),
        file_path: changes.length ? changes[0].path : '',
        changes
      },
      description: reason,
      suggestions: [],
      choices,
      toolUseId: typeof p.itemId === 'string' ? p.itemId : null,
      reason
    }
  }
  return {
    requestId,
    toolName: 'Bash',
    displayName: 'Bash',
    input: { ...commandInput(p.command, p.cwd, p.commandActions), ...requestExtras(p) },
    description: reason,
    suggestions: [],
    choices,
    toolUseId: typeof p.itemId === 'string' ? p.itemId : null,
    reason
  }
}

// An MCP server asks (mcpServer/elicitation/request): a card when it only
// needs a yes or no. A form to fill (required fields) or a URL to open is
// declined: Tessel has no way to answer those.
export function elicitationAnswerable(params) {
  const p = obj(params)
  if (p.mode != null && p.mode !== 'form') return false
  const req = obj(p.requestedSchema).required
  return !(Array.isArray(req) && req.length)
}

export function permissionFromElicitation(requestId, params) {
  const p = obj(params)
  const server = str(p.serverName) || 'mcp'
  const message = str(p.message)
  const schema = obj(p.requestedSchema)
  const input = { server, message, ...(Object.keys(schema).length ? { requestedSchema: schema } : {}), ...(p._meta != null ? { meta: p._meta } : {}) }
  return {
    requestId,
    toolName: 'MCP',
    displayName: `MCP ${server}`,
    input,
    description: message,
    suggestions: [],
    choices: ['accept', 'decline'],
    toolUseId: null,
    reason: message
  }
}

// { behavior, session } -> the decision string Codex takes. Deny is 'decline',
// accepted even when availableDecisions leaves it out (spike 0.158).
export function codexDecision({ behavior, session } = {}, choices = DEFAULT_CHOICES) {
  if (behavior === 'deny') return 'decline'
  if (behavior !== 'allow') return null
  if (session && Array.isArray(choices) && choices.includes('acceptForSession')) return 'acceptForSession'
  return 'accept'
}

// ---- the adapter ------------------------------------------------------------------

function checkOptions(opts) {
  if (!opts || typeof opts.exe !== 'string' || !opts.exe) throw new TypeError('codexChat: exe is required')
  if (!opts.env || typeof opts.env !== 'object') throw new TypeError('codexChat: env is required')
  if (opts.exeArgs != null && (!Array.isArray(opts.exeArgs) || !opts.exeArgs.every((a) => typeof a === 'string'))) throw new TypeError('codexChat: exeArgs must be strings')
  if (opts.threadId != null && (typeof opts.threadId !== 'string' || !THREAD_ID.test(opts.threadId))) throw new TypeError('codexChat: bad threadId')
  if (opts.model != null && (typeof opts.model !== 'string' || !NAME.test(opts.model))) throw new TypeError('codexChat: bad model')
  if (opts.effort != null && (typeof opts.effort !== 'string' || !NAME.test(opts.effort))) throw new TypeError('codexChat: bad effort')
  if (opts.permissions != null && !['yolo', 'manual'].includes(opts.permissions)) throw new TypeError('codexChat: bad permissions')
}

export function createCodexChat(opts) {
  checkOptions(opts)
  const {
    exe,
    exeArgs = [],
    cwd,
    env,
    threadId: resumeId = null,
    spawn = nodeSpawn,
    now = Date.now,
    log = null,
    killTree = killCodexTree,
    clientVersion = '0.0.0',
    probeAccount = true
  } = opts
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts || {}) }
  let model = opts.model || null // what we ask for (turn/start); state.model is what Codex reports
  let effort = opts.effort || null
  let permissions = opts.permissions === 'yolo' ? 'yolo' : 'manual'
  const chat = new EventEmitter()
  const state = createCodexState({ threadId: null, model, permissionMode: permissions === 'yolo' ? 'bypassPermissions' : 'default', now })

  let child = null
  let startPromise = null
  let ready = false
  let exited = null
  let finished = false
  let closing = false
  let stderrTail = ''
  let reqN = 0
  let permN = 0
  let idleTimer = null
  const pending = new Map() // our requests: id -> { resolve, timer, method }
  const approvals = new Map() // our permission id -> { rawId, choices, turnId, kind }
  const turnPosture = new Map() // turn id -> 'yolo' | 'manual' when its turn/start was sent
  let postureFailed = false
  const permByRaw = new Map() // JSON of the server's request id -> our permission id

  function logAt(level, msg) {
    if (!log) return
    try {
      if (typeof log === 'function') log(level, `[codexChat] ${msg}`)
      else if (typeof log[level] === 'function') log[level]('chat', `codex: ${msg}`)
    } catch {
      /* logging never breaks the chat */
    }
  }

  function emit(type, payload) {
    try {
      chat.emit(type, payload)
    } catch (err) {
      logAt('error', `listener for ${type} threw: ${err && err.message}`)
    }
  }

  function alive() {
    return !!child && !exited && !finished
  }

  function writeLine(obj_) {
    return new Promise((resolve) => {
      if (!alive() || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return resolve(false)
      try {
        child.stdin.write(JSON.stringify(obj_) + '\n', (err) => resolve(!err))
      } catch {
        resolve(false)
      }
    })
  }

  // A request of ours -> { ok:true, result } | { ok:false, code:'timeout'|'exit'|'error', error, rpcCode? }.
  function request(method, params, ms = timeouts.request) {
    if (!alive()) return Promise.resolve({ ok: false, code: 'exit', error: 'process not running' }) // i18n-ignore internal
    const id = ++reqN
    return new Promise((resolve) => {
      const entry = { method, resolve }
      entry.timer = setTimeout(() => {
        pending.delete(id)
        logAt('warn', `${method} timed out after ${ms} ms`)
        resolve({ ok: false, code: 'timeout', error: `${method} timed out` }) // i18n-ignore internal
      }, ms)
      pending.set(id, entry)
      writeLine({ method, id, params }).then((ok) => {
        if (ok || !pending.has(id)) return
        clearTimeout(entry.timer)
        pending.delete(id)
        resolve({ ok: false, code: 'exit', error: 'stdin closed' }) // i18n-ignore internal
      })
    })
  }

  const notify = (method, params) => writeLine(params === undefined ? { method } : { method, params })
  const respond = (id, result) => writeLine({ id, result })
  const respondError = (id, code, message) => writeLine({ id, error: { code, message } })

  function onResponse(m) {
    const entry = pending.get(m.id)
    if (!entry) return // late (timed out) or not ours
    pending.delete(m.id)
    clearTimeout(entry.timer)
    if (m.error) {
      const e = obj(m.error)
      entry.resolve({ ok: false, code: 'error', error: String(e.message || 'error'), rpcCode: typeof e.code === 'number' ? e.code : null })
    } else entry.resolve({ ok: true, result: m.result ?? null })
  }

  const DECLINE_ELICITATION = { action: 'decline', content: null, _meta: null }

  function addApproval(id, perm, params, kind) {
    approvals.set(perm.requestId, { rawId: id, choices: perm.choices, turnId: str(params.turnId), kind })
    permByRaw.set(JSON.stringify(id), perm.requestId)
    emit('permission', perm)
  }

  function onServerRequest(m) {
    const { id, method } = m
    const params = obj(m.params)
    // Another thread's request (a sub-agent's) is not this chat's to allow.
    const foreign = typeof params.threadId === 'string' && params.threadId !== state.threadId
    switch (method) {
      case COMMAND_APPROVAL:
      case FILE_APPROVAL: {
        if (foreign || approvals.size >= MAX_APPROVALS) {
          logAt('warn', `${method} declined: ${foreign ? 'another thread' : 'too many pending approvals'}`)
          return respond(id, { decision: 'decline' })
        }
        addApproval(id, permissionFromCodexRequest(`codex_perm_${++permN}`, method, params, state), params, 'decision')
        return
      }
      case MCP_ELICITATION: {
        // MCP tools run outside Codex's sandbox: asked like any approval.
        if (foreign || approvals.size >= MAX_APPROVALS || !elicitationAnswerable(params)) {
          logAt('info', `MCP elicitation declined (${foreign ? 'another thread' : approvals.size >= MAX_APPROVALS ? 'too many pending' : 'not a yes/no question'})`)
          return respond(id, DECLINE_ELICITATION)
        }
        addApproval(id, permissionFromElicitation(`codex_perm_${++permN}`, params), params, 'elicitation')
        return
      }
      case 'item/tool/requestUserInput':
        // No question card yet: empty answers (the model goes on without them).
        logAt('info', 'requestUserInput answered with no answers')
        return respond(id, { answers: {} })
      case 'item/permissions/requestApproval':
        return respond(id, { permissions: {}, scope: 'turn', strictAutoReview: true })
      case 'item/tool/call':
        // A client-side tool we never registered: a failed call, not an RPC error.
        return respond(id, { contentItems: [], success: false })
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return respond(id, { decision: 'abort' })
      case 'account/chatgptAuthTokens/refresh':
      case 'attestation/generate':
        return respondError(id, -32001, `Tessel does not support ${method}`) // i18n-ignore sent to Codex
      default:
        logAt('warn', `unsupported server request ${method}`)
        return respondError(id, -32000, `Unsupported request: ${String(method)}`) // i18n-ignore sent to Codex
    }
  }

  const declineAnswer = (p) => (p.kind === 'elicitation' ? DECLINE_ELICITATION : { decision: 'decline' })

  // decline: the server still waits on them (a turn ended): answered no.
  function cancelPermissions(filter = () => true, { decline = false } = {}) {
    for (const [permId, p] of approvals) {
      if (!filter(p)) continue
      approvals.delete(permId)
      permByRaw.delete(JSON.stringify(p.rawId))
      if (decline) respond(p.rawId, declineAnswer(p))
      emit('permissionCancelled', { requestId: permId })
    }
  }

  function clearIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  // thread/status idle comes a moment BEFORE turn/completed, and also while a
  // failing request is retried: an open turn is settled from it only when
  // nothing else ends it within timeouts.idleSettle.
  function armIdleSettle(kind) {
    clearIdleTimer()
    const turn = state.turn
    if (!turn || turn.settled || state.retrying) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (state.turn !== turn || turn.settled || !alive()) return
      logAt('warn', `turn ${turn.id} settled from thread status ${kind} (no turn/completed)`)
      const status = kind === 'systemError' ? 'failed' : state.interruptRequested ? 'interrupted' : 'completed'
      // i18n-ignore internal
      const error = kind === 'systemError' ? { message: 'Codex reported a system error.' } : null
      dispatchEvents(settleTurn(state, status, { error, turnId: turn.id }))
    }, timeouts.idleSettle)
  }

  // A throttled roster snapshot still arrives when its window has passed.
  state.subagents.deliverTo((events) => {
    if (!finished) dispatchEvents(events)
  })

  function dispatchEvents(events) {
    for (const ev of events) {
      const { type, ...payload } = ev
      if (type === 'postureMismatch') {
        postureMismatch(payload.reason)
        continue
      }
      if (type === 'turnEnd') {
        clearIdleTimer()
        // The finished turn's approvals only (answered no).
        const ended = payload.turnId || ''
        cancelPermissions((p) => p.turnId === ended, { decline: true })
      }
      emit(type, payload)
    }
  }

  // Codex reports a posture other than Manual's: the turn stops, the chat closes.
  function postureMismatch(reason) {
    if (postureFailed) return
    postureFailed = true
    logAt('error', `Manual posture not applied by Codex (${reason}): closing`)
    emit('postureError', { reason })
    interrupt().catch(() => {})
    close({ kill: true }).catch(() => {})
  }

  function onNotification(m) {
    const params = obj(m.params)
    if (m.method === 'serverRequest/resolved') {
      const permId = permByRaw.get(JSON.stringify(params.requestId))
      if (permId) cancelPermissions((p) => JSON.stringify(p.rawId) === JSON.stringify(params.requestId))
      return
    }
    if (m.method === 'thread/status/changed' && (!params.threadId || params.threadId === state.threadId)) {
      const t = obj(params.status).type
      if (t === 'idle' || t === 'systemError') armIdleSettle(t)
      else if (t === 'active') clearIdleTimer()
    }
    dispatchEvents(normalizeCodexNotification(m.method, params, state))
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object') return
    const hasId = Object.prototype.hasOwnProperty.call(m, 'id') && m.id !== null
    if (typeof m.method === 'string') {
      if (hasId) return onServerRequest(m)
      return onNotification(m)
    }
    if (hasId) return onResponse(m)
  }

  // Lines of JSON. Only the new text is searched for a line end; a line over
  // MAX_LINE is dropped along with the rest of it, up to its line end.
  function attachStdout(stream) {
    let buf = ''
    let discarding = false
    stream.setEncoding('utf8')
    stream.on('data', (d) => {
      if (discarding) {
        const j = d.indexOf('\n')
        if (j < 0) return
        d = d.slice(j + 1)
        discarding = false
      }
      let scan = buf.length // the kept text has no line end
      buf += d
      let from = 0
      let i
      while ((i = buf.indexOf('\n', scan)) >= 0) {
        let line = buf.slice(from, i)
        from = scan = i + 1
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line.trim()) continue
        let m
        try {
          m = JSON.parse(line)
        } catch {
          logAt('warn', `malformed stdout line ignored: ${line.slice(0, 120)}`)
          continue
        }
        try {
          onMessage(m)
        } catch (err) {
          logAt('error', `frame handling failed: ${err && err.message}`)
        }
      }
      if (from) buf = buf.slice(from)
      if (buf.length > MAX_LINE) {
        logAt('warn', `stdout line over ${MAX_LINE} characters dropped`)
        buf = ''
        discarding = true
      }
    })
    stream.on('error', () => {})
  }

  function attachStderr(stream) {
    stream.setEncoding('utf8')
    stream.on('data', (d) => {
      // Codex logs with ANSI colours: stripped for the tail and the log.
      const text = String(d).replace(ANSI, '')
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL)
      emit('stderr', { text: text.slice(-4096) })
    })
    stream.on('error', () => {})
  }

  function finish(code, signal, error) {
    if (finished) return
    finished = true
    exited = exited || { code, signal }
    clearIdleTimer()
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, code: 'exit', error: 'process exited' }) // i18n-ignore internal
    }
    pending.clear()
    cancelPermissions()
    const subagentEvents = []
    state.subagents.deliverTo(null)
    state.subagents.settle(null, closing ? 'interrupted' : 'failed', subagentEvents)
    dispatchEvents(subagentEvents)
    const normal = closing || code === 0
    logAt(normal ? 'info' : 'warn', `exited code=${code} signal=${signal}${error ? ' error=' + error : ''}`)
    emit('exit', { code, signal, stderrTail, crashed: !normal, error: error || null })
  }

  // Signed out, as far as Codex tells (guess, not recorded: account/read
  // answering no account while OpenAI auth is required).
  async function accountProblem() {
    if (!probeAccount) return { signin: false, auth: null }
    const r = await request('account/read', {}, timeouts.accountProbe)
    if (!r.ok) {
      logAt('info', `account/read unavailable: ${r.error}`)
      return { signin: false, auth: null }
    }
    const res = obj(r.result)
    const account = res.account && typeof res.account === 'object' ? res.account : null
    // Never the email: only how Codex is signed in.
    const auth = account ? { type: str(account.type) || null, planType: typeof account.planType === 'string' ? account.planType : null } : null
    return { signin: !account && res.requiresOpenaiAuth === true, auth }
  }

  async function openThread() {
    const policy = threadPolicy(codexPolicy(permissions))
    const withModel = model ? { model } : {}
    const startThread = () => request('thread/start', { cwd, ...policy, ...withModel }, timeouts.start)
    if (!resumeId) return { r: await startThread() }
    const base = { threadId: resumeId, cwd, ...policy, ...withModel }
    let r = await request('thread/resume', { ...base, excludeTurns: true }, timeouts.start)
    // Older servers refuse the field: once more without it.
    if (!r.ok && r.rpcCode === -32602) r = await request('thread/resume', base, timeouts.start)
    // A thread created but never given a message has no rollout: nothing to
    // lose, a new thread takes its place (reported as supersededThreadId).
    if (!r.ok && r.code === 'error' && /no rollout found/i.test(r.error)) {
      logAt('info', `no rollout for ${resumeId}: new thread`)
      return { r: await startThread(), superseded: resumeId }
    }
    return { r }
  }

  function failCode(r, text) {
    if (isCodexAuthText(text)) return 'signin'
    return r.code === 'timeout' ? 'timeout' : r.code === 'exit' ? 'exit' : 'failed'
  }

  // -> { ok:true, pid, info } | { ok:false, code:'spawn'|'exit'|'timeout'|'signin'|'failed', error }
  function start() {
    if (startPromise) return startPromise
    startPromise = (async () => {
      const t0 = now()
      const args = buildCodexArgs({ exeArgs })
      let spawnError = null
      try {
        child = spawn(exe, args, { cwd, env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true })
      } catch (err) {
        finished = true
        return { ok: false, code: 'spawn', error: String((err && err.message) || err) }
      }
      logAt('info', `spawned pid=${child.pid} permissions=${permissions} ${resumeId ? 'resume' : 'new'}`)
      const spawnFailed = new Promise((resolve) => {
        child.on('error', (err) => {
          logAt('warn', `child error: ${err && err.message}`)
          if (spawnError) return
          spawnError = String((err && err.message) || err)
          if (!child.pid) finish(null, null, spawnError)
          resolve()
        })
      })
      child.once('exit', (code, signal) => {
        exited = { code, signal }
        setTimeout(() => finish(code, signal), timeouts.exitFlush)
      })
      child.once('close', (code, signal) => finish(exited ? exited.code : code, exited ? exited.signal : signal))
      if (child.stdin) child.stdin.on('error', () => {})
      if (child.stdout) attachStdout(child.stdout)
      if (child.stderr) attachStderr(child.stderr)

      const exitWait = new Promise((resolve) => (finished ? resolve() : chat.once('exit', resolve)))
      const init = request(
        'initialize',
        { clientInfo: { name: 'tessel', title: 'Tessel', version: String(clientVersion) }, capabilities: { experimentalApi: true } },
        timeouts.start
      )
      let first = await Promise.race([init.then((r) => ({ kind: 'init', r })), exitWait.then(() => ({ kind: 'exit' })), spawnFailed.then(() => ({ kind: 'spawn' }))])
      if (first.kind === 'spawn' && child.pid) first = await Promise.race([init.then((r) => ({ kind: 'init', r })), exitWait.then(() => ({ kind: 'exit' }))])
      if (spawnError && !child.pid) return { ok: false, code: 'spawn', error: spawnError }

      const fail = async (r, what) => {
        if (r.code !== 'exit') await close()
        const tail = stderrTail.trim().slice(-2000)
        const answer = r.code === 'error' ? r.error : ''
        const code = failCode(r, `${answer}\n${tail}`)
        if (code === 'signin') emit('authError', { message: (answer || tail).slice(-500) })
        return { ok: false, code, error: answer ? `${what}: ${answer}` : tail || String(r.error || code) }
      }

      const ir = first.kind === 'init' ? first.r : { ok: false, code: 'exit' }
      if (!ir.ok) return fail(ir, 'initialize')
      const initRes = obj(ir.result)
      await notify('initialized')

      const acct = await accountProblem()
      if (acct.signin) {
        emit('authError', { message: 'no account' })
        await close()
        return { ok: false, code: 'signin', error: 'Codex is not signed in' } // i18n-ignore code 'signin' is what the caller shows
      }

      const { r: tr, superseded } = await openThread()
      if (!tr.ok) return fail(tr, resumeId ? 'thread/resume' : 'thread/start')
      const res = obj(tr.result)
      const thread = obj(res.thread)
      const threadId = str(thread.id)
      if (!threadId) {
        await close()
        return { ok: false, code: 'failed', error: 'codex app-server did not name its thread' } // i18n-ignore internal
      }
      if (resumeId && !superseded && threadId !== resumeId) {
        // A different id is a fork, not this conversation.
        await close()
        return { ok: false, code: 'failed', error: `codex app-server resumed ${threadId} instead of ${resumeId}` } // i18n-ignore internal
      }
      if (permissions === 'manual') {
        // What Codex applied, not what was asked: unverified is refused.
        const problem = manualPostureProblem(res, { strict: true })
        if (problem) {
          logAt('error', `Manual posture not applied by Codex at start (${problem})`)
          await close()
          return { ok: false, code: 'posture', error: `Codex did not apply the Manual permissions: ${problem}` } // i18n-ignore code 'posture' is what the caller shows
        }
        state.postureCheck = true
      }
      state.threadId = threadId
      if (typeof res.model === 'string' && res.model) state.model = res.model
      if (typeof thread.cliVersion === 'string') state.cliVersion = thread.cliVersion
      ready = true
      return {
        ok: true,
        pid: child.pid,
        info: {
          startMs: now() - t0,
          threadId,
          ...(superseded ? { supersededThreadId: superseded } : {}),
          resumed: !!resumeId && !superseded,
          model: state.model,
          modelProvider: typeof res.modelProvider === 'string' ? res.modelProvider : null,
          reasoningEffort: typeof res.reasoningEffort === 'string' ? res.reasoningEffort : null,
          serviceTier: typeof res.serviceTier === 'string' ? res.serviceTier : null,
          approvalPolicy: res.approvalPolicy ?? null,
          sandbox: sandboxKind(res.sandbox != null ? res.sandbox : res.sandboxPolicy),
          cliVersion: state.cliVersion,
          rolloutPath: typeof thread.path === 'string' ? thread.path : null,
          historyMode: typeof thread.historyMode === 'string' ? thread.historyMode : null,
          codexHome: typeof initRes.codexHome === 'string' ? initRes.codexHome : null,
          userAgent: typeof initRes.userAgent === 'string' ? initRes.userAgent : null,
          platformOs: typeof initRes.platformOs === 'string' ? initRes.platformOs : null,
          auth: acct.auth
        }
      }
    })()
    return startPromise
  }

  function turnParams(id, input) {
    return {
      threadId: state.threadId,
      clientUserMessageId: id,
      input,
      ...turnPolicy(codexPolicy(permissions)),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {})
    }
  }

  function queued(id) {
    if (!state.accepted.has(id)) emit('queued', { uuid: id })
  }

  // A user message. Resolves once Codex has taken it (turn/start or
  // turn/steer answered); delivery shows as 'accepted' for this uuid.
  async function send({ uuid, text } = {}) {
    if (!ready || !alive() || postureFailed) return { ok: false, error: 'not running' } // i18n-ignore internal
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty' }
    const id = typeof uuid === 'string' && uuid ? uuid : randomUUID()
    state.sent.add(id) // before the write: the echo can beat the answer
    const input = [{ type: 'text', text, text_elements: [] }]
    const open = state.turn && !state.turn.settled && state.turn.id ? state.turn : null
    // A turn started under another posture is not joined: a new turn/start
    // carries the current one.
    if (open && turnPosture.get(open.id) !== permissions) logAt('info', `turn ${open.id} started under another posture: new turn`)
    else if (open) {
      // Mid-turn (the manager normally waits): joins the running turn.
      const r = await request('turn/steer', { threadId: state.threadId, expectedTurnId: open.id, clientUserMessageId: id, input })
      if (r.ok) {
        queued(id)
        return { ok: true, uuid: id, steered: true }
      }
      if (r.code !== 'error') {
        state.sent.delete(id)
        return { ok: false, error: r.error }
      }
      logAt('info', `turn/steer refused (${r.error}): new turn`)
    }
    const posture = permissions
    if (posture === 'manual') state.postureCheck = true
    const r = await request('turn/start', turnParams(id, input))
    if (!r.ok) {
      state.sent.delete(id)
      if (isCodexAuthText(r.error)) emit('authError', { message: r.error.slice(-500) })
      return { ok: false, error: r.error }
    }
    const turnId = str(obj(obj(r.result).turn).id)
    if (turnId && !turnPosture.has(turnId)) {
      turnPosture.set(turnId, posture)
      if (turnPosture.size > SETTLED_KEEP) turnPosture.delete(turnPosture.keys().next().value)
    }
    // The answer can come before turn/started: the turn is known from here.
    if (turnId && !state.settledTurns.has(turnId) && (!state.turn || state.turn.settled || state.turn.id !== turnId)) newTurn(state, turnId)
    queued(id)
    return { ok: true, uuid: id }
  }

  async function interrupt() {
    if (!alive()) return { ok: false, error: 'not running' } // i18n-ignore internal
    const turn = state.turn && !state.turn.settled && state.turn.id ? state.turn : null
    if (!turn) return { ok: true, stillQueued: [] }
    state.interruptRequested = true
    const r = await request('turn/interrupt', { threadId: state.threadId, turnId: turn.id })
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, stillQueued: [] }
  }

  // decision: { behavior:'allow'|'deny', session:boolean, message? }. Codex
  // takes no message with a decline.
  async function answerPermission(requestId, decision = {}) {
    const p = approvals.get(requestId)
    if (!p) return { ok: false, error: 'unknown or answered request' } // i18n-ignore internal
    const value = codexDecision(decision, p.choices)
    if (!value) return { ok: false, error: 'bad decision' } // i18n-ignore internal
    // Forget first: a second answer finds nothing rather than replying twice.
    approvals.delete(requestId)
    permByRaw.delete(JSON.stringify(p.rawId))
    if (p.kind === 'elicitation') {
      const action = value === 'decline' ? 'decline' : 'accept'
      const sent = await respond(p.rawId, action === 'accept' ? { action, content: {}, _meta: null } : DECLINE_ELICITATION)
      return sent ? { ok: true, decision: action } : { ok: false, error: 'stdin closed' } // i18n-ignore internal
    }
    const ok = await respond(p.rawId, { decision: value })
    return ok ? { ok: true, decision: value } : { ok: false, error: 'stdin closed' } // i18n-ignore internal
  }

  // Applied with the next turn/start (Codex keeps them for later turns too).
  function setModel(name) {
    if (typeof name !== 'string' || !NAME.test(name)) return Promise.resolve({ ok: false, error: 'bad model' })
    model = name
    state.model = name
    return Promise.resolve({ ok: true })
  }

  function setEffort(level) {
    if (typeof level !== 'string' || !NAME.test(level)) return Promise.resolve({ ok: false, error: 'bad effort' })
    effort = level
    return Promise.resolve({ ok: true })
  }

  // claudeChat's modes: bypassPermissions = yolo, anything else = manual.
  // Applied with the next turn/start; a turn running without prompts is
  // interrupted when Manual is chosen.
  async function setPermissionMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) return { ok: false, error: 'bad mode' }
    const before = permissions
    permissions = mode === 'bypassPermissions' ? 'yolo' : 'manual'
    state.permissionMode = permissions === 'yolo' ? 'bypassPermissions' : 'default'
    // Checked again from the next turn/start sent under Manual.
    if (before !== permissions) state.postureCheck = false
    const open = state.turn && !state.turn.settled && state.turn.id ? state.turn : null
    if (permissions === 'manual' && open && turnPosture.get(open.id) !== 'manual' && alive()) {
      const r = await interrupt()
      return { ok: true, response: { mode: state.permissionMode }, interrupted: !!r.ok }
    }
    return { ok: true, response: { mode: state.permissionMode } }
  }

  async function killNow() {
    try {
      await killTree(child)
    } catch (err) {
      logAt('error', `tree kill failed: ${err && err.message}`)
      try {
        child.kill()
      } catch {
        /* gone */
      }
    }
  }

  // End stdin (app-server exits by itself), else kill the tree after
  // timeouts.close. kill (Tessel quits): the tree is killed at once and the
  // wait for its exit is bounded (timeouts.quitKill) so quitting never hangs.
  async function close({ kill = false } = {}) {
    closing = true
    if (!child || finished) return { ok: true }
    const done = new Promise((resolve) => (finished ? resolve() : chat.once('exit', resolve)))
    if (kill) {
      logAt('info', 'killing the tree')
      await killNow()
      let t
      await Promise.race([done, new Promise((r) => (t = setTimeout(r, timeouts.quitKill)))])
      clearTimeout(t)
      return { ok: true, killed: true }
    }
    try {
      if (child.stdin && !child.stdin.writableEnded) child.stdin.end()
    } catch {
      /* already closed */
    }
    let timer
    const timedOut = await Promise.race([done.then(() => false), new Promise((r) => (timer = setTimeout(() => r(true), timeouts.close)))])
    clearTimeout(timer)
    if (timedOut) {
      logAt('warn', `no exit ${timeouts.close} ms after stdin end, killing the tree`)
      await killNow()
      await done
    }
    return { ok: true, killed: timedOut }
  }

  Object.assign(chat, {
    start,
    send,
    interrupt,
    answerPermission,
    setModel,
    setEffort,
    setPermissionMode,
    close,
    pendingPermissions: () => [...approvals.keys()]
  })
  Object.defineProperties(chat, {
    pid: { get: () => (child ? child.pid : null) },
    sessionId: { get: () => state.threadId },
    threadId: { get: () => state.threadId },
    permissions: { get: () => permissions },
    running: { get: () => alive() }
  })
  return chat
}
