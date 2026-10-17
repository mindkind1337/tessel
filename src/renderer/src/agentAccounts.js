// The window's side of the agents' account tools (src/main/agentAccounts.js
// asks it): the sign-in accounts Tessel knows, with the panes on each (what
// Settings > AI provider accounts > Where you're signed in shows), and a
// switch an agent asks for. A switch is checked as Switch panes… checks it
// (signedInPlaces.js: a pane of the account's agent, a sign-in of that
// account at the pane's own place that a pane can start on, never one whose
// own check says no subscription), shown to the user on one card (Allow or
// Refuse), and run with the pane menu's Restart on <account> (App.vue's
// restartOnAccount), only for a switch the user allowed on that card.
//
// The rules:
// - Only an agent pane (a terminal agent or a chat) may ask.
// - Panes of any project may be named: the card names each one.
// - Nothing in the agent's request answers the card: the card's own buttons
//   mark a switch allowed (here, in the window), and a switch not allowed
//   there is never run.
// - The agent's own pane, when it is in the list, restarts last, a moment
//   after its answer is sent (its restart ends its tool call).
//
// The answers go to the agent: English on purpose.
import { groupByProvider, panesUsing, placesToCheck, switchTarget, switchablePanes } from './signedInPlaces'
import { subscriptionState } from '../../shared/claudeSubscription'

export class AgentAccountError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
const refuse = (code, message) => new AgentAccountError(code, message)

export const MAX_PANES = 20
// The card's time (main says it; never more than this, nor less than 10 s).
export const APPROVAL_MS = 2 * 60 * 1000
// A switch asked for and not answered is dropped after this; one allowed
// runs at once (main asks right after the answer).
export const PLAN_TTL_MS = 5 * 60 * 1000
export const ALLOWED_TTL_MS = 60 * 1000
// The asking agent's own pane restarts this long after its answer is sent.
export const SELF_RESTART_MS = 3000

