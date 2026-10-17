// The window's side of the agents' account tools (src/main/agentAccounts.js
// asks it): the sign-ins Tessel knows, by account, with the panes on each
// (what Settings > AI provider accounts > Where you're signed in shows), and
// a switch an agent asks for. A switch is checked as Switch panes… checks it
// (signedInPlaces.js: a pane of the sign-in's agent, at the pane's own place,
// a sign-in a pane can start on, never one whose own check says no
// subscription), shown to the user on one card (Allow or Refuse), and run
// with the pane menu's Restart on <account> (App.vue's restartOnAccount),
// only for a switch the user allowed on that card.
//
// The rules:
// - "Let agents move panes to another account" (Settings > Agents) off:
//   nothing.
// - Only an agent pane (a terminal agent or a chat) may ask.
// - Each sign-in has its own id (where it is and which one, never its
//   email), and a switch goes to exactly one sign-in: named by its id, or by
//   an email that has a single sign-in a pane can start on at the pane's
//   place (else the agent is asked to choose one by id).
// - An agent on an SSH host sees only its host's sign-ins and the panes of
//   its own project there, and moves only those.
// - Panes of any project may be named by a local agent: the card names each
//   one, with its project, and who asks.
// - Nothing in the agent's request answers the card: the card's own buttons
//   mark a switch allowed (here, in the window), and a switch not allowed
//   there is never run.
// - One request at a time per agent; after a Refuse or no answer, it waits
//   COOLDOWN_MS before asking again; "Don't ask again from this agent"
//   refuses its next requests until Tessel restarts.
// - The agent's own pane, when it is in the list, restarts last, a moment
//   after its answer is sent (its restart ends its tool call).
//
// The answers go to the agent: English on purpose.
import { groupByProvider, panesOn, placesToCheck, shownOrg, switchTarget, switchablePanes } from './signedInPlaces'
import { subscriptionState } from '../../shared/claudeSubscription'

export class AgentAccountError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
const refuse = (code, message) => new AgentAccountError(code, message)

export const MAX_PANES = 20
// A pane's name or id as the agent gives it (the pipe takes no more).
export const MAX_REF = 120
// The card's time (main says it; never more than this, nor less than 10 s).
export const APPROVAL_MS = 2 * 60 * 1000
// Codex on an SSH host gives up on a tool call after 60 s (its own
// default; Tessel sets a longer one on this PC only): its card ends before.
export const SHORT_APPROVAL_MS = 50 * 1000
// A switch asked for and not answered is dropped after this; one allowed
// runs at once (main asks right after the answer).
export const PLAN_TTL_MS = 5 * 60 * 1000
export const ALLOWED_TTL_MS = 60 * 1000
// The asking agent's own pane restarts this long after its answer is sent.
export const SELF_RESTART_MS = 3000
// After a Refuse or no answer, the same agent waits this long.
export const COOLDOWN_MS = 2 * 60 * 1000

// A sign-in's id for the agent: where it is and which one, never its email.
// This PC: the account's id when it was added in Tessel, else
// "<agent>:system" (the agent's own sign-in) or "<agent>:pc"; a host or a
// distro: "ssh:<host>:<agent>:<folder id | own | env>".
export function signInId(place, entry) {
  const agent = String(entry.agent || '')
  if (place.kind === 'pc') {
    if (entry.scope === 'tessel' && typeof entry.id === 'string' && /^[\w-]{1,100}$/.test(entry.id)) return entry.id
    return `${agent}:${entry.scope === 'system' ? 'system' : 'pc'}`
  }
  const where = place.kind === 'ssh' ? `ssh:${place.hostId}` : `wsl:${place.distro || place.label}` // i18n-ignore
  const which = (entry.scope === 'tessel' || entry.scope === 'orphan') && typeof entry.id === 'string' ? entry.id : entry.scope === 'default' ? 'own' : String(entry.scope || 'own')
  return `${where}:${agent}:${which}`
}

// Every sign-in Tessel knows, with the account it is of (an email, a login,
// or the provider's "unknown account"): [{ id, place, entry, account }].
export function allSignIns(places) {
  const out = []
  for (const provider of groupByProvider(places)) for (const account of provider.accounts) for (const { place, entry } of account.chips) out.push({ id: signInId(place, entry), place, entry, account })
  return out
}

