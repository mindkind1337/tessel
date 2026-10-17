// Agents moving panes to another sign-in account: the main process's side of
// the account tools of teamMcp/server.cjs (account_list, account_switch_panes).
// What the user does with Switch panes… (Settings > AI provider accounts >
// Where you're signed in) and Restart on <account> (a pane's menu), asked
// for by an agent: the window finds the accounts and the panes on each, and
// checks a switch the way its own Switch panes does (the renderer's
// agentAccounts.js, on signedInPlaces.js); the user allows it on one card in
// the window; the window restarts the panes with the pane menu's own path.
//
// Who may do what (each request, in this order):
// - The request comes over the tessel command's pipe (cliServer.js: this
//   Windows user only, the per-install token) and is signed with the sending
//   pane's own team secret (teamAuth.js, team key "accounts"): an agent can
//   never act as another pane.
// - account_list is read-only: emails, plans, places and panes. Only the
//   fields named here are passed on to the agent, whatever the window sends:
//   never a token, never a credential file or its folder.
// - account_switch_panes: the window checks every pane first (an agent pane
//   of the account's agent, on a machine where that account is signed in,
//   the account not known to have lost its subscription); a request it
//   refuses is never shown. Then one card in the window, Allow or Refuse,
//   2 minutes. Nothing in the request can answer it: only the card's buttons
//   (the window restarts nothing it did not see allowed there).
// - One log line for each request and each decision: pane and account ids,
//   counts and codes; never an email or a token.
import { CliError } from './cliServer'
import { cleanSubscription, subscriptionState } from '../shared/claudeSubscription'

export const ACCOUNT_OPS = ['list', 'switch']
export const MAX_PANES = 20
// The user has this long to answer the card (the window closes it then).
export const APPROVAL_TIMEOUT_MS = 2 * 60 * 1000
// ...and main waits a little longer, in case the window never answers.
export const APPROVAL_MARGIN_MS = 20 * 1000
// Each pane's restart: its terminal stopped (up to 10 s) and started again.
export const RESTART_MS_PER_PANE = 45 * 1000
const MAX_EXPLANATION = 300

const fail = (code, message) => new CliError(code, message)
// One line of the window's text: no control characters, bounded.
// eslint-disable-next-line no-control-regex
const line = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '')
const AGENTS = /^[a-z][a-z0-9-]{0,19}$/
const PLACE_KINDS = ['pc', 'ssh', 'wsl']
const SCOPES = ['system', 'tessel', 'default', 'env', 'orphan']
const STATES = ['working', 'approval', 'waiting', 'monitoring', 'limited']

// --- The window's answers, field by field (anything else is dropped) -----------------
function cleanPane(p) {
  if (!p || typeof p !== 'object') return null
  const id = line(p.id, 100)
  if (!id) return null
  return {
    id,
    name: line(p.name, 80) || id,
    project: line(p.project, 100),
    agent: line(p.agent, 40),
    // null: this computer.
    host: line(p.host, 120) || null,
    state: STATES.includes(p.state) ? p.state : null,
    self: p.self === true
  }
}
function cleanPlace(p) {
  if (!p || typeof p !== 'object' || !PLACE_KINDS.includes(p.kind)) return null
  return {
    kind: p.kind,
    name: line(p.name, 120),
    scope: SCOPES.includes(p.scope) ? p.scope : null,
    signedIn: p.signedIn === true,
    switchable: p.switchable === true,
    sub: cleanSubscription(p.sub)
  }
}
function cleanAccount(a) {
  if (!a || typeof a !== 'object' || typeof a.agent !== 'string' || !AGENTS.test(a.agent)) return null
  const id = line(a.id, 120)
  if (!id) return null
  return {
    id,
    agent: a.agent,
    agentName: line(a.agentName, 40) || a.agent,
    email: line(a.email, 254),
    login: line(a.login, 39),
    unknown: a.unknown === true,
    plan: line(a.plan, 40),
    sub: cleanSubscription(a.sub),
    places: (Array.isArray(a.places) ? a.places : []).slice(0, 30).map(cleanPlace).filter(Boolean),
    panes: (Array.isArray(a.panes) ? a.panes : []).slice(0, 100).map(cleanPane).filter(Boolean)
  }
}