// A short, stable id for an account Tessel did not add (FNV-1a of its key,
// which holds its email: the id and the log never show the email).
export function shortHash(text) {
  let h = 0x811c9dc5
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// An account's id for the agent: the id of the account added in Tessel on
// this PC when it is one (what Settings knows it by), else its agent and a
// hash of its key.
export function accountId(a) {
  const added = ((a && a.chips) || []).find((c) => c.place && c.place.kind === 'pc' && c.entry && c.entry.scope === 'tessel' && typeof c.entry.id === 'string' && /^[\w-]{1,100}$/.test(c.entry.id))
  if (added) return added.entry.id
  return `${a.agent}-${a.unknown ? 'unknown' : shortHash(a.key)}`
}

// A sign-in whose own check says the account has no subscription, or a
// payment issue (no trial running): Switch panes never offers it.
export function needsAttention(entry, now = Date.now()) {
  if (!entry || entry.agent !== 'claude') return false
  const s = subscriptionState(entry.sub, now)
  return !!(s && s.attention)
}

const nameOf = (a) => (a && (a.email || (a.login ? `@${a.login}` : ''))) || 'an unknown account' // i18n-ignore
const where = (pane, hostLabel) => (pane.remoteHostId ? `the SSH host ${hostLabel(pane.remoteHostId)}` : 'this PC') // i18n-ignore
const STATES = ['working', 'approval', 'waiting', 'monitoring', 'limited']

// deps:
//   places() -> Promise<[place]>       main's signedInPlaces (after the live plan check)
//   panes() -> [{ id, kind, name, agentId, remoteHostId, hostAccount, accountId, detected, project }]
//                                      App's accountPanes list (the panes Switch panes knows)
//   findPane(ref) -> { name, kind, notConnected, runs } | null   any pane, by id or name (to say why)
//   requester(paneId) -> { label } | null   an open agent or chat pane
//   agentName(agentId), hostLabel(hostId)
//   paneState(paneId) -> 'working' | 'approval' | ... | null
//   approve(card, agentPane, { ms }) -> Promise<{ allow, timedOut }>   the card
//   dismiss(agentPane)                 its card answered no (its tool call went away)
//   restart(paneId, accountId) -> Promise<'ok' | 'failed' | 'not_started' | 'busy'>
//   switched({ agentLabel, account, count })   a notice for the user
//   later(fn, ms), now(), newToken()
export function createAgentAccountTargets(deps) {
  const now = deps.now || (() => Date.now())
  const later = deps.later || ((fn, ms) => setTimeout(fn, ms))
  const newToken = deps.newToken || (() => globalThis.crypto.randomUUID())
  // token -> { agentPane, accountKey, accountName, items: [{ id, target, desc }], already, card, at, allowed, allowedAt }
  const plans = new Map()

  function sweep() {
    const t = now()
    for (const [k, p] of plans) if (t - p.at > PLAN_TTL_MS) plans.delete(k)
  }

  function requesterOf(paneId) {
    if (typeof paneId !== 'string' || !paneId) throw refuse('not_agent', 'Unknown pane.') // i18n-ignore
    const r = deps.requester(paneId)
    if (!r) throw refuse('not_agent', 'Only an agent pane open in Tessel may use the account tools.') // i18n-ignore
    return r
  }

  async function readAccounts() {
    const places = (await deps.places()) || []
    const accounts = groupByProvider(places)
      .flatMap((p) => p.accounts)
      .map((a) => ({ ...a, id: accountId(a) }))
    return { places, accounts }
  }

  function placeName(place) {
    if (place.kind === 'pc') return 'this PC' // i18n-ignore
    return String(place.label || place.hostId || place.distro || '')
  }
  function describe(p, agentPane) {
    const state = deps.paneState(p.id)
    return {
      id: p.id,
      name: String(p.name || p.id),
      project: String(p.project || ''),
      agent: deps.agentName(p.agentId),
      host: p.remoteHostId ? deps.hostLabel(p.remoteHostId) : null,
      state: STATES.includes(state) ? state : null,
      self: p.id === agentPane
    }
  }

  // --- account_list ---------------------------------------------------------------------
  async function list(agentPane) {
    const { places, accounts } = await readAccounts()
    const panes = deps.panes()
    const waitingWord = (p) => (p.state === 'not-connected' ? 'not connected' : p.state === 'error' ? 'could not be checked' : p.state === 'stopped' ? 'not running' : 'not checked yet') // i18n-ignore
    return {
      accounts: accounts.map((a) => ({
        id: a.id,
        agent: a.agent,
        agentName: deps.agentName(a.agent),
        email: a.email || null,
        login: a.login || null,
        unknown: !!a.unknown,
        plan: a.plan || null,
        sub: a.sub || null,
        places: a.chips.map(({ place, entry }) => ({
          kind: place.kind,
          name: placeName(place),
          scope: entry.scope,
          signedIn: entry.state === 'signed-in',
          switchable: !!switchTarget(place, entry, place.entries || []),
          sub: entry.sub || null
        })),
        panes: panesUsing(a, panes).map((p) => describe(p, agentPane))
      })),
      waiting: placesToCheck(places).waiting.map((p) => ({ name: placeName(p), kind: p.kind, state: waitingWord(p) }))
    }
  }

  // --- account_switch_panes: the checks ---------------------------------------------------
  function resolveAccount(accounts, ref, family) {
    const want = String(ref || '').trim().toLowerCase()
    const added = (a) => a.chips.some((c) => c.place.kind === 'pc' && c.entry.scope === 'tessel' && String(c.entry.id || '').toLowerCase() === want)
    let hits = accounts.filter((a) => a.id.toLowerCase() === want)
    if (!hits.length) hits = accounts.filter(added)
    if (!hits.length) hits = accounts.filter((a) => (a.email && a.email.toLowerCase() === want) || (a.login && (a.login.toLowerCase() === want || `@${a.login.toLowerCase()}` === want)))
    if (!hits.length && want === 'system') hits = accounts.filter((a) => a.chips.some((c) => c.place.kind === 'pc' && c.entry.scope === 'system'))
    if (hits.length > 1 && family) {
      const same = hits.filter((a) => a.agent === family)
      if (same.length) hits = same
    }
    if (hits.length > 1) throw refuse('ambiguous_account', `Several accounts match "${ref}": give one of their ids: ${hits.map((a) => `${a.id} (${a.agent})`).join(', ')}.`) // i18n-ignore
    if (!hits.length) throw refuse('unknown_account', `No account "${ref}" in Tessel. Its accounts: ${accounts.map((a) => `${a.id} (${nameOf(a)})`).join(', ') || 'none'}. See account_list.`) // i18n-ignore
    return hits[0]
  }

  // A pane named by the agent: its id, else its name (one pane only).
  function resolvePane(ref, panes) {
    const byId = panes.find((p) => p.id === ref)
    if (byId) return { pane: byId }
    const want = ref.toLowerCase()
    const named = panes.filter((p) => String(p.name || '').toLowerCase() === want)
    if (named.length === 1) return { pane: named[0] }
    if (named.length > 1) return { code: 'ambiguous_pane', message: `Several panes are named "${ref}": give one of their ids: ${named.map((p) => `${p.id}${p.project ? ` (${p.project})` : ''}`).join(', ')}.` } // i18n-ignore
    const other = typeof deps.findPane === 'function' ? deps.findPane(ref) : null
    if (!other) return { code: 'unknown_pane', message: `No pane "${ref}" in Tessel (see account_list for the panes and their ids).` } // i18n-ignore
    if (other.kind === 'chat') return { code: 'chat', message: `"${other.name}" is a chat pane: Tessel switches the account of terminal agents only (open it in a terminal first).` } // i18n-ignore
    if (other.kind === 'agent' && other.notConnected) return { code: 'not_connected', message: `"${other.name}" is not connected: connect it first.` } // i18n-ignore
    if (other.kind === 'agent') return { code: 'not_agent', message: `"${other.name}" is not an agent Tessel started.` } // i18n-ignore
    return { code: 'not_agent', message: `"${other.name}" is not an agent pane (a shell, an editor or a browser).` } // i18n-ignore
  }

  // Where this pane can go on this account: { chip, target }, or { code, message }.
  function targetFor(account, pane) {
    const name = nameOf(account)
    const pName = String(pane.name || pane.id)
    if (pane.kind === 'chat') return { code: 'chat', message: `"${pName}" is a chat pane: Tessel switches the account of terminal agents only (open it in a terminal first).` } // i18n-ignore
    if (pane.detected) return { code: 'detected', message: `"${pName}" is an agent started by hand in a shell: Tessel cannot restart it on another account.` } // i18n-ignore
    if (pane.agentId !== account.agent)
      return { code: 'wrong_agent', message: `"${pName}" is a ${deps.agentName(pane.agentId)} pane and ${name} is a ${deps.agentName(account.agent)} account: a pane moves only to an account of its own agent.` } // i18n-ignore
    const here = account.chips.filter((c) => (pane.remoteHostId ? c.place.kind === 'ssh' && c.place.hostId === pane.remoteHostId : c.place.kind === 'pc'))
    if (!here.length) {
      const elsewhere = [...new Set(account.chips.map((c) => placeName(c.place)))].join(', ') || 'nowhere Tessel knows' // i18n-ignore
      return { code: 'wrong_machine', message: `"${pName}" runs on ${where(pane, deps.hostLabel)}, where ${name} is not signed in (it is on: ${elsewhere}): a pane moves only to an account signed in on its own machine.` } // i18n-ignore
    }
    const usable = here.filter((c) => switchTarget(c.place, c.entry, c.place.entries || []))
    if (!usable.length) {
      const why = !pane.remoteHostId && pane.agentId !== 'claude' ? `${deps.agentName(pane.agentId)} panes on this PC keep their account (its conversations stay with their account)` : here.some((c) => c.entry.state === 'signed-in') ? 'Tessel cannot start an agent on that sign-in' : 'it is not signed in there now' // i18n-ignore
      return { code: 'not_switchable', message: `"${pName}" cannot move to ${name} on ${where(pane, deps.hostLabel)}: ${why}.` } // i18n-ignore
    }
    const active = usable.filter((c) => !needsAttention(c.entry, now()))
    if (!active.length) {
      const s = subscriptionState(usable[0].entry.sub, now()) || {}
      const what = s.warn === 'payment' ? 'a payment issue' : s.warn === 'canceled' ? 'its subscription canceled' : 'no subscription' // i18n-ignore
      return { code: 'inactive_account', message: `${name} has ${what} on ${where(pane, deps.hostLabel)} (Tessel's last check with Anthropic): Tessel does not move panes to it. Choose another account (account_list).` } // i18n-ignore
    }
    for (const c of active) {
      const target = switchTarget(c.place, c.entry, c.place.entries || [])
      if (switchablePanes(c.place, c.entry, target, [pane]).length) return { chip: c, target }
    }
    return { code: 'already', message: `"${pName}" already runs on ${name}.` } // i18n-ignore
  }

  // The account a pane is on now (its name), for the card.
  function currentAccount(accounts, pane) {
    const a = accounts.find((x) => panesUsing(x, [pane]).length)
    return a ? (a.email || (a.login ? `@${a.login}` : '') || null) : null
  }

  async function plan(agentPane, req) {
    const refs = Array.isArray(req.panes) ? [...new Set(req.panes.map((p) => String(p || '').trim()).filter(Boolean))] : []
    if (!refs.length) throw refuse('invalid_argument', 'Give "panes": the names or ids of the panes to move.') // i18n-ignore
    if (refs.length > MAX_PANES) throw refuse('too_many', `At most ${MAX_PANES} panes at a time.`) // i18n-ignore
    const { accounts } = await readAccounts()
    const panes = deps.panes()
    const problems = []
    const found = []
    for (const ref of refs) {
      const r = resolvePane(ref, panes)
      if (r.pane) {
        if (!found.includes(r.pane)) found.push(r.pane)
      } else problems.push(r)
    }
    const families = [...new Set(found.map((p) => p.agentId))]
    let account
    try {
      account = resolveAccount(accounts, req.account, families.length === 1 ? families[0] : null)
    } catch (err) {
      if (!problems.length) throw err
      problems.push({ code: err.code, message: err.message })
    }
    if (!account) throw refuse(problems[0].code, `Nothing was asked of the user:\n${problems.map((p) => `- ${p.message}`).join('\n')}`) // i18n-ignore
    const items = []
    const already = []
    let inactive = null
    for (const pane of found) {
      const t = targetFor(account, pane)
      if (t.code === 'already') already.push(pane)
      else if (t.code === 'inactive_account') inactive = inactive || t
      else if (t.code) problems.push(t)
      else items.push({ pane, target: t.target, chip: t.chip })
    }
    // An account without a subscription: the whole request (Switch panes
    // never offers it).
    if (inactive) throw refuse('inactive_account', inactive.message)
    if (problems.length) throw refuse(problems[0].code, `Nothing was asked of the user:\n${problems.map((p) => `- ${p.message}`).join('\n')}`) // i18n-ignore
    if (!items.length) throw refuse('already', `${already.length === 1 ? `"${already[0].name}" already runs` : 'These panes already run'} on ${nameOf(account)}: nothing to switch.`) // i18n-ignore
    sweep()
    const token = newToken()
    const accountName = nameOf(account)
    // The account as the card shows it: the sign-ins the panes go to (their
    // own checks), its plan.
    const chips = [...new Set(items.map((i) => i.chip))]
    const sub = chips.map((c) => c.entry.sub).find(Boolean) || account.sub || null
    const card = {
      account: {
        id: account.id,
        agent: account.agent,
        agentName: deps.agentName(account.agent),
        email: account.email || null,
        login: account.login || null,
        unknown: !!account.unknown,
        plan: account.plan || null,
        sub,
        where: [...new Set(chips.map((c) => (c.place.kind === 'pc' ? '' : placeName(c.place))))]
      },
      panes: items.map(({ pane }) => ({ ...describe(pane, agentPane), from: currentAccount(accounts, pane) })),
      already: already.map((p) => describe(p, agentPane))
    }
    plans.set(token, {
      agentPane,
      accountKey: account.key,
      accountName,
      items: items.map(({ pane, target }) => ({ id: pane.id, target: target.id ?? null, desc: describe(pane, agentPane) })),
      already: card.already,
      card,
      at: now(),
      allowed: false,
      allowedAt: 0
    })
    return { token, account: { id: account.id, agent: account.agent, email: account.email || null, login: account.login || null }, panes: card.panes, already: card.already }
  }

  // --- The card -----------------------------------------------------------------------------
  async function approve(agentPane, agentLabel, req) {
    const p = typeof req.token === 'string' ? plans.get(req.token) : null
    if (!p || p.agentPane !== agentPane) throw refuse('no_switch', 'This switch is no longer known: ask again.') // i18n-ignore
    const asked = Number(req.timeoutMs)
    const ms = Math.min(APPROVAL_MS, Math.max(10000, Number.isFinite(asked) ? asked : APPROVAL_MS))
    const card = {
      kind: 'accounts',
      token: req.token,
      agentLabel,
      explanation: String(req.explanation || '').slice(0, 300),
      ...p.card,
      timeoutMs: ms
    }
    const answer = await deps.approve(card, agentPane, { ms })
    const allow = !!(answer && answer.allow === true)
    // Only this answer (the card's own buttons) lets the switch run.
    if (allow && plans.get(req.token) === p) {
      p.allowed = true
      p.allowedAt = now()
    } else plans.delete(req.token)
    return { allow, timedOut: !allow && !!(answer && answer.timedOut === true) }
  }

  // --- The switch, once allowed ---------------------------------------------------------
  const STATUS = { ok: 'restarted', failed: 'failed', not_started: 'not_started', busy: 'busy' }
  async function run(agentPane, agentLabel, req) {
    const p = typeof req.token === 'string' ? plans.get(req.token) : null
    if (!p || p.agentPane !== agentPane || p.allowed !== true) throw refuse('not_allowed', 'The user has not allowed this switch.') // i18n-ignore
    plans.delete(req.token)
    if (now() - p.allowedAt > ALLOWED_TTL_MS) throw refuse('expired', 'This switch was allowed too long ago: ask again.') // i18n-ignore
    // Checked again now: a pane closed, moved or switched meanwhile is left as it is.
    const { accounts } = await readAccounts()
    const account = accounts.find((a) => a.key === p.accountKey) || null
    const panes = deps.panes()
    const results = []
    let self = null
    for (const item of p.items) {
      const pane = panes.find((x) => x.id === item.id)
      if (!pane) {
        results.push({ ...item.desc, status: 'gone' })
        continue
      }
      const desc = describe(pane, agentPane)
      const t = account ? targetFor(account, pane) : { code: 'changed', message: '' }
      if (t.code || (t.target.id ?? null) !== item.target) {
        results.push({ ...desc, status: t.code === 'already' ? 'already' : 'changed', reason: t.code && t.code !== 'already' ? t.message : '' })
        continue
      }
      if (pane.id === agentPane) {
        self = { pane, target: t.target, desc }
        continue
      }
      let status
      try {
        status = await deps.restart(pane.id, t.target.id ?? null)
      } catch {
        status = 'failed'
      }
      results.push({ ...desc, status: STATUS[status] || 'failed' })
    }
    if (self) {
      const { pane, target } = self
      later(() => {
        Promise.resolve(deps.restart(pane.id, target.id ?? null)).catch(() => {})
      }, SELF_RESTART_MS)
      results.push({ ...self.desc, status: 'later' })
    }
    for (const d of p.already) results.push({ ...d, status: 'already' })
    const count = results.filter((r) => r.status === 'restarted' || r.status === 'later').length
    if (count && typeof deps.switched === 'function') deps.switched({ agentLabel, account: p.accountName, count })
    return { results }
  }

  async function handle(req = {}) {
    const agentPane = req.agent
    // The agent's tool call went away (its pane may be gone too): its card
    // goes unanswered (no), its switches are forgotten.
    if (req.op === 'abort') {
      if (typeof agentPane === 'string' && agentPane) deps.dismiss(agentPane)
      for (const [k, p] of plans) if (p.agentPane === agentPane) plans.delete(k)
      return { ok: true }
    }
    const { label } = requesterOf(agentPane)
    if (req.op === 'list') return list(agentPane)
    if (req.op === 'plan') return plan(agentPane, req)
    if (req.op === 'approve') return approve(agentPane, label, req)
    if (req.op === 'switch') return run(agentPane, label, req)
    throw refuse('unknown_method', `Unknown account operation: ${String(req.op).slice(0, 40)}`) // i18n-ignore
  }

  return { handle, _plans: plans }
}
