// Each Claude account's subscription as Anthropic reports it now, checked
// with the account's own login (providerUsage.js claudeProfile: the same
// token path, checks and request rules as its usage read), for the system's
// login and each account added in Tessel. The plan Claude Code wrote into
// its login file at sign-in is never updated when a subscription ends: a
// canceled Max still says "max" there, so the answer checked here wins
// wherever a plan is shown (accounts.list() carries it as `subscription`).
//
// - Checked when Settings > AI provider accounts opens (at most once a
//   minute), a couple of minutes after startup, every few hours, and at once
//   when Claude's usage is refused with no usage limits for the account.
// - A login is never refreshed: an expired one (or any failure) keeps the
//   last result, which says when it was checked.
// - Kept per account in userData (claude-plans.json): only the fields
//   claudeSubscription.js keeps, when they were checked, and the account's
//   email as an HMAC with a random key of this install (claude-plans.key,
//   beside it), so a later sign-in to another account in the same folder
//   does not inherit them and the file names nobody. Never a token, an email
//   or a payment link.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { cleanSubscription, subscriptionPlan, subscriptionState, SUBSCRIPTION_FIELDS } from '../shared/claudeSubscription'

const VERSION = 1
const FILE_LIMIT = 256 * 1024
const MAX_ACCOUNTS = 30
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000
// After startup has settled (a startup-idle signal can replace this delay).
export const STARTUP_DELAY_MS = 2 * 60 * 1000
// The page opened again within this reuses the last check; a forced one
// (after a sign-in) still waits this little.
export const MIN_GAP_MS = 60 * 1000
export const FORCE_GAP_MS = 10 * 1000
// A usage refusal checks the plan again unless it was tried this recently.
export const REFUSAL_GAP_MS = 10 * 60 * 1000
const KEY = /^(system|[A-Za-z0-9_-]{1,100})$/
const WHO = /^[0-9a-f]{32}$/
const SECRET = /^[0-9a-f]{64}$/
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const keyOf = (accountId) => (accountId === null || accountId === undefined ? 'system' : accountId)

// What an account's email is kept as: an HMAC with this install's key (never
// the email itself, nor a plain hash anyone could match to an address).
export function emailKey(email, secret) {
  if (typeof email !== 'string' || !email.trim() || typeof secret !== 'string' || !SECRET.test(secret)) return null
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(email.trim().toLowerCase()).digest('hex').slice(0, 32)
}
const sameFields = (a, b) => !!a && !!b && SUBSCRIPTION_FIELDS.every((k) => a[k] === b[k])

