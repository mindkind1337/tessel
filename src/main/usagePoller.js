// Automatic usage refresh: the toolbar's quota icon stays current without a click.
// After Orca's src/main/rate-limits/service/service-polling.ts, service-types.ts,
// service-fetch-policy.ts and service-result-policy.ts, MIT, Copyright (c) 2026
// Lovecast Inc.
//
// - A poll every 2 min (Settings can change or turn it off), only while the main
//   window is visible, not minimized and focused. A poll reads a provider whose
//   last attempt is older than the interval (less a few seconds of timer slack).
// - On focus, show or restore: a refresh of the providers whose reading is older
//   than 5 min.
// - Once shortly after startup, even when the window is shown but not focused
//   yet (not while it is hidden or minimized: then at its first show or focus).
// - Live readings: the rate-limit windows a running chat reports (Claude's
//   rate_limit_event, Codex's account/rateLimits/updated) update the shown
//   reading without a request (ingest). Deduped at 30 s, never over a newer
//   reading; a fresh one lets the scheduled Claude read wait (its usage
//   endpoint has a tight budget) when it covers every window shown.
// - A failed provider waits 30 s, then twice as long after each failure (at most
//   15 min); a 429's Retry-After is respected.
// - A recent reading is kept (marked stale) through failures: 30 min, or 24 h when
//   the service is rate-limiting.
// - Never two reads of one provider at once: a request for a provider already
//   being read shares that read.
// Tokens are never seen here: the readers take them at call time.

export const DEFAULT_POLL_MS = 2 * 60 * 1000
// Renderer input can never make a tight loop.
export const MIN_POLL_MS = 30 * 1000
// The longest delay setInterval accepts before Node clamps it to 1 ms.
export const MAX_POLL_MS = 2_147_483_647
// Debounces focus bursts and a manual refresh made just before.
export const MIN_REFETCH_MS = 5 * 60 * 1000
export const ACTIVE_FAILURE_REFETCH_MS = MIN_POLL_MS
export const MAX_ACTIVE_FAILURE_REFETCH_MS = 15 * 60 * 1000
// setInterval fires a little late or early: a poll still reads a provider last
// read one interval ago.
export const POLL_SLACK_MS = 5 * 1000
// A live reading identical to one taken less than this ago is not pushed again.
export const LIVE_INGEST_DEDUPE_MS = 30 * 1000
export const MAX_ACTIVE_FAILURE_STREAK = 8
export const STALE_THRESHOLD_MS = 30 * 60 * 1000
// A 429 window can outlast the usual threshold; a stale reading beats nothing.
export const RATE_LIMITED_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000
export const DEFERRED_STARTUP_ACTIVE_REFRESH_MS = 1000
// A Retry-After further than this is treated as this (a day).
const MAX_RETRY_AFTER_MS = RATE_LIMITED_STALE_THRESHOLD_MS

export function normalizePollingInterval(ms) {
  if (!Number.isFinite(ms)) return DEFAULT_POLL_MS
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, ms))
}

// A Retry-After header (seconds, or an HTTP date) in ms from now; null without one.
export function retryAfterMs(headers, now = Date.now()) {
  let raw
  try {
    raw = headers?.get?.('retry-after')
  } catch {
    return null
  }
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 100) return null
  const value = raw.trim()
  let ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  if (!Number.isFinite(ms)) return null
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms))
}

export function failureBackoffMs(streak) {
  return Math.min(
    ACTIVE_FAILURE_REFETCH_MS * 2 ** Math.max(0, streak - 1),
    MAX_ACTIVE_FAILURE_REFETCH_MS
  )
}

const hasWindows = (result) => Array.isArray(result?.windows) && result.windows.length > 0

// The windows a live session reports, under the labels providerUsage.js gives
// the same windows from the usage endpoint.
const LIVE_WINDOWS = [
  ['fiveHour', '5-hour'],
  ['sevenDay', 'Weekly']
]
const LIVE_LABELS = new Set(LIVE_WINDOWS.map(([, label]) => label))
const MAX_TIME_MS = 8.64e15