// --- Words for the agent -------------------------------------------------------------
function ago(ms) {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}
// Its plan and subscription status: Tessel's own check (a Claude account),
// else what its login file says.
export function planText(agent, plan, sub, now = Date.now()) {
  const s = agent === 'claude' ? subscriptionState(sub, now) : null
  if (s) {
    const parts = [s.plan || plan || 'plan not known']
    if (s.warn === 'none') parts.push('no subscription')
    else if (s.warn === 'canceled') parts.push('subscription canceled')
    else if (s.warn === 'payment') parts.push('payment issue')
    else parts.push('active')
    if (s.trialEndsAt) parts.push(`trial until ${new Date(s.trialEndsAt).toISOString().slice(0, 10)}`)
    if (s.checkedAt) parts.push(`checked ${ago(now - s.checkedAt)}`)
    return parts.join(', ')
  }
  return plan ? `${plan} (as its login file says; not checked)` : 'plan not known'
}
const SCOPE_TEXT = { system: 'its own sign-in', tessel: 'added in Tessel', default: 'its own sign-in', env: 'the login shell\'s folder', orphan: 'a left-over folder' }
function placeText(p, agent, now) {
  const what = []
  if (p.kind !== 'pc') what.push(p.kind === 'ssh' ? 'SSH' : 'WSL')
  const scope = p.scope === 'tessel' && p.kind !== 'pc' ? 'account folder made by Tessel' : SCOPE_TEXT[p.scope]
  if (scope) what.push(scope)
  if (!p.signedIn) what.push('signed out')
  const s = agent === 'claude' ? subscriptionState(p.sub, now) : null
  if (s && s.attention) what.push(s.warn === 'payment' ? 'payment issue there' : 'no subscription there')
  if (p.signedIn && !p.switchable) what.push('panes cannot move to it there')
  return `${p.kind === 'pc' ? 'this PC' : p.name || '?'} (${what.join(', ')})`
}
const paneWhere = (p) => (p.host ? `SSH ${p.host}` : 'this PC')
function paneText(p) {
  return `"${p.name}" (id ${p.id})${p.project ? ` in project "${p.project}"` : ''}, ${p.agent ? `${p.agent}, ` : ''}${paneWhere(p)}`
}
function accountName(a) {
  return a.email || (a.login ? `@${a.login}` : '') || 'an unknown account'
}

export function listText(answer, now = Date.now()) {
  const accounts = (answer && Array.isArray(answer.accounts) ? answer.accounts : []).slice(0, 60).map(cleanAccount).filter(Boolean)
  const waiting = (answer && Array.isArray(answer.waiting) ? answer.waiting : [])
    .slice(0, 30)
    .map((w) => (w && typeof w === 'object' ? `${line(w.name, 120) || '?'} (${w.kind === 'wsl' ? 'WSL' : 'SSH'}, ${line(w.state, 40) || 'not read yet'})` : ''))
    .filter(Boolean)
  if (!accounts.length) return `Tessel knows no agent sign-in account yet (Settings > AI provider accounts).${waiting.length ? ` Not read yet: ${waiting.join('; ')}.` : ''}`
  const out = ['Sign-in accounts of the agents that Tessel knows (as Settings > AI provider accounts > Where you\'re signed in shows them; no tokens):']
  let agent = null
  for (const a of accounts) {
    if (a.agentName !== agent) {
      agent = a.agentName
      out.push('', agent)
    }
    out.push(`- id ${a.id}: ${accountName(a)} — ${planText(a.agent, a.plan, a.sub, now)}`)
    if (a.places.length) out.push(`  Signed in on: ${a.places.map((p) => placeText(p, a.agent, now)).join('; ')}`)
    out.push(a.panes.length ? `  Panes (${a.panes.length}): ${a.panes.map(paneText).join('; ')}` : '  Panes: none')
  }
  if (waiting.length) out.push('', `Not read yet (their accounts are not shown): ${waiting.join('; ')}.`)
  out.push('', 'To move panes to another account: account_switch_panes with the panes (names or ids) and the account id. Panes move only to an account of their own agent signed in on their machine; the user allows each switch in Tessel\'s window.')
  return out.join('\n')
}