// accounts: providerAccounts.js (list); usage: providerUsage.js
// (claudeProfile); onChange(): a result changed (the window reads the
// accounts again).
export function createClaudePlanCheck({
  file,
  accounts,
  usage,
  clock = Date.now,
  log = null,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  everyMs = CHECK_EVERY_MS,
  startDelayMs = STARTUP_DELAY_MS,
  onChange = () => {}
} = {}) {
  // key ('system' | account id) -> { sub, who, triedAt, failure }
  const kept = new Map()
  const secretFile = path.join(path.dirname(file), 'claude-plans.key')
  // This install's key for emailKey (claude-plans.key), made at first use.
  let secret = null
  let loading = null
  let running = null
  let lastRun = 0
  let saving = Promise.resolve()
  const single = new Map()
  let startTimer = null
  let everyTimer = null

  async function loadSecret() {
    try {
      const value = (await fs.readFile(secretFile, 'utf8')).trim()
      if (SECRET.test(value)) return value
    } catch {
      /* made below */
    }
    const made = randomBytes(32).toString('hex')
    try {
      await fs.mkdir(path.dirname(secretFile), { recursive: true })
      await fs.writeFile(secretFile, `${made}\n`, { mode: 0o600 })
    } catch {
      // Not kept: this run's results match no account after a restart (they
      // are checked again then).
    }
    return made
  }
  const whoOf = (email) => emailKey(email, secret)
  function load() {
    loading ??= (async () => {
      secret = await loadSecret()
      try {
        const stat = await fs.stat(file)
        if (!stat.isFile() || stat.size > FILE_LIMIT) return
        const value = JSON.parse(await fs.readFile(file, 'utf8'))
        if (value?.version !== VERSION || !object(value.accounts)) return
        for (const [key, entry] of Object.entries(value.accounts).slice(0, MAX_ACCOUNTS)) {
          const sub = KEY.test(key) ? cleanSubscription(entry) : null
          // A result whose account cannot be told (an older or edited file)
          // is dropped: checked again rather than shown for anyone.
          if (entry?.who !== undefined && !WHO.test(entry.who)) continue
          if (sub && !kept.has(key)) kept.set(key, { sub, who: entry.who ?? null })
        }
      } catch {
        /* none kept yet, or unreadable: checked again */
      }
    })()
    return loading
  }
  function save() {
    const out = {}
    for (const [key, entry] of kept) if (entry.sub) out[key] = { ...entry.sub, ...(entry.who ? { who: entry.who } : {}) }
    const body = `${JSON.stringify({ version: VERSION, accounts: out }, null, 2)}\n`
    saving = saving.then(async () => {
      const temporary = `${file}.${process.pid}.tmp`
      try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(temporary, body, { mode: 0o600 })
        await fs.rename(temporary, file)
      } catch {
        await fs.rm(temporary, { force: true }).catch(() => {})
        log?.warn?.('plans', 'Claude plan results could not be saved') // i18n-ignore log
      }
    })
    return saving
  }
  const changed = () => {
    try {
      onChange()
    } catch {
      /* the window reads them at its next opening */
    }
  }

  // The Claude accounts signed in now: [{ accountId }], and every account
  // id Tessel knows (a removed account's result is dropped).
  async function targets() {
    const state = await accounts.list()
    const row = state?.ok ? state.providers?.find((p) => p?.provider === 'claude') : null
    if (!row || row.error) return null
    const ready = []
    if (row.system?.status === 'ready') ready.push({ accountId: null })
    const known = new Set(['system'])
    for (const a of row.accounts || []) {
      if (!a || typeof a.id !== 'string' || !KEY.test(a.id)) continue
      known.add(a.id)
      if (a.status === 'ready') ready.push({ accountId: a.id })
    }
    return { ready: ready.slice(0, MAX_ACCOUNTS), known }
  }

  // -> { ok, changed }
  async function checkOne(accountId) {
    const key = keyOf(accountId)
    let res
    try {
      await load()
      res = await usage.claudeProfile({ accountId, whoOf })
    } catch {
      res = null
    }
    const before = kept.get(key) || {}
    const sub = res?.ok ? cleanSubscription({ ...res.subscription, checkedAt: clock() }) : null
    if (sub) {
      kept.set(key, { sub, who: WHO.test(res.who) ? res.who : null })
      return { ok: true, changed: !sameFields(before.sub, sub) }
    }
    // Never refreshed here: the last result stays, with when it was checked.
    kept.set(key, { ...before, triedAt: clock(), failure: res?.expired ? 'expired' : typeof res?.code === 'string' ? res.code : 'network' })
    return { ok: false, changed: false }
  }

  // Every signed-in account, one after the other (a few at most). force: a
  // check asked for after a sign-in (or by the timers): past the minute's gap.
  function checkAll({ force = false } = {}) {
    if (running) return running
    const gap = force ? FORCE_GAP_MS : MIN_GAP_MS
    if (lastRun && clock() - lastRun < gap) return load().then(() => ({ ok: true, checked: 0 }))
    running = (async () => {
      await load()
      lastRun = clock()
      const list = await targets().catch(() => null)
      if (!list) return { ok: false, checked: 0 }
      let checked = 0
      let failed = 0
      let different = false
      for (const { accountId } of list.ready) {
        const r = await checkOne(accountId)
        if (r.ok) checked++
        else failed++
        different ||= r.changed
      }
      for (const key of [...kept.keys()]) {
        if (!list.known.has(key)) {
          kept.delete(key)
          different = true
        }
      }
      if (checked || different) await save()
      if (checked || different) changed()
      if (list.ready.length) log?.info?.('plans', `Claude plan check: ${checked} read, ${failed} kept as last checked`) // i18n-ignore log
      return { ok: true, checked }
    })().finally(() => {
      running = null
    })
    return running
  }

  // Claude's usage was refused with no usage limits for that account: it is
  // checked again now (whether it has a subscription), unless its last
  // result already says it has none (then at the usual pace) or it was
  // tried a moment ago.
  function noSubscription(accountId) {
    const key = keyOf(accountId)
    if (!KEY.test(key) || single.has(key)) return
    const job = (async () => {
      await load()
      const entry = kept.get(key)
      const state = entry?.sub ? subscriptionState(entry.sub, clock()) : null
      const last = Math.max(entry?.sub?.checkedAt || 0, entry?.triedAt || 0)
      if (state?.warn && clock() - last < everyMs) return
      if (clock() - last < REFUSAL_GAP_MS) return
      const r = await checkOne(accountId)
      if (r.ok) {
        await save()
        changed()
      }
    })()
      .catch(() => {})
      .finally(() => single.delete(key))
    single.set(key, job)
  }

  // accounts.list() with each Claude account's last checked subscription
  // (`subscription`), when it is the same account (its email's hash).
  async function decorate(list) {
    if (!list?.ok || !Array.isArray(list.providers)) return list
    await load()
    const attach = (row, key) => {
      const entry = row ? kept.get(key) : null
      if (!entry?.sub) return row
      if (entry.who && row.email && whoOf(row.email) !== entry.who) return row
      return { ...row, subscription: { ...entry.sub } }
    }
    return {
      ...list,
      providers: list.providers.map((p) =>
        p?.provider !== 'claude' || p.error
          ? p
          : {
              ...p,
              system: attach(p.system, 'system'),
              accounts: Array.isArray(p.accounts) ? p.accounts.map((a) => (a && typeof a.id === 'string' ? attach(a, a.id) : a)) : p.accounts
            }
      )
    }
  }

  // The plan's name for providerUsage's livePlan ("Ultra", "Free").
  function planOf(accountId) {
    const entry = kept.get(keyOf(accountId))
    return entry?.sub ? subscriptionPlan(entry.sub) || undefined : undefined
  }

  function start() {
    if (startTimer || everyTimer) return
    const run = () => checkAll({ force: true }).catch(() => {})
    startTimer = timers.setTimeout(() => {
      startTimer = null
      run()
      everyTimer = timers.setInterval(run, everyMs)
      everyTimer?.unref?.()
    }, startDelayMs)
    startTimer?.unref?.()
  }
  function stop() {
    if (startTimer) timers.clearTimeout(startTimer)
    if (everyTimer) timers.clearInterval(everyTimer)
    startTimer = everyTimer = null
  }

  return { checkAll, noSubscription, decorate, planOf, start, stop, load, saved: () => saving }
}