// utilization: 0..1 (Claude's rate_limit_event, codexChat's mapping) or 0..100;
// resetsAt: seconds or ms since the epoch. null when it is not a usable window.
export function liveWindow(label, raw) {
  if (!raw || typeof raw !== 'object') return null
  const u = raw.utilization
  if (typeof u !== 'number' || !Number.isFinite(u) || u < 0 || u > 100) return null
  const usedPct = u <= 1 ? u * 100 : u
  let resetsAt = null
  const r = raw.resetsAt
  if (typeof r === 'number' && Number.isFinite(r) && r > 0) {
    const ms = r < 10_000_000_000 ? r * 1000 : r
    if (ms <= MAX_TIME_MS) resetsAt = Math.round(ms)
  }
  return { label, usedPct: Math.round(usedPct * 100) / 100, resetsAt }
}

export function liveWindows(rateLimit) {
  if (!rateLimit || typeof rateLimit !== 'object') return []
  return LIVE_WINDOWS.map(([key, label]) => liveWindow(label, rateLimit[key])).filter(Boolean)
}

const sameWindows = (a, b) =>
  a.length === b.length &&
  a.every((w, i) => {
    const o = b[i]
    return (
      !!o &&
      w.label === o.label &&
      w.usedPct === o.usedPct &&
      (w.resetsAt ?? null) === (o.resetsAt ?? null) &&
      !w.stale === !o.stale
    )
  })

