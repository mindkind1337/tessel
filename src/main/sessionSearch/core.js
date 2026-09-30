// Session search: a full-text search over what was said in the agents'
// conversations, from a local index (store.js) filled in the background
// (indexer.js). Opt-in: nothing is read or indexed until the user turns it
// on; turning it off stops the indexing and keeps the index; clearing deletes
// it (never the agents' own files). The index stays in Tessel's data folder
// and is never sent anywhere. This is the part that runs in session search's
// own process (worker.js); the main process passes the window's requests
// (index.js). Background work: one slice of one file at a time on a timer,
// paused while the window is hidden, so it never takes more than part of
// one core, and never the window's.
// After Orca's src/main/ai-vault-search (session-search-service.ts,
// session-search-work-loop.ts, session-search-policy.ts), MIT, Copyright (c)
// 2026 Lovecast Inc.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { openStore, removeDatabase, sqliteAvailable } from './store.js'
import { indexNext, isTitleOnly, listSources } from './indexer.js'
import { maskSecrets } from '../../shared/maskSecrets.js'

export const HISTORY_DAYS = [30, 90, 365, 0] // 0: everything
const DEFAULT_POLICY = { enabled: false, historyDays: 90 }
const DAY = 24 * 60 * 60 * 1000

// A passage with its matches between [[ and ]]: each part masked, the marks kept.
export function maskSnippet(snippet) {
  return String(snippet || '')
    .split(/(\[\[|\]\])/)
    .map((part) => (part === '[[' || part === ']]' ? part : maskSecrets(part)))
    .join('')
}

