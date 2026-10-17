// Agents moving panes to another sign-in account: the main process's side of
// the account tools of teamMcp/server.cjs (account_list, account_switch_panes).
// What the user does with Switch panes… (Settings > AI provider accounts >
// Where you're signed in) and Restart on <account> (a pane's menu), asked
// for by an agent: the window finds the sign-ins and the panes on each, and
// checks a switch the way its own Switch panes does (the renderer's
// agentAccounts.js, on signedInPlaces.js); the user allows it on one card in
// the window; the window restarts the panes with the pane menu's own path.
//
// Who may do what (each request, in this order):
// - The request comes over the tessel command's pipe (cliServer.js: this
//   Windows user only, the per-install token) and is signed with the sending
//   pane's own team secret (teamAuth.js, team key "accounts"): an agent can
//   never act as another pane.
// - "Let agents move panes to another account" (Settings > Agents), an agent
//   on an SSH host limited to its host and project, one request at a time,
//   the wait after a Refuse: the window (it knows each pane).
// - account_list is read-only: emails, organizations, plans, sign-ins and
//   panes. Only the fields named here are passed on to the agent, whatever
//   the window sends: never a token, never a credential file or its folder.
// - account_switch_panes: the window checks every pane first (an agent pane
//   of the sign-in's agent, on the sign-in's machine, the account not known
//   to have lost its subscription); a request it refuses is never shown.
//   Then one card in the window, Allow or Refuse, 2 minutes. Nothing in the
//   request can answer it: only the card's buttons (the window restarts
//   nothing it did not see allowed there).
// - One log line for each request and each decision: pane and sign-in ids
//   (never made from an email), counts and codes; never an email or a token.
import { CliError } from './cliServer'
import { cleanSubscription, subscriptionState } from '../shared/claudeSubscription'

export const ACCOUNT_OPS = ['list', 'switch']
export const MAX_PANES = 20
export const MAX_EXPLANATION = 300
// The user has at most this long to answer the card (the window closes it
// then; sooner for an agent whose own client gives up first).
export const APPROVAL_TIMEOUT_MS = 2 * 60 * 1000
// ...and main waits a little longer, in case the window never answers.
export const APPROVAL_MARGIN_MS = 20 * 1000
// Each pane's restart: its terminal stopped (up to 10 s) and started again.
export const RESTART_MS_PER_PANE = 45 * 1000

