// "Where you're signed in" (Settings > AI provider accounts): every place
// Tessel itself can see an agent signed in, for each account. This PC (the
// system's own sign-in and the accounts added in Tessel), each WSL distro,
// each saved SSH host (the agent's own sign-in there and the folders Tessel
// made there for one account each). Only machines Tessel knows: a provider
// does not tell which other devices an account is signed in on.
//
// places() answers at once from what is known (this PC read now; hosts and
// distros from the last scan, or "not checked"); scan(id) checks one host or
// distro (in the background, bounded in time: remoteAccounts.js,
// wslAccounts.js), so one slow host never holds the others. Identity fields
// only, never a token.
import fs from 'fs/promises'
import path from 'path'
import { entryState, FOLDER_AGENTS, OVERRIDES } from './remoteAgent/remoteAccounts'
import { cleanSubscription } from '../shared/claudeSubscription'

const PLACE = /^(pc|wsl:[\w.-]{1,64}|ssh:[\w-]{1,80})$/
const LOCAL_SIGNINS = ['gemini', 'grok', 'cursor', 'muse']
const text = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

// One row of a place, the same shape wherever it was read. sub: a Claude
// account's subscription as Anthropic last reported it (claudePlanCheck.js
// on this PC, the host's own check on an SSH host or a WSL distro).
function row(e) {
  const sub = e.agent === 'claude' ? cleanSubscription(e.sub || e.subscription) : null
  return {
    agent: e.agent,
    scope: e.scope,
    id: typeof e.id === 'string' ? e.id : null,
    email: text(e.email, 254),
    org: text(e.org, 120),
    plan: text(e.plan, 40),
    login: text(e.login, 39),
    providers: Array.isArray(e.providers) ? e.providers.slice(0, 20).map((p) => ({ name: text(p.name, 40), type: text(p.type, 20) })) : undefined,
    state: e.state,
    lastSeen: Number.isFinite(e.lastSeen) ? e.lastSeen : null,
    removable: !!e.removable,
    signOut: !!e.signOut,
    ...(sub ? { sub } : {}),
    ...(Array.isArray(e.override) && e.override.length ? { override: e.override.filter((o) => OVERRIDES.includes(o)) } : {})
  }
}

// A host's or distro's detection (remoteAccounts.parseAccounts) -> rows.
// actions: an SSH host's folders can be removed (one Tessel made, or one
// that lost its marker but still holds a sign-in), its own sign-in signed
// out of. envOverrides: the keys or tokens its login shell exports, which
// count for every session of that agent there.
export function hostRows(entries, { actions = false, envOverrides = null } = {}) {
  return (Array.isArray(entries) ? entries : []).map((e) => {
    const fromEnv = envOverrides && Array.isArray(envOverrides[e.agent]) ? envOverrides[e.agent] : []
    const override = [...new Set([...(Array.isArray(e.override) ? e.override : []), ...fromEnv])]
    return row({
      ...e,
      override,
      state: entryState(e),
      lastSeen: e.mtimeMs,
      removable: actions && (e.scope === 'tessel' || e.scope === 'orphan'),
      signOut: actions && e.scope === 'default' && FOLDER_AGENTS.includes(e.agent) && e.cred === 'file'
    })
  })
}

const STATUS = { ready: 'signed-in', missing: 'missing', unknown: 'unknown' }
// accounts.list() (providerAccounts.js) -> this PC's Claude Code and Codex rows.
export function pcAccountRows(list) {
  const out = []
  for (const p of (list && Array.isArray(list.providers) && list.providers) || []) {
    if (!p || p.error || !FOLDER_AGENTS.includes(p.provider)) continue
    const s = p.system
    if (s && (s.status === 'ready' || s.email)) out.push(row({ agent: p.provider, scope: 'system', id: null, email: s.email, org: s.organization, plan: s.plan, subscription: s.subscription, state: STATUS[s.status] || 'unknown' }))
    for (const a of p.accounts || []) {
      if (!a || typeof a.id !== 'string') continue
      const at = Date.parse(a.lastLoginAt || '')
      out.push(row({ agent: p.provider, scope: 'tessel', id: a.id, email: a.email, org: a.organization, plan: a.plan, subscription: a.subscription, state: STATUS[a.status] || 'unknown', lastSeen: Number.isFinite(at) ? at : null }))
    }
  }
  return out
}

// GitHub Copilot CLI on this PC: the GitHub login its config names (never
// its token, which is in the system's credential store or another file).
export async function copilotRows({ home }) {
  try {
    const file = path.join(home, '.copilot', 'config.json')
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) return []
    const user = JSON.parse(await fs.readFile(file, 'utf8'))?.last_logged_in_user
    const login = user && typeof user.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(user.login) ? user.login : null
    return login ? [{ agent: 'copilot', scope: 'default', login, state: 'signed-in', lastSeen: stat.mtimeMs }] : []
  } catch {
    return []
  }
}