export function createSessionSearchCore({
  dir,
  home = os.homedir(),
  // true while the window is hidden or minimized: the indexing waits.
  isPaused = () => false,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  // Between two slices; between two looks at the folders; while paused.
  sliceGapMs = 25,
  scanEveryMs = 60 * 1000,
  // The other agents' titles (their readers open more files): less often.
  titlesEveryMs = 10 * 60 * 1000,
  pausedRetryMs = 3000,
  log = null
} = {}) {
  const folder = join(dir, 'session-search')
  const dbPath = join(folder, 'index.sqlite')
  const policyPath = join(folder, 'policy.json')
  let policy = readPolicy()
  let store = null
  let timer = null
  let lastScan = 0
  let lastTitles = 0
  let sources = new Map()
  let closed = false

  function readPolicy() {
    try {
      const o = JSON.parse(fs.readFileSync(policyPath, 'utf8'))
      return { enabled: o.enabled === true, historyDays: HISTORY_DAYS.includes(o.historyDays) ? o.historyDays : DEFAULT_POLICY.historyDays }
    } catch {
      return { ...DEFAULT_POLICY }
    }
  }
  function writePolicy() {
    try {
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(policyPath, JSON.stringify(policy))
    } catch (err) {
      if (log) log.warn('sessionSearch', `policy not saved: ${err && err.message}`) // i18n-ignore
    }
  }

  function scan() {
    lastScan = now()
    const since = policy.historyDays ? lastScan - policy.historyDays * DAY : 0
    const withTitles = !lastTitles || lastScan - lastTitles >= titlesEveryMs
    if (withTitles) lastTitles = lastScan
    const list = listSources({ home, since, titles: withTitles })
    // Between two looks at the titles, the title-only sessions stay as they are.
    const kept = withTitles ? [] : [...sources.values()].filter((s) => isTitleOnly(s.path))
    sources = new Map([...list, ...kept].map((s) => [s.path, s]))
    store.transaction(() => {
      for (const s of list) store.noteFile(s)
      // Gone from the agent's folder, or older than what is kept: out of the index.
      for (const path of store.knownPaths()) if (!sources.has(path)) store.forgetFile(path)
    })
  }

  function stop() {
    if (timer) timers.clearTimeout(timer)
    timer = null
  }
  function schedule(ms) {
    stop()
    if (closed || !policy.enabled || !store) return
    timer = timers.setTimeout(tick, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }
  function tick() {
    timer = null
    if (closed || !policy.enabled || !store) return
    if (isPaused()) return schedule(pausedRetryMs)
    try {
      if (now() - lastScan >= scanEveryMs) scan()
      const more = indexNext(store, { sources })
      schedule(more ? sliceGapMs : scanEveryMs)
    } catch (err) {
      if (log) log.warn('sessionSearch', `indexing stopped for now: ${err && err.message}`) // i18n-ignore
      schedule(scanEveryMs)
    }
  }

  function start() {
    if (!policy.enabled || store || !sqliteAvailable()) return
    try {
      store = openStore(dbPath)
      lastScan = 0
      lastTitles = 0
      schedule(sliceGapMs)
    } catch (err) {
      store = null
      if (log) log.warn('sessionSearch', `index not opened: ${err && err.message}`) // i18n-ignore
    }
  }
  function closeStore() {
    stop()
    if (store) store.close()
    store = null
  }

  function sizeBytes() {
    let n = 0
    for (const suffix of ['', '-wal']) {
      try {
        n += fs.statSync(dbPath + suffix).size
      } catch {
        // not there
      }
    }
    return n
  }

  const api = {
    status() {
      const base = { available: sqliteAvailable(), enabled: policy.enabled, historyDays: policy.historyDays, sizeBytes: sizeBytes() }
      if (!store) return { ...base, phase: 'idle', filesIndexed: 0, filesDue: 0, filesFailed: 0, sessions: 0 }
      const c = store.counts()
      return { ...base, ...c, phase: c.filesDue > 0 ? (isPaused() ? 'paused' : 'indexing') : 'current' }
    },
    enable() {
      if (!sqliteAvailable()) return { ok: false, code: 'unavailable' }
      policy = { ...policy, enabled: true }
      writePolicy()
      start()
      return { ok: !!store, ...(store ? {} : { code: 'unavailable' }) }
    },
    // Stops the indexing; the index stays (clear() deletes it).
    disable() {
      policy = { ...policy, enabled: false }
      writePolicy()
      closeStore()
      return { ok: true }
    },
    setHistoryDays(days) {
      if (!HISTORY_DAYS.includes(days)) return { ok: false, code: 'invalid' }
      policy = { ...policy, historyDays: days }
      writePolicy()
      lastScan = 0
      if (store) schedule(sliceGapMs)
      return { ok: true }
    },
    // Deletes the index (a copy: the agents' own files are never touched).
    clear() {
      closeStore()
      removeDatabase(dbPath)
      start()
      return { ok: true }
    },
    search(q) {
      if (!policy.enabled) return { ok: false, code: 'disabled' }
      if (!store) return { ok: false, code: 'unavailable' }
      const o = q && typeof q === 'object' ? q : {}
      const scope = o.scope && typeof o.scope === 'object' ? { kind: ['folder', 'project', 'all'].includes(o.scope.kind) ? o.scope.kind : 'all', path: typeof o.scope.path === 'string' ? o.scope.path.slice(0, 1024) : '' } : { kind: 'all' }
      const agents = Array.isArray(o.agents) ? o.agents.filter((a) => typeof a === 'string' && /^[a-z0-9-]{1,32}$/.test(a)).slice(0, 32) : null
      const started = now()
      try {
        const res = store.search({ query: typeof o.query === 'string' ? o.query : '', scope, agents, limit: o.limit })
        // Secrets are masked here, before anything leaves the main process
        // (the index itself holds the text as the agents wrote it).
        const hits = res.hits.map((h) => ({
          ...h,
          title: maskSecrets(h.title),
          evidence: h.evidence ? { ...h.evidence, snippet: maskSnippet(h.evidence.snippet) } : null
        }))
        return { ok: true, ...res, hits, durationMs: now() - started }
      } catch (err) {
        if (log) log.warn('sessionSearch', `search failed: ${err && err.message}`) // i18n-ignore
        return { ok: false, code: 'failed' }
      }
    },
    // Tests and quitting.
    runOnce() {
      if (!store) return false
      if (!lastScan || now() - lastScan >= scanEveryMs) scan()
      return indexNext(store, { sources })
    },
    close() {
      closed = true
      closeStore()
    }
  }
  start()
  return api
}
