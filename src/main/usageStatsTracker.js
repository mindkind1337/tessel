// Local lifetime counters, inspired by Orca's StatsCollector and hook transition
// recorder (MIT, Lovecast Inc., 2026). Replayed states never mint agent starts.
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const initial = () => ({
  version: 1,
  totalAgentsSpawned: 0,
  totalAgentTimeMs: 0,
  totalPRsCreated: 0,
  firstEventAt: null,
  countedPRs: []
})
const nonnegative = (n) => Number.isSafeInteger(n) && n >= 0
const valid = (x) =>
  x?.version === 1 &&
  ['totalAgentsSpawned', 'totalAgentTimeMs', 'totalPRsCreated'].every((k) => nonnegative(x[k])) &&
  (x.firstEventAt === null || nonnegative(x.firstEventAt)) &&
  Array.isArray(x.countedPRs) &&
  x.countedPRs.length <= 5000 &&
  x.countedPRs.every((k) => /^[a-f0-9]{64}$/.test(k))

export function createUsageStatsTracker({ file, now = Date.now, saveDelay = 1000 }) {
  const startedAt = now()
  let data = initial(),
    failed = false,
    writeFailed = false,
    suspended = false,
    disposed = false,
    timer = null
  let queue = Promise.resolve()
  let awakeSince = startedAt
  const panes = new Map()
  const ready = (async () => {
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
        throw Error('Invalid statistics')
      const value = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!valid(value)) throw Error('Invalid statistics')
      data = value
    } catch (error) {
      if (error.code !== 'ENOENT') failed = true
    }
  })()
  const first = (at) => {
    data.firstEventAt ??= at
  }
  function tick(pane, at) {
    if (!pane.open) return
    if (!suspended) {
      const delta = Math.max(0, at - pane.since)
      data.totalAgentTimeMs += delta
      pane.credited += delta
    } else {
      pane.segmentStart = at
      pane.credited = 0
    }
    pane.since = Math.max(pane.since, at)
  }
  function checkpoint(at) {
    for (const pane of panes.values()) tick(pane, at)
  }
  function stopClock(pane, at) {
    if (!pane.open) return
    // An IPC/spool completion may arrive after a summary checkpoint already
    // credited some time. Correct only this open segment, never older work.
    const edge = Math.max(pane.segmentStart, at)
    if (!suspended && edge < pane.since)
      data.totalAgentTimeMs -= Math.min(pane.credited, pane.since - edge)
    else tick(pane, edge)
    pane.open = false
  }
  function openClock(pane, at) {
    pane.open = true
    pane.since = at
    pane.segmentStart = at
    pane.credited = 0
  }
  async function save() {
    if (failed) return
    checkpoint(now())
    const payload = JSON.stringify(data)
    queue = queue
      .catch(() => {})
      .then(async () => {
        const temporary = join(dirname(file), `.stats-${randomUUID()}.tmp`)
        try {
          await fs.mkdir(dirname(file), { recursive: true })
          await fs.writeFile(temporary, payload, { flag: 'wx', mode: 0o600 })
          await fs.rename(temporary, file)
          writeFailed = false
        } catch {
          writeFailed = true
        } finally {
          await fs.unlink(temporary).catch(() => {})
        }
      })
    await queue
  }
  function schedule() {
    if (timer || disposed || failed) return
    timer = setTimeout(() => {
      timer = null
      void ready.then(save)
    }, saveDelay)
    timer.unref?.()
  }
  return {
    async observe(snapshot) {
      await ready
      if (failed || disposed || !snapshot || typeof snapshot !== 'object') return
      const at = now(),
        seen = new Set()
      for (const [id, row] of Object.entries(snapshot).slice(0, 1000)) {
        if (!row || typeof row.launchToken !== 'string') continue
        const key = `${id}:${row.launchToken}`
        seen.add(key)
        const scopes = [row, ...(Array.isArray(row.children) ? row.children : [])]
        const scopeKey = (s) => `${s.agentId || 'main'}:${s.since}`
        const working = scopes.filter((s) => s.state === 'working' && s.hookSeen === true)
        const unknown = scopes.filter((s) => s.state === 'unknown' && s.hookSeen === true)
        const live = working.filter(
          (s) =>
            s.confirmed === true &&
            !s.stale &&
            s.source === 'hook' &&
            nonnegative(s.since) &&
            nonnegative(s.observedAt) &&
            s.since <= at &&
            s.observedAt <= at &&
            s.observedAt >= startedAt
        )
        const previous = panes.get(key)
        const pane = previous || {
          executing: false,
          counted: false,
          historical: false,
          uncertain: false,
          epochs: [],
          open: false,
          since: at,
          segmentStart: at,
          credited: 0
        }
        if (working.length) {
          const epochs = working.map(scopeKey)
          // A fresh execution after a restored idle/approval has a new since;
          // a same-episode tool hook after stale/reload keeps the old one.
          const newAfterUnknown =
            pane.uncertain && !epochs.some((epoch) => pane.epochs.includes(epoch))
          const continued = pane.executing && !newAfterUnknown
          if (!continued) {
            stopClock(pane, at)
            pane.counted = false
            pane.historical = working.every(
              (s) =>
                !nonnegative(s.since) ||
                s.since < startedAt ||
                s.observedAt < startedAt ||
                s.confirmed !== true
            )
          }
          const eligible = live.filter((s) => s.since >= startedAt)
          if (!pane.counted && !pane.historical && eligible.length && !suspended) {
            data.totalAgentsSpawned++
            pane.counted = true
            first(Math.max(awakeSince, Math.min(...eligible.map((s) => s.observedAt))))
          }
          if (pane.counted && live.length) {
            if (!pane.open && !suspended)
              openClock(pane, Math.max(awakeSince, Math.min(...live.map((s) => s.observedAt))))
            tick(pane, at)
          } else stopClock(pane, at)
          pane.executing = pane.counted || pane.historical || live.length > 0
          pane.uncertain = false
          pane.epochs = epochs
        } else if (unknown.length) {
          stopClock(pane, at)
          // Public restored/stale states intentionally say unknown. Preserve
          // their episode identity without treating them as a fresh idle edge.
          if (!previous) pane.historical = true
          pane.executing = true
          pane.uncertain = true
          pane.epochs = unknown.map(scopeKey)
        } else {
          const ends = scopes
            .filter(
              (s) =>
                s.confirmed &&
                s.state !== 'unknown' &&
                s.state !== 'working' &&
                nonnegative(s.since) &&
                s.since <= at
            )
            .map((s) => s.since)
          stopClock(pane, ends.length ? Math.max(...ends) : at)
          pane.executing = false
          pane.counted = false
          pane.historical = false
          pane.uncertain = false
          pane.epochs = []
        }
        panes.set(key, pane)
      }
      for (const [key, pane] of panes)
        if (!seen.has(key)) {
          stopClock(pane, at)
          panes.delete(key)
        }
      schedule()
    },
    async prCreated(url) {
      await ready
      if (failed || disposed || typeof url !== 'string' || url.length > 2048) return
      let parsed
      try {
        parsed = new URL(url)
      } catch {
        return
      }
      if (
        parsed.protocol !== 'https:' ||
        !/^\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(parsed.pathname)
      )
        return
      const key = createHash('sha256')
        .update(parsed.origin.toLowerCase() + parsed.pathname.replace(/\/$/, ''))
        .digest('hex')
      if (data.countedPRs.includes(key)) return
      data.countedPRs.push(key)
      data.countedPRs = data.countedPRs.slice(-5000)
      data.totalPRsCreated++
      first(now())
      schedule()
    },
    async summary() {
      await ready
      if (failed)
        return {
          ok: false,
          error: 'Saved activity statistics could not be read. They were preserved.'
        }
      checkpoint(now())
      schedule()
      const { version, countedPRs, ...summary } = data
      return {
        ok: true,
        ...summary,
        ...(writeFailed ? { warning: 'Activity statistics could not be saved yet.' } : {})
      }
    },
    async suspend() {
      await ready
      checkpoint(now())
      suspended = true
      await save()
    },
    async resume() {
      await ready
      checkpoint(now())
      awakeSince = now()
      suspended = false
    },
    async close() {
      await ready
      disposed = true
      clearTimeout(timer)
      timer = null
      await save()
      panes.clear()
    }
  }
}