const fail = (code, message) => new CliError(code, message)
// One line of the window's text: no control characters, no invisible
// formatting ones (bidi marks, zero-width), bounded.
const line = (v, max) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '')
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
function cleanSignIn(s) {
  if (!s || typeof s !== 'object' || !PLACE_KINDS.includes(s.kind)) return null
  const id = line(s.id, 200)
  if (!id) return null
  return {
    id,
    kind: s.kind,
    place: line(s.place, 120),
    scope: SCOPES.includes(s.scope) ? s.scope : null,
    org: line(s.org, 120),
    plan: line(s.plan, 40),
    sub: cleanSubscription(s.sub),
    signedIn: s.signedIn === true,
    switchable: s.switchable === true,
    panes: (Array.isArray(s.panes) ? s.panes : []).slice(0, 100).map(cleanPane).filter(Boolean)
  }
}
function cleanAccount(a) {
  if (!a || typeof a !== 'object' || typeof a.agent !== 'string' || !AGENTS.test(a.agent)) return null
  return {
    agent: a.agent,
    agentName: line(a.agentName, 40) || a.agent,
    email: line(a.email, 254),
    login: line(a.login, 39),
    unknown: a.unknown === true,
    signIns: (Array.isArray(a.signIns) ? a.signIns : []).slice(0, 30).map(cleanSignIn).filter(Boolean)
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
// Its plan and subscription status: Tessel's own check (a Claude sign-in),
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
function signInLine(s, agent, now) {
  const what = []
  if (s.kind !== 'pc') what.push(s.kind === 'ssh' ? 'SSH' : 'WSL')
  const scope = s.scope === 'tessel' && s.kind !== 'pc' ? 'account folder made by Tessel' : SCOPE_TEXT[s.scope]
  if (scope) what.push(scope)
  if (s.org) what.push(`organization ${s.org}`)
  if (!s.signedIn) what.push('signed out')
  if (s.signedIn && !s.switchable) what.push('panes cannot move to it')
  return `sign-in ${s.id}: ${s.kind === 'pc' ? 'this PC' : s.place || '?'} (${what.join(', ')}) — ${planText(agent, s.plan, s.sub, now)}`
}
const paneWhere = (p) => (p.host ? `SSH ${p.host}` : 'this PC')
function paneText(p) {
  return `"${p.name}" (id ${p.id})${p.project ? ` in project "${p.project}"` : ''}, ${p.agent ? `${p.agent}, ` : ''}${paneWhere(p)}`
}
function accountName(a) {
  return (a && (a.email || (a.login ? `@${a.login}` : ''))) || 'an account with no name yet'
}

export function listText(answer, now = Date.now()) {
  const accounts = (answer && Array.isArray(answer.accounts) ? answer.accounts : []).slice(0, 60).map(cleanAccount).filter((a) => a && a.signIns.length)
  const waiting = (answer && Array.isArray(answer.waiting) ? answer.waiting : [])
    .slice(0, 30)
    .map((w) => (w && typeof w === 'object' ? `${line(w.name, 120) || '?'} (${w.kind === 'wsl' ? 'WSL' : 'SSH'}, ${line(w.state, 40) || 'not read yet'})` : ''))
    .filter(Boolean)
  const scope = answer && answer.scope && typeof answer.scope === 'object' ? answer.scope : null
  const scopeText = scope ? ` You run on the SSH host ${line(scope.host, 120) || '?'}: you see its sign-ins and the panes of your project "${line(scope.project, 100)}" there, and may move only those.` : ''
  if (!accounts.length) return `Tessel knows no agent sign-in yet${scope ? ' on your host' : ''} (Settings > AI provider accounts).${waiting.length ? ` Not read yet: ${waiting.join('; ')}.` : ''}${scopeText}`
  const out = [`Sign-ins of the agents that Tessel knows, by account (as Settings > AI provider accounts > Where you're signed in shows them; no tokens).${scopeText}`]
  let agent = null
  for (const a of accounts) {
    if (a.agentName !== agent) {
      agent = a.agentName
      out.push('', agent)
    }
    out.push(`- ${accountName(a)}`)
    for (const s of a.signIns) {
      out.push(`  - ${signInLine(s, a.agent, now)}`)
      out.push(s.panes.length ? `    Panes (${s.panes.length}): ${s.panes.map(paneText).join('; ')}` : '    Panes: none')
    }
  }
  if (waiting.length) out.push('', `Not read yet (their sign-ins are not shown): ${waiting.join('; ')}.`)
  out.push(
    '',
    'To move panes to another account: account_switch_panes with the panes (names or ids) and the sign-in id (an email works when that account has a single sign-in a pane can use on the pane\'s machine). Panes move only to a sign-in of their own agent on their own machine; the user allows each switch in Tessel\'s window.'
  )
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
  // Ids only in the log: a pane id, a sign-in id (where it is and which
  // one, never made from an email).
  const logId = (v) => line(String(v == null ? '' : v), 80).replace(/[^\w.:-]/g, '?')
  const cancelled = () => fail('cancelled', 'The request was cancelled.')

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
    if (!account) throw fail('invalid_argument', 'Give "account": the id of the sign-in to move them to (see account_list).')
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
    const signIns = (Array.isArray(plan.signIns) ? plan.signIns : []).map(logId).filter(Boolean)
    // Its tool call went away while the window checked it: no card for a
    // call nobody waits on.
    if (signal && signal.aborted) {
      info(`${tag}: cancelled before asking the user`)
      throw cancelled()
    }
    info(`${tag}: asking the user: ${plan.panes.length} pane(s) [${plan.panes.map((p) => logId(p && p.id)).join(', ')}] -> sign-in ${signIns.join(', ') || '?'}`)
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
    // Its tool call went away while the card was up (the window dropped
    // it): nothing is restarted, and it was not the user's answer.
    if (signal && signal.aborted) {
      info(`${tag}: cancelled while the user was asked (nothing restarted)`)
      throw cancelled()
    }
    const name = accountName(plan.account && typeof plan.account === 'object' ? { email: line(plan.account.email, 254), login: line(plan.account.login, 39) } : null)
    if (!answer || answer.allow !== true) {
      if (answer && answer.timedOut === true) {
        const secs = Math.round((Number(answer.ms) || APPROVAL_TIMEOUT_MS) / 1000)
        info(`${tag}: no answer in time (nothing restarted)`)
        throw fail('approval_timeout', `No answer from the user in ${secs >= 120 ? '2 minutes' : `${secs} s`}: nothing was restarted. Wait before asking again, and only if they want it.`)
      }
      if (answer && answer.blocked === true) {
        info(`${tag}: refused by the user, who asked not to be asked again by this agent`)
        throw fail('denied', `The user refused moving these panes to ${name} and asked not to get account switch requests from you again: do not ask again.`)
      }
      info(`${tag}: refused by the user (nothing restarted)`)
      throw fail('denied', `The user refused moving these panes to ${name}: nothing was restarted. Do not ask again unless they ask you to.`)
    }
    info(`${tag}: allowed by the user`)
    const r = await ask('accountTarget', { agent: pane, op: 'switch', token: plan.token }, { timeoutMs: RESTART_MS_PER_PANE * plan.panes.length + 30000 })
    const results = r && Array.isArray(r.results) ? r.results.filter((x) => x && typeof x === 'object').slice(0, MAX_PANES + 50) : []
    const counts = {}
    for (const x of results) counts[x.status] = (counts[x.status] || 0) + 1
    info(`${tag}: done (${Object.entries(counts).map(([k, n]) => `${logId(k)} ${n}`).join(', ') || 'nothing'})`)
    const resumes = plan.account && plan.account.agent === 'claude'
    const lines = [`The user allowed it. Panes moved to ${name}:`, ...results.map((x) => resultText(x, name, resumes))]
    return { text: lines.join('\n') }
  }

  // params: { pane, op, args, auth } (checked by cliServer.js) -> { text }
  // opts.signal: aborted when the agent's tool call went away (its pipe
  // closed): the request ends, the window drops its card unanswered.
  async function handle(params, opts = {}) {
    const signal = opts && opts.signal
    if (!signal) return handleNow(params)
    if (signal.aborted) throw cancelled()
    let onAbort
    const aborted = new Promise((_resolve, reject) => {
      onAbort = () => {
        const pane = params && params.pane
        if (typeof pane === 'string') ask('accountTarget', { agent: pane, op: 'abort' }).catch(() => {})
        info(`request by ${logId(pane)} cancelled by the agent`)
        reject(cancelled())
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    aborted.catch(() => {})
    const running = handleNow(params, signal)
    running.catch(() => {})
    try {
      return await Promise.race([running, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
      // The pipe keeps this pane's place until the request is really over
      // (cliServer.js waits for the handler): not before it settles.
      await running.catch(() => {})
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