// read(query) -> result; targets(hidden) -> [{ provider, accountId }] (the providers
// the user shows and has signed in to); send(result) pushes to the renderer.
export function createUsagePoller({
  read,
  targets,
  send,
  getWindow = () => null,
  clock = Date.now,
  timers = globalThis,
  log
} = {}) {
  const state = new Map() // provider -> { accountId, status, snapshot, updatedAt, attemptAt, streak, retryAtMs }
  const inflight = new Map() // provider -> { accountId, promise }
  let pollMs = DEFAULT_POLL_MS
  let enabled = true
  let hidden = []
  let configured = false
  let timer = null
  let startupTimer = null
  let startupPending = false
  let attached = null // { win, off }

  function windowActive() {
    const win = attached?.win
    if (!win || win.isDestroyed?.()) return false
    // These reads only feed the interface: none while it is hidden or not in use.
    if (!win.isVisible() || win.isMinimized()) return false
    return win.isFocused()
  }

  const blank = (accountId) => ({
    accountId,
    status: null,
    snapshot: null,
    updatedAt: 0,
    attemptAt: 0,
    streak: 0,
    retryAtMs: 0,
    liveAt: 0
  })

  function record(provider, accountId, result) {
    if (!result || typeof result !== 'object' || result.code === 'stale') return null
    const now = clock()
    let entry = state.get(provider)
    if (!entry || entry.accountId !== accountId)
      entry = blank(accountId)
    entry.attemptAt = now
    if (result.ok) {
      Object.assign(entry, { status: 'ok', snapshot: result, updatedAt: now, streak: 0, retryAtMs: 0, liveAt: 0 })
    } else if (result.code === 'unavailable') {
      Object.assign(entry, { status: 'unavailable', snapshot: null, updatedAt: now, streak: 0, retryAtMs: 0, liveAt: 0 })
    } else {
      entry.status = 'error'
      entry.streak = Math.min(entry.streak + 1, MAX_ACTIVE_FAILURE_STREAK)
      // The server said when to come back: an earlier try only prolongs the 429.
      entry.retryAtMs = Number.isFinite(result.retryAfterMs) ? now + result.retryAfterMs : 0
    }
    state.set(provider, entry)
    return stalePolicy(entry, result, now)
  }

  // What the renderer is shown after a read.
  function stalePolicy(entry, result, now) {
    if (result.ok || result.code === 'unavailable') return result
    const previous = entry.snapshot
    if (!previous || !hasWindows(previous)) return result
    const threshold =
      result.code === 'rate-limited' ? RATE_LIMITED_STALE_THRESHOLD_MS : STALE_THRESHOLD_MS
    if (now - entry.updatedAt > threshold) return result
    // A live reading from the last minutes: still current, shown as it is.
    if (entry.liveAt && entry.liveAt === entry.updatedAt && now - entry.liveAt < MIN_REFETCH_MS)
      return previous
    // Keep the recent reading through failures so the icon does not flap to empty.
    const { resetToken: _token, ...kept } = previous
    return {
      ...kept,
      stale: true,
      kept: true,
      error: result.error,
      code: result.code
    }
  }

  // A live Claude reading from the last 5 min that covers every window shown:
  // the scheduled read waits (its usage endpoint answers 429 quickly).
  function liveCovers(provider, entry, now) {
    if (provider !== 'claude' || !entry.liveAt || now - entry.liveAt >= MIN_REFETCH_MS) return false
    const shown = entry.snapshot?.windows
    return Array.isArray(shown) && shown.every((w) => LIVE_LABELS.has(w?.label))
  }

  // reason 'poll': reads when the last attempt is one interval old; any other
  // reason (focus, show, startup): only after MIN_REFETCH_MS.
  function due(provider, accountId, now, reason) {
    if (inflight.has(provider)) return false
    const entry = state.get(provider)
    if (!entry || entry.accountId !== accountId) return true
    if (entry.retryAtMs > now) return false
    if (liveCovers(provider, entry, now)) return false
    if (!entry.attemptAt) return true
    if (entry.status === 'error') return now - entry.attemptAt >= failureBackoffMs(entry.streak)
    const wait = reason === 'poll' ? Math.max(0, pollMs - POLL_SLACK_MS) : MIN_REFETCH_MS
    return now - entry.attemptAt >= wait
  }

  // Rate-limit windows a running chat reported for this provider's shown
  // account (the caller checked the account). Pushed like a read's result.
  function ingest(provider, accountId, rateLimit, observedAt = clock()) {
    if (provider !== 'claude' && provider !== 'codex') return null
    if (accountId !== null && typeof accountId !== 'string') return null
    const fresh = liveWindows(rateLimit)
    if (!fresh.length) return null
    const now = clock()
    const at = Number.isFinite(observedAt) ? Math.min(observedAt, now) : now
    let entry = state.get(provider)
    if (!entry || entry.accountId !== accountId) entry = blank(accountId)
    // A newer reading (a read that ended after this event) is kept.
    if (entry.updatedAt > at) return null
    const previous = entry.snapshot && hasWindows(entry.snapshot) ? entry.snapshot : null
    // A window absent from the event is not cleared: the other readings stay.
    const kept = (previous?.windows || []).filter((w) => !fresh.some((f) => f.label === w.label))
    const merged = [...fresh, ...kept.filter((w) => LIVE_LABELS.has(w.label))]
    const order = (w) => {
      const i = LIVE_WINDOWS.findIndex(([, label]) => label === w.label)
      return i < 0 ? LIVE_WINDOWS.length : i
    }
    merged.sort((a, b) => order(a) - order(b))
    const windows = [...merged, ...kept.filter((w) => !LIVE_LABELS.has(w.label))]
    if (
      previous &&
      entry.liveAt &&
      at - entry.liveAt < LIVE_INGEST_DEDUPE_MS &&
      sameWindows(windows, previous.windows)
    )
      return null
    const snapshot = {
      ...(previous || {}),
      ok: true,
      provider,
      accountId,
      source: 'live',
      live: true,
      observedAt: at,
      windows
    }
    delete snapshot.stale
    delete snapshot.kept
    delete snapshot.error
    delete snapshot.code
    // The endpoint's Retry-After and failure streak stand: a live reading does
    // not make the next request welcome sooner.
    Object.assign(entry, { status: entry.status === 'error' ? 'error' : 'ok', snapshot, updatedAt: at, liveAt: at })
    state.set(provider, entry)
    try {
      send?.(snapshot)
    } catch {
      /* the window may be gone */
    }
    return snapshot
  }

  function run(provider, accountId, automatic) {
    const current = inflight.get(provider)
    if (current) {
      if (current.accountId === accountId) return current.promise.then(settle)
      if (automatic) return Promise.resolve(null)
      // Another account's read is ending (the switch made it stale): then this one.
      return current.promise.then(
        () => run(provider, accountId, false),
        () => run(provider, accountId, false)
      )
    }
    const promise = (async () => {
      let raw
      let thrown = null
      try {
        raw = await read({ provider, accountId })
      } catch (error) {
        // Its message may carry request details: never pushed, only rethrown to
        // the IPC handler, which answers with its own words.
        thrown = error instanceof Error ? error : new Error('usage read failed') // i18n-ignore
        raw = { ok: false, provider, accountId, code: 'network' }
      }
      const shown = record(provider, accountId, raw)
      return { raw, shown, thrown }
    })()
    const entry = { accountId, promise, automatic }
    inflight.set(provider, entry)
    promise.finally(() => {
      if (inflight.get(provider) === entry) inflight.delete(provider)
    })
    return promise.then((outcome) => {
      if (automatic) {
        if (outcome.shown) {
          try {
            send?.(outcome.shown)
          } catch {
            /* the window may be gone */
          }
        }
        return outcome.raw
      }
      return settle(outcome)
    })
  }
  // A manual read answers as it did before: its result, or its error.
  function settle({ raw, thrown }) {
    if (thrown) throw thrown
    return raw
  }

  // The startup read: the window shown (focused or not yet), not minimized.
  function windowShown() {
    const win = attached?.win
    if (!win || win.isDestroyed?.()) return false
    return win.isVisible() && !win.isMinimized()
  }

  async function refresh(reason) {
    if (!enabled || !configured) return
    if (reason === 'startup' ? !windowShown() : !windowActive()) {
      // Hidden or minimized at startup: its first show or focus reads.
      if (reason === 'startup') startupPending = true
      return
    }
    if (reason === 'startup') startupPending = false
    let list
    try {
      list = await targets(hidden)
    } catch {
      log?.warn?.('usage', `automatic refresh skipped (${reason}): providers unavailable`) // i18n-ignore
      return
    }
    const now = clock()
    await Promise.all(
      (Array.isArray(list) ? list : [])
        .filter((item) => item && due(item.provider, item.accountId ?? null, now, reason))
        .map((item) => run(item.provider, item.accountId ?? null, true))
    )
  }

  function stopTimer() {
    if (timer) timers.clearInterval(timer)
    timer = null
  }
  function startTimer() {
    stopTimer()
    if (!enabled || !configured || !attached) return
    timer = timers.setInterval(() => void refresh('poll'), pollMs)
    timer?.unref?.()
  }
  function clearStartup() {
    if (startupTimer) timers.clearTimeout(startupTimer)
    startupTimer = null
  }

  function detach() {
    if (!attached) return
    attached.off()
    attached = null
    stopTimer()
    clearStartup()
    startupPending = false
  }

  function attach(win) {
    if (!win || attached?.win === win) return
    detach()
    const onResume = () => void refresh(startupPending ? 'startup' : 'activate')
    const onClosed = () => detach()
    for (const name of ['focus', 'show', 'restore']) win.on(name, onResume)
    win.on('closed', onClosed)
    attached = {
      win,
      off() {
        for (const name of ['focus', 'show', 'restore']) win.removeListener(name, onResume)
        win.removeListener('closed', onClosed)
      }
    }
    startTimer()
  }

  return {
    // From the renderer: the providers it hides and the chosen interval (0 = off).
    configure({ hidden: nextHidden = [], intervalMs = DEFAULT_POLL_MS } = {}) {
      hidden = Array.isArray(nextHidden) ? nextHidden.filter((id) => typeof id === 'string') : []
      enabled = intervalMs !== 0 && intervalMs !== null
      pollMs = normalizePollingInterval(Number(intervalMs))
      const first = !configured
      configured = true
      const win = getWindow()
      if (win && !win.isDestroyed?.()) attach(win)
      startTimer()
      if (!enabled) {
        clearStartup()
        startupPending = false
      } else if (first && attached) {
        clearStartup()
        startupTimer = timers.setTimeout(() => {
          startupTimer = null
          void refresh('startup')
        }, DEFERRED_STARTUP_ACTIVE_REFRESH_MS)
      }
      return { ok: true, enabled, intervalMs: enabled ? pollMs : 0 }
    },
    // A read asked by the user: shares a read of the same provider in flight.
    read(query) {
      return run(query.provider, query.accountId ?? null, false)
    },
    // An account switch: its old reading must not be kept or reused.
    forget(provider) {
      if (provider === undefined) state.clear()
      else state.delete(provider)
    },
    ingest,
    attach,
    stop: detach,
    refresh,
    // For tests.
    get pollMs() {
      return enabled ? pollMs : 0
    },
    entry: (provider) => state.get(provider) || null
  }
}