// accounts: providerAccounts.js; localSignIn(provider): usageProviderSources'
// signIn (Gemini, Grok, Cursor, Muse Code on this PC); localOthers(): more rows of this
// PC (Copilot); hosts: remoteHosts.js; connected(hostId): remoteFs's
// connectedQuietly; remoteAccounts: remoteAccounts.js; wsl: wslAccounts.js.
// confirmStart(name) -> true when you said yes to starting a stopped WSL
// distro (a dialog in main).
// onPlans(): a WSL distro's Claude subscriptions were checked (in the
// background, after its scan answered): the window reads the places again.
export function createSignedInPlaces({ accounts, localSignIn = async () => null, localOthers = async () => [], hosts, connected = () => false, remoteAccounts, wsl = null, confirmStart = async () => false, now = Date.now, wslTtlMs = 60_000, planEveryMs = 4 * 60 * 60_000, onPlans = () => {} } = {}) {
  const wslScans = new Map() // name -> { at, place, entries, overrides }
  // name -> { at, dirs: Map(folder -> { sub, account }), pending }: its
  // Claude logins' subscriptions, asked by the distro itself (wsl.plans) in
  // the background after a check, when the last is older than planEveryMs,
  // or on a refresh (at most once a minute), one at a time.
  const wslPlans = new Map()
  // name -> { claude, codex, overrides }: what a distro's login shell said
  // (asked at its first check in this run, and when you ask for a refresh).
  const wslLogins = new Map()
  let distros = { at: 0, list: null, pending: null }

  async function pcPlace() {
    let entries = []
    try {
      entries = pcAccountRows(await accounts.list())
    } catch {
      /* this PC's accounts unreadable: the others still show */
    }
    for (const provider of LOCAL_SIGNINS) {
      try {
        const s = await localSignIn(provider)
        if (s && s.signedIn) entries.push(row({ agent: provider, scope: 'default', email: s.email, plan: s.planType, state: 'signed-in' }))
      } catch {
        /* not signed in there */
      }
    }
    try {
      for (const e of (await localOthers()) || []) entries.push(row({ ...e, state: e.state || 'signed-in' }))
    } catch {
      /* none */
    }
    return { id: 'pc', kind: 'pc', state: 'ready', at: now(), entries }
  }

  function sshPlace(target, value, state) {
    return {
      id: `ssh:${target.id}`,
      kind: 'ssh',
      hostId: target.id,
      label: text(target.label, 120) || target.id,
      state,
      at: value && value.ok ? value.at : null,
      entries: value && value.ok ? hostRows(value.entries, { actions: true, envOverrides: value.envOverrides }) : [],
      ...(value && value.ok && value.os ? { os: text(value.os, 40) } : {}),
      ...(value && !value.ok && value.error ? { error: text(value.error, 300) } : {})
    }
  }
  function targets() {
    try {
      return (hosts.list() || []).filter((h) => h && typeof h.id === 'string' && /^[\w-]{1,80}$/.test(h.id)).slice(0, 100)
    } catch {
      return []
    }
  }
  const isConnected = (hostId) => {
    try {
      return !!connected(hostId)
    } catch {
      return false
    }
  }

  async function distroList(fresh = false) {
    if (!wsl) return []
    if (!fresh && distros.list && now() - distros.at < wslTtlMs) return distros.list
    if (distros.pending) return distros.pending
    distros.pending = wsl
      .list()
      .then((r) => {
        distros = { at: now(), list: r && r.ok ? r.distros : [], pending: null }
        return distros.list
      })
      .catch(() => {
        distros = { at: now(), list: [], pending: null }
        return []
      })
    return distros.pending
  }
  function wslPlace(d, scanned) {
    if (scanned) return scanned
    return { id: `wsl:${d.name}`, kind: 'wsl', distro: d.name, label: d.name, state: d.running ? 'unknown' : 'stopped', at: null, entries: [] }
  }

  // Everything known now: this PC read, the rest from the last scans.
  async function places() {
    const pc = await pcPlace()
    const ssh = targets().map((target) => {
      const kept = remoteAccounts.cached(target.id)
      if (!isConnected(target.id)) return { ...sshPlace(target, kept, 'not-connected'), ...(kept ? { stale: true } : {}) }
      return sshPlace(target, kept, kept ? 'ready' : 'unknown')
    })
    const list = await distroList()
    const wslPlaces = list.map((d) => wslPlace(d, wslScans.get(d.name) && wslScans.get(d.name).place))
    return { ok: true, at: now(), places: [pc, ...wslPlaces, ...ssh] }
  }

  // One place checked now (fresh: not the last minute's answer; relogin: its
  // login shell asked again, a refresh you asked for; start: a stopped WSL
  // distro started, once you said yes here). -> its place
  async function scan(id, { fresh = false, relogin = false, start = false } = {}) {
    if (typeof id !== 'string' || !PLACE.test(id)) return { ok: false }
    if (id === 'pc') return { ok: true, place: await pcPlace() }
    if (id.startsWith('ssh:')) {
      const hostId = id.slice(4)
      const target = targets().find((h) => h.id === hostId)
      if (!target) return { ok: false }
      if (!isConnected(hostId)) return { ok: true, place: { ...sshPlace(target, remoteAccounts.cached(hostId), 'not-connected') } }
      const value = await remoteAccounts.detect(hostId, { fresh, relogin })
      // A refresh you asked for: its Claude subscriptions checked too, in the
      // background (the host asks Anthropic itself; at most once a minute);
      // their result reaches the window when it is there (onPlans).
      if (relogin && value && value.ok && typeof remoteAccounts.planCheck === 'function') {
        Promise.resolve()
          .then(() => remoteAccounts.planCheck(hostId, { force: true }))
          .catch(() => null)
      }
      return { ok: true, place: sshPlace(target, value, value && value.ok ? 'ready' : value && value.notConnected ? 'not-connected' : 'error') }
    }
    const name = id.slice(4)
    const d = (await distroList()).find((x) => x.name === name)
    if (!d || !wsl) return { ok: false }
    if (start && !d.running && !(await Promise.resolve().then(() => confirmStart(name)).then((v) => v === true, () => false)))
      return { ok: true, place: wslPlace(d, null) }
    const known = relogin ? null : wslLogins.get(name) || null
    const res = await wsl.scan(name, { start, dirs: known })
    if (res && res.ok && !known) wslLogins.set(name, { claude: res.loginEnv ? res.loginEnv.claude : null, codex: res.loginEnv ? res.loginEnv.codex : null, overrides: res.envOverrides || {} })
    const login = wslLogins.get(name)
    const place = res && res.ok
      ? { id, kind: 'wsl', distro: name, label: name, state: 'ready', at: now(), entries: hostRows(withWslPlans(name, res.entries), { envOverrides: login && login.overrides }), ...(res.os ? { os: text(res.os, 40) } : {}) }
      : { id, kind: 'wsl', distro: name, label: name, state: res && res.stopped ? 'stopped' : 'error', at: null, entries: [] }
    if (res && res.ok) {
      wslScans.set(name, { at: now(), place, entries: res.entries, overrides: login && login.overrides })
      wslPlanCheck(name, login, relogin)
    }
    else if (res && res.stopped) wslScans.delete(name)
    return { ok: true, place }
  }

  // -> the check in flight (a promise), or null when none was due.
  function wslPlanCheck(name, login, force) {
    if (!wsl || typeof wsl.plans !== 'function') return null
    const known = wslPlans.get(name)
    if (known && known.pending) return known.pending
    if (known && now() - known.at < (force ? 60_000 : planEveryMs)) return null
    const next = { at: now(), dirs: known ? known.dirs : new Map(), pending: null }
    wslPlans.set(name, next)
    next.pending = Promise.resolve()
      .then(() => wsl.plans(name, { claude: login ? login.claude : null }))
      .then((res) => {
        let found = 0
        // Never refreshed: a login not checked now keeps its last result.
        for (const e of (res && res.ok && res.entries) || []) {
          if (!e.sub) continue
          next.dirs.set(e.dir, { sub: e.sub, account: e.account })
          found++
        }
        if (!found) return
        // The distro's last scan, shown with them from now on.
        const scanned = wslScans.get(name)
        if (scanned && scanned.entries) scanned.place = { ...scanned.place, entries: hostRows(withWslPlans(name, scanned.entries), { envOverrides: scanned.overrides }) }
        try {
          onPlans(name)
        } catch {
          /* shown at the next check */
        }
      })
      .catch(() => {})
      .finally(() => {
        next.pending = null
      })
    return next.pending
  }
  function withWslPlans(name, entries) {
    const known = wslPlans.get(name)
    return (entries || []).map((e) => {
      const kept = e.agent === 'claude' && known ? known.dirs.get(e.dir) : null
      return kept && !(kept.account && e.account && kept.account !== e.account) ? { ...e, sub: kept.sub } : e
    })
  }

  return { places, scan, wslPlanCheck }
}