const STATUS_TEXT = {
  restarted: (a) => `restarted on ${a}`,
  later: (a) => `your own pane: it restarts on ${a} a few seconds after this answer`,
  already: () => 'already on that account (not restarted)',
  failed: () => 'could not be restarted: its terminal did not stop (try again)',
  not_started: () => 'could not start again on that account (Tessel showed the user why)',
  busy: () => 'was already restarting (not restarted again)',
  gone: () => 'is no longer open (not restarted)',
  changed: () => 'changed since the user allowed it (not restarted; ask again)'
}
function resultText(r, account, resumes) {
  const p = cleanPane(r) || { name: '?', project: '' }
  const say = STATUS_TEXT[r.status]
  let text = say ? say(account) : 'not restarted'
  if (r.status === 'restarted') text += resumes ? ', its conversation resumed' : ', in a new conversation (a Codex conversation stays with its account)'
  const why = line(r.reason, 200)
  if (why && r.status !== 'restarted' && r.status !== 'later') text += ` (${why})`
  return `- "${p.name}"${p.project ? ` (${p.project})` : ''}: ${text}`
}

// deps:
//   verify(body, paneId) -> { ok } | { unsigned } | { error }   (teamAuth, team key "accounts")
//   ask(method, params, opts)   the window (cliBridge): 'accountTarget'
//   log                          { info, warn }
//   now
export function createAgentAccounts({ verify, ask, log = null, now = () => Date.now() }) {
  const info = (msg) => log && log.info && log.info('agent-accounts', msg)
  const warn = (msg) => log && log.warn && log.warn('agent-accounts', msg)
  // Ids only in the log: a pane id, an account id (never an email: an
  // account Tessel did not add is named by a hash of its key, see the
  // renderer's agentAccounts.js).
  const logId = (v) => line(String(v == null ? '' : v), 80).replace(/[^\w.:-]/g, '?')

  async function list(pane) {
    info(`account_list by ${logId(pane)}`)
    const r = await ask('accountTarget', { agent: pane, op: 'list' }, { timeoutMs: 60000 })
    return { text: listText(r, now()) }
  }

  function switchArgs(args) {
    const panes = Array.isArray(args.panes) ? [...new Set(args.panes.map((p) => line(p, 120)).filter(Boolean))] : []
    if (!panes.length) throw fail('invalid_argument', 'Give "panes": the names or ids of the panes to move (see account_list).')
    if (panes.length > MAX_PANES) throw fail('too_many', `At most ${MAX_PANES} panes at a time.`)
    const account = line(args.account, 254)
    if (!account) throw fail('invalid_argument', 'Give "account": the id of the account to move them to (see account_list).')
    return { panes, account, explanation: line(args.explanation, MAX_EXPLANATION) }
  }

  async function switchPanes(pane, args, signal = null) {
    const req = switchArgs(args)
    const tag = `account_switch_panes by ${logId(pane)}`
    info(`${tag}: ${req.panes.length} pane(s) asked for`)
    let plan
    try {
      plan = await ask('accountTarget', { agent: pane, op: 'plan', panes: req.panes, account: req.account }, { timeoutMs: 60000 })
    } catch (err) {
      info(`${tag}: refused before asking the user (${logId(err && err.code) || 'failed'})`)
      throw err
    }
    if (!plan || typeof plan.token !== 'string' || !Array.isArray(plan.panes)) throw fail('failed', 'Tessel\'s window did not answer with the switch.')
    const account = cleanAccount(plan.account) || { id: '?', agent: '', email: '', login: '' }
    const ids = plan.panes.map((p) => logId(p && p.id)).join(', ')
    info(`${tag}: asking the user: ${plan.panes.length} pane(s) [${ids}] -> account ${logId(account.id)}`)
    let answer
    try {
      answer = await ask('accountTarget', { agent: pane, op: 'approve', token: plan.token, explanation: req.explanation, timeoutMs: APPROVAL_TIMEOUT_MS }, { timeoutMs: APPROVAL_TIMEOUT_MS + APPROVAL_MARGIN_MS })
    } catch (err) {
      if (err && err.code === 'timeout') {
        info(`${tag}: no answer from the window`)
        throw fail('approval_timeout', 'No answer in time: nothing was restarted.')
      }
      throw err
    }
    const name = accountName(account)
    if (!answer || answer.allow !== true) {
      if (answer && answer.timedOut === true) {
        info(`${tag}: no answer in time (nothing restarted)`)
        throw fail('approval_timeout', 'No answer from the user in 2 minutes: nothing was restarted. Ask them before trying again.')
      }
      info(`${tag}: refused by the user (nothing restarted)`)
      throw fail('denied', `The user refused moving these panes to ${name}: nothing was restarted. Do not ask again unless they ask you to.`)
    }
    // Its tool call went away meanwhile: nothing is restarted.
    if (signal && signal.aborted) throw fail('cancelled', 'The request was cancelled.')
    info(`${tag}: allowed by the user`)
    const r = await ask('accountTarget', { agent: pane, op: 'switch', token: plan.token }, { timeoutMs: RESTART_MS_PER_PANE * plan.panes.length + 30000 })
    const results = r && Array.isArray(r.results) ? r.results.filter((x) => x && typeof x === 'object').slice(0, MAX_PANES + 50) : []
    const counts = {}
    for (const x of results) counts[x.status] = (counts[x.status] || 0) + 1
    info(`${tag}: done (${Object.entries(counts).map(([k, n]) => `${logId(k)} ${n}`).join(', ') || 'nothing'})`)
    const resumes = account.agent === 'claude'
    const lines = [`The user allowed it. Panes moved to ${name}:`, ...results.map((x) => resultText(x, name, resumes))]
    return { text: lines.join('\n') }
  }

  // params: { pane, op, args, auth } (checked by cliServer.js) -> { text }
  // opts.signal: aborted when the agent's tool call went away (its pipe
  // closed): the request ends, the window drops its card unanswered.
  async function handle(params, opts = {}) {
    const signal = opts && opts.signal
    if (!signal) return handleNow(params)
    if (signal.aborted) throw fail('cancelled', 'The request was cancelled.')
    let onAbort
    const aborted = new Promise((_resolve, reject) => {
      onAbort = () => {
        const pane = params && params.pane
        if (typeof pane === 'string') ask('accountTarget', { agent: pane, op: 'abort' }).catch(() => {})
        info(`request by ${logId(pane)} cancelled by the agent`)
        reject(fail('cancelled', 'The request was cancelled.'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    aborted.catch(() => {})
    try {
      return await Promise.race([handleNow(params, signal), aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async function handleNow(params, signal = null) {
    const { pane, op, args = {}, auth } = params || {}
    const v = verify({ op, args, auth }, pane)
    if (!v || v.unsigned) throw fail('unauthorized', 'This request is not signed by a pane Tessel started: restart the agent from Tessel.')
    if (v.error) throw fail(/no team secret/.test(v.error) ? 'unknown_pane' : 'unauthorized', `Refused: ${v.error}.`)
    if (!ACCOUNT_OPS.includes(op)) throw fail('unknown_method', `Unknown account operation: ${String(op).slice(0, 40)}`)
    try {
      if (op === 'list') return await list(pane)
      return await switchPanes(pane, args, signal)
    } catch (err) {
      if (err instanceof CliError) throw err
      warn(`${op} failed: ${err && err.message}`)
      throw fail('failed', `Tessel could not do it: ${String((err && err.message) || err).slice(0, 300)}`)
    }
  }

  return { handle }
}