// A sign-in whose own check says the account has no subscription, or a
// payment issue (no trial running): Switch panes never offers it.
export function needsAttention(entry, now = Date.now()) {
  if (!entry || entry.agent !== 'claude') return false
  const s = subscriptionState(entry.sub, now)
  return !!(s && s.attention)
}

// No control or invisible formatting characters (bidi marks, zero-width).
const plain = (v, max) =>
  String(v == null ? '' : v)
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
const nameOf = (a) => (a && (a.email || (a.login ? `@${a.login}` : ''))) || 'an account with no name yet' // i18n-ignore
const where = (pane, hostLabel) => (pane.remoteHostId ? `the SSH host ${hostLabel(pane.remoteHostId)}` : 'this PC') // i18n-ignore
const STATES = ['working', 'approval', 'waiting', 'monitoring', 'limited']
const SCOPE_WORDS = { system: 'its own sign-in', tessel: 'added in Tessel', default: 'its own sign-in', env: 'the login shell\'s folder', orphan: 'a left-over folder' } // i18n-ignore

// deps:
//   enabled() -> bool                  Settings > Agents > Let agents move panes to another account
//   places() -> Promise<[place]>       main's signedInPlaces (after the live plan check)
//   panes() -> [{ id, kind, name, agentId, remoteHostId, hostAccount, accountId, detected, project, wsId }]
//                                      App's accountPanes list (the panes Switch panes knows)
//   findPane(ref) -> { name, kind, notConnected, runs } | null   any pane, by id or name (to say why)
//   requester(paneId) -> { label, project, wsId, hostId, agentId } | null   an open agent or chat pane
//   agentName(agentId), hostLabel(hostId)
//   paneState(paneId) -> 'working' | 'approval' | ... | null
//   approve(card, agentPane, { ms }) -> Promise<{ allow, timedOut, block }>   the card
//   dismiss(agentPane)                 its card answered no (its tool call went away)
//   restart(paneId, accountId) -> Promise<'ok' | 'failed' | 'not_started' | 'busy'>
//   switched({ agentLabel, account, count })   a notice for the user
//   later(fn, ms), now(), newToken()
export function createAgentAccountTargets(deps) {
  const now = deps.now || (() => Date.now())
  const later = deps.later || ((fn, ms) => setTimeout(fn, ms))
  const newToken = deps.newToken || (() => globalThis.crypto.randomUUID())
  const enabled = () => (typeof deps.enabled === 'function' ? deps.enabled() !== false : true)
  // token -> { agentPane, accountName, items: [{ id, signInId, target, desc }], already, card, at, allowed, allowedAt }
  const plans = new Map()
  const cooldown = new Map() // agent pane -> until
  const blocked = new Set() // agent panes the user asked not to hear from again
  const aborts = new Map() // agent pane -> how many times its call went away

  function sweep() {
    const t = now()
    for (const [k, p] of plans) if (t - p.at > PLAN_TTL_MS) plans.delete(k)
    for (const [k, until] of cooldown) if (until <= t) cooldown.delete(k)
  }

  function requesterOf(paneId) {
    if (typeof paneId !== 'string' || !paneId) throw refuse('not_agent', 'Unknown pane.') // i18n-ignore
    const r = deps.requester(paneId)
    if (!r) throw refuse('not_agent', 'Only an agent pane open in Tessel may use the account tools.') // i18n-ignore
    return { id: paneId, label: String(r.label || paneId), project: String(r.project || ''), wsId: r.wsId == null ? null : r.wsId, hostId: r.hostId || null, agentId: r.agentId || null }
  }
  // An agent on an SSH host: its host's sign-ins, its project's panes there.
  const signInSeen = (req, s) => !req.hostId || (s.place.kind === 'ssh' && s.place.hostId === req.hostId)
  const paneSeen = (req, p) => !req.hostId || (p.remoteHostId === req.hostId && p.wsId === req.wsId)

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
  // A sign-in as the agent and the card see it.
  function signInInfo(s) {
    return {
      id: s.id,
      kind: s.place.kind,
      place: placeName(s.place),
      where: s.place.kind === 'pc' ? '' : placeName(s.place),
      scope: s.entry.scope,
      org: shownOrg(s.entry.org, s.entry.email) || null,
      plan: s.entry.plan || s.account.plan || null,
      sub: s.entry.sub || null
    }
  }
  const signInText = (s) => `${s.id} (${placeName(s.place)}, ${s.place.kind !== 'pc' && s.entry.scope === 'tessel' ? 'account folder made by Tessel' : SCOPE_WORDS[s.entry.scope] || s.entry.scope}${shownOrg(s.entry.org, s.entry.email) ? `, organization ${shownOrg(s.entry.org, s.entry.email)}` : ''})` // i18n-ignore

  // --- account_list ---------------------------------------------------------------------
  async function list(req) {
    const places = (await deps.places()) || []
    const panes = deps.panes().filter((p) => paneSeen(req, p))
    const accounts = new Map() // account key -> its entry
    for (const s of allSignIns(places)) {
      if (!signInSeen(req, s)) continue
      let a = accounts.get(s.account.key)
      if (!a) {
        a = { agent: s.account.agent, agentName: deps.agentName(s.account.agent), email: s.account.email || null, login: s.account.login || null, unknown: !!s.account.unknown, signIns: [] }
        accounts.set(s.account.key, a)
      }
      a.signIns.push({
        ...signInInfo(s),
        signedIn: s.entry.state === 'signed-in',
        switchable: !!switchTarget(s.place, s.entry, s.place.entries || []),
        panes: panesOn(s.place, s.entry, panes).map((p) => describe(p, req.id))
      })
    }
    const waitingWord = (p) => (p.state === 'not-connected' ? 'not connected' : p.state === 'error' ? 'could not be checked' : p.state === 'stopped' ? 'not running' : 'not checked yet') // i18n-ignore
    const waiting = placesToCheck(places).waiting.filter((p) => !req.hostId || (p.kind === 'ssh' && p.hostId === req.hostId))
    return {
      accounts: [...accounts.values()],
      waiting: waiting.map((p) => ({ name: placeName(p), kind: p.kind, state: waitingWord(p) })),
      // An agent on an SSH host is told what it sees.
      scope: req.hostId ? { host: deps.hostLabel(req.hostId), project: req.project } : null
    }
  }

  // --- account_switch_panes: the checks ---------------------------------------------------
  // The sign-in(s) "account" names: { pinned } (its id), or { candidates }
  // (an email, a login, or "system": their sign-ins, chosen per pane).
  function resolveAccount(signIns, ref, family) {
    const want = String(ref || '').trim().toLowerCase()
    const pinned = signIns.find((s) => s.id.toLowerCase() === want)
    if (pinned) return { pinned }
    let candidates =
      want === 'system'
        ? signIns.filter((s) => s.place.kind === 'pc' && s.entry.scope === 'system')
        : signIns.filter((s) => !s.account.unknown && ((s.account.email && s.account.email.toLowerCase() === want) || (s.account.login && (s.account.login.toLowerCase() === want || `@${s.account.login.toLowerCase()}` === want))))
    if (family && candidates.some((s) => s.account.agent === family)) candidates = candidates.filter((s) => s.account.agent === family)
    if (new Set(candidates.map((s) => s.account.key)).size > 1)
      throw refuse('ambiguous_account', `Several accounts match "${ref}": give the id of one of their sign-ins: ${candidates.map(signInText).join('; ')}.`) // i18n-ignore
    if (!candidates.length) throw refuse('unknown_account', `No sign-in "${ref}" in Tessel: give a sign-in id from account_list${signIns.length ? ` (${signIns.slice(0, 12).map((s) => s.id).join(', ')})` : ''}. An account with no email is named by its sign-in id only.`) // i18n-ignore
    return { candidates }
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

  // This pane on this one sign-in: { target }, or { code, message }.
  function targetFor(s, pane) {
    const name = nameOf(s.account)
    const pName = String(pane.name || pane.id)
    if (pane.kind === 'chat') return { code: 'chat', message: `"${pName}" is a chat pane: Tessel switches the account of terminal agents only (open it in a terminal first).` } // i18n-ignore
    if (pane.detected) return { code: 'detected', message: `"${pName}" is an agent started by hand in a shell: Tessel cannot restart it on another account.` } // i18n-ignore
    if (pane.agentId !== s.entry.agent)
      return { code: 'wrong_agent', message: `"${pName}" is a ${deps.agentName(pane.agentId)} pane and ${name} is a ${deps.agentName(s.entry.agent)} account: a pane moves only to an account of its own agent.` } // i18n-ignore
    const here = pane.remoteHostId ? s.place.kind === 'ssh' && s.place.hostId === pane.remoteHostId : s.place.kind === 'pc'
    if (!here) return { code: 'wrong_machine', message: `"${pName}" runs on ${where(pane, deps.hostLabel)}, and the sign-in ${s.id} is on ${placeName(s.place)}: a pane moves only to a sign-in on its own machine.` } // i18n-ignore
    const target = switchTarget(s.place, s.entry, s.place.entries || [])
    if (!target) {
      const why = !pane.remoteHostId && pane.agentId !== 'claude' ? `${deps.agentName(pane.agentId)} panes on this PC keep their account (its conversations stay with their account)` : s.entry.state === 'signed-in' ? 'Tessel cannot start an agent on that sign-in' : 'it is not signed in there now' // i18n-ignore
      return { code: 'not_switchable', message: `"${pName}" cannot move to ${name} on ${where(pane, deps.hostLabel)}: ${why}.` } // i18n-ignore
    }
    if (needsAttention(s.entry, now())) {
      const st = subscriptionState(s.entry.sub, now()) || {}
      const what = st.warn === 'payment' ? 'a payment issue' : st.warn === 'canceled' ? 'its subscription canceled' : 'no subscription' // i18n-ignore
      return { code: 'inactive_account', message: `${name} has ${what} on ${where(pane, deps.hostLabel)} (Tessel's last check with Anthropic): Tessel does not move panes to it. Choose another account (account_list).` } // i18n-ignore
    }
    if (!switchablePanes(s.place, s.entry, target, [pane]).length) return { code: 'already', message: `"${pName}" already runs on ${name}.` } // i18n-ignore
    return { target }
  }

  // The sign-in a pane goes to: the pinned one, else the one candidate a
  // pane can start on at its place. -> { signIn, target } | { code, message }
  function chooseFor(account, pane) {
    if (account.pinned) {
      const t = targetFor(account.pinned, pane)
      return t.code ? t : { signIn: account.pinned, target: t.target }
    }
    const atPlace = account.candidates.filter((s) => s.entry.agent === pane.agentId && (pane.remoteHostId ? s.place.kind === 'ssh' && s.place.hostId === pane.remoteHostId : s.place.kind === 'pc'))
    const usable = atPlace.filter((s) => switchTarget(s.place, s.entry, s.place.entries || []))
    if (usable.length > 1)
      return { code: 'ambiguous_account', message: `${nameOf(usable[0].account)} has ${usable.length} sign-ins on ${where(pane, deps.hostLabel)}: give the id of the one to use: ${usable.map(signInText).join('; ')}.` } // i18n-ignore
    const one = usable[0] || atPlace[0] || account.candidates.find((s) => s.entry.agent === pane.agentId) || account.candidates[0]
    const t = targetFor(one, pane)
    if (t.code === 'wrong_machine') {
      const elsewhere = [...new Set(account.candidates.map((s) => placeName(s.place)))].join(', ')
      return { code: 'wrong_machine', message: `"${String(pane.name || pane.id)}" runs on ${where(pane, deps.hostLabel)}, where ${nameOf(one.account)} is not signed in (it is on: ${elsewhere}): a pane moves only to a sign-in on its own machine.` } // i18n-ignore
    }
    return t.code ? t : { signIn: one, target: t.target }
  }

  // The account a pane is on now (its name), for the card.
  function currentAccount(signIns, pane) {
    const s = signIns.find((x) => panesOn(x.place, x.entry, [pane]).length)
    return s ? (s.account.email || (s.account.login ? `@${s.account.login}` : '') || null) : null
  }

  function mayAsk(agentPane) {
    sweep()
    if (blocked.has(agentPane)) throw refuse('blocked', 'The user asked not to get account switch requests from you again (until Tessel restarts). Do not ask; tell the user what you need instead.') // i18n-ignore
    const until = cooldown.get(agentPane)
    if (until && until > now()) throw refuse('cooldown', `The user refused or did not answer your last account switch: wait ${Math.ceil((until - now()) / 1000)} s before asking again, and only if they want it.`) // i18n-ignore
    for (const p of plans.values()) if (p.agentPane === agentPane) throw refuse('pending', 'You already have an account switch waiting for the user: wait for its answer.') // i18n-ignore
  }

  async function plan(req, args) {
    const agentPane = req.id
    mayAsk(agentPane)
    const refs = Array.isArray(args.panes) ? [...new Set(args.panes.map((p) => plain(p, MAX_REF)).filter(Boolean))] : []
    if (!refs.length) throw refuse('invalid_argument', 'Give "panes": the names or ids of the panes to move.') // i18n-ignore
    if (refs.length > MAX_PANES) throw refuse('too_many', `At most ${MAX_PANES} panes at a time.`) // i18n-ignore
    const seq = aborts.get(agentPane) || 0
    const places = (await deps.places()) || []
    // Its call went away while the places were read: nothing is kept.
    if ((aborts.get(agentPane) || 0) !== seq) throw refuse('cancelled', 'The request was cancelled.') // i18n-ignore
    const signIns = allSignIns(places).filter((s) => signInSeen(req, s))
    const panes = deps.panes()
    const problems = []
    const found = []
    for (const ref of refs) {
      const r = resolvePane(ref, panes)
      if (!r.pane) problems.push(r)
      else if (!paneSeen(req, r.pane)) problems.push({ code: 'not_your_project', message: `"${r.pane.name}" is not a pane of your project on your SSH host: an agent on an SSH host moves only those.` }) // i18n-ignore
      else if (!found.includes(r.pane)) found.push(r.pane)
    }
    const families = [...new Set(found.map((p) => p.agentId))]
    let account = null
    try {
      account = resolveAccount(signIns, args.account, families.length === 1 ? families[0] : null)
    } catch (err) {
      problems.push({ code: err.code, message: err.message })
    }
    const items = []
    const already = []
    let inactive = null
    if (account) {
      for (const pane of found) {
        const t = chooseFor(account, pane)
        if (t.code === 'already') already.push(pane)
        else if (t.code === 'inactive_account') inactive = inactive || t
        else if (t.code) problems.push(t)
        else items.push({ pane, signIn: t.signIn, target: t.target })
      }
    }
    // A sign-in without a subscription: the whole request (Switch panes
    // never offers it).
    if (inactive) throw refuse('inactive_account', inactive.message)
    if (problems.length) throw refuse(problems[0].code, `Nothing was asked of the user:\n${problems.map((p) => `- ${p.message}`).join('\n')}`) // i18n-ignore
    if (!items.length) throw refuse('already', `${already.length === 1 ? `"${already[0].name}" already runs` : 'These panes already run'} on ${nameOf(account.pinned ? account.pinned.account : account.candidates[0].account)}: nothing to switch.`) // i18n-ignore
    const token = newToken()
    const used = [...new Set(items.map((i) => i.signIn))]
    const acc = used[0].account
    const accountName = nameOf(acc)
    const descs = items.map(({ pane }) => ({ ...describe(pane, agentPane), from: currentAccount(signIns, pane) }))
    const projects = []
    for (const d of descs) {
      const p = projects.find((x) => x.name === d.project)
      if (p) p.count++
      else projects.push({ name: d.project, count: 1 })
    }
    const card = {
      requester: { label: req.label, project: req.project, host: req.hostId ? deps.hostLabel(req.hostId) : null },
      account: { agent: acc.agent, agentName: deps.agentName(acc.agent), email: acc.email || null, login: acc.login || null, unknown: !!acc.unknown },
      signIns: used.map(signInInfo),
      panes: descs,
      projects,
      already: already.map((p) => describe(p, agentPane))
    }
    plans.set(token, {
      agentPane,
      accountName,
      items: items.map(({ pane, signIn, target }, i) => ({ id: pane.id, signInId: signIn.id, target: target.id ?? null, desc: descs[i] })),
      already: card.already,
      card,
      at: now(),
      allowed: false,
      allowedAt: 0
    })
    return { token, account: { agent: acc.agent, email: acc.email || null, login: acc.login || null }, signIns: used.map((s) => s.id), panes: descs, already: card.already }
  }

  // --- The card -----------------------------------------------------------------------------
  async function approve(req, args) {
    const agentPane = req.id
    const p = typeof args.token === 'string' ? plans.get(args.token) : null
    if (!p || p.agentPane !== agentPane) throw refuse('no_switch', 'This switch is no longer known: ask again.') // i18n-ignore
    const asked = Number(args.timeoutMs)
    const cap = req.hostId && req.agentId === 'codex' ? SHORT_APPROVAL_MS : APPROVAL_MS
    const ms = Math.min(cap, Math.max(10000, Number.isFinite(asked) ? asked : APPROVAL_MS))
    const card = { kind: 'accounts', token: args.token, agentLabel: req.label, explanation: plain(args.explanation, 300), ...p.card, timeoutMs: ms }
    const seq = aborts.get(agentPane) || 0
    const answer = await deps.approve(card, agentPane, { ms })
    // Its call went away while the card was up: not the user's answer.
    if ((aborts.get(agentPane) || 0) !== seq) {
      plans.delete(args.token)
      return { allow: false, timedOut: false, blocked: false, cancelled: true, ms }
    }
    const allow = !!(answer && answer.allow === true)
    // Only this answer (the card's own buttons) lets the switch run.
    if (allow && plans.get(args.token) === p) {
      p.allowed = true
      p.allowedAt = now()
    } else {
      plans.delete(args.token)
      if (!allow) {
        cooldown.set(agentPane, now() + COOLDOWN_MS)
        if (answer && answer.block === true) blocked.add(agentPane)
      }
    }
    return { allow, timedOut: !allow && !!(answer && answer.timedOut === true), blocked: !allow && !!(answer && answer.block === true), ms }
  }

  // --- The switch, once allowed ---------------------------------------------------------
  const STATUS = { ok: 'restarted', failed: 'failed', not_started: 'not_started', busy: 'busy' }
  async function run(req, args) {
    const agentPane = req.id
    const p = typeof args.token === 'string' ? plans.get(args.token) : null
    if (!p || p.agentPane !== agentPane || p.allowed !== true) throw refuse('not_allowed', 'The user has not allowed this switch.') // i18n-ignore
    plans.delete(args.token)
    if (now() - p.allowedAt > ALLOWED_TTL_MS) throw refuse('expired', 'This switch was allowed too long ago: ask again.') // i18n-ignore
    // Checked again now: a pane closed, moved or switched meanwhile, or a
    // sign-in gone, is left as it is.
    const signIns = allSignIns((await deps.places()) || [])
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
      const s = signIns.find((x) => x.id === item.signInId)
      const t = s && paneSeen(req, pane) && signInSeen(req, s) ? targetFor(s, pane) : { code: 'changed', message: '' }
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
    if (count && typeof deps.switched === 'function') deps.switched({ agentLabel: req.label, account: p.accountName, count })
    return { results }
  }

  async function handle(params = {}) {
    const agentPane = params.agent
    // The agent's tool call went away (its pane may be gone too): its card
    // goes unanswered (no), its switches are forgotten, a plan being made
    // for it is dropped.
    if (params.op === 'abort') {
      if (typeof agentPane === 'string' && agentPane) {
        aborts.set(agentPane, (aborts.get(agentPane) || 0) + 1)
        deps.dismiss(agentPane)
      }
      for (const [k, p] of plans) if (p.agentPane === agentPane) plans.delete(k)
      return { ok: true }
    }
    if (!enabled()) throw refuse('disabled', 'The user turned off "Let agents move panes to another account" (Tessel Settings > Agents).') // i18n-ignore
    const req = requesterOf(agentPane)
    if (params.op === 'list') return list(req)
    if (params.op === 'plan') return plan(req, params)
    if (params.op === 'approve') return approve(req, params)
    if (params.op === 'switch') return run(req, params)
    throw refuse('unknown_method', `Unknown account operation: ${String(params.op).slice(0, 40)}`) // i18n-ignore
  }

  return { handle, _plans: plans, _blocked: blocked, _cooldown: cooldown }
}
