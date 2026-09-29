import fs from 'fs/promises'
import { randomUUID } from 'crypto'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path'
import {
  createAgentState,
  reduceAgentState,
  publicAgentState,
  validateAgentState
} from '../shared/agentStateModel'

const MAX_EVENT = 8192
const MAX_SNAPSHOT = 4 * 1024 * 1024
const MAX_PANES = 128
const MAX_SCAN = 128
const TTL = 24 * 60 * 60 * 1000
const RETAIN_STATE = 7 * TTL
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,175}\.json$/
const TEMP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,175}\.tmp$/
const HOOKS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Elicitation',
  'ElicitationResult'
])
// The hook events a chat pane's manager may report (recordChatEvent).
const CHAT_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'Interrupt'
])
const SCREENS = new Set([
  'ScreenReady',
  'ScreenApproval',
  'ScreenBusy',
  'ScreenLimit',
  'ScreenClearApproval'
])
const FIELDS = new Set([
  'v',
  'id',
  'paneId',
  'provider',
  'launchToken',
  'sessionId',
  'event',
  'at',
  'source',
  'agentId',
  'toolId',
  'turnId',
  'toolName',
  'notificationType',
  'startSource',
  'continuing'
])
const clone = (value) => JSON.parse(JSON.stringify(value))
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
const provider = (value) => value === 'codex' || value === 'claude'
const validId = (value) => typeof value === 'string' && ID.test(value) && !value.includes('..')
const eqPath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const errorCode = (error) => (typeof error?.code === 'string' ? error.code : 'unavailable')
const unconfirmed = (state) => ({
  ...state,
  confirmed: false,
  children: state.children.map((child) => ({ ...child, confirmed: false }))
})

async function checkPath(path, allowMissing = false) {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  const parts = relative(root, absolute).split(sep).filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i])
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return null
      throw error
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()))
      throw new Error('unsafe path')
    if (i === parts.length - 1) {
      if (!eqPath(resolve(await fs.realpath(current)), current)) throw new Error('unsafe path')
      return stat
    }
  }
  return fs.lstat(root)
}

async function directory(path) {
  const stat = await checkPath(path, true)
  if (stat) {
    if (!stat.isDirectory()) throw new Error('not a directory')
    return
  }
  await directory(dirname(resolve(path)))
  try {
    await fs.mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  if (!(await checkPath(path)).isDirectory()) throw new Error('not a directory')
}

async function readBounded(file, limit) {
  const before = await checkPath(file)
  if (!before.isFile() || before.size > limit)
    throw Object.assign(new Error('invalid size'), { code: 'ESIZE' })
  const handle = await fs.open(file, 'r')
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      before.ino !== opened.ino ||
      before.dev !== opened.dev ||
      before.size !== opened.size
    )
      throw new Error('changed file')
    const buffer = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await checkPath(file)
    if (
      offset !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error('changed file')
    return { text: buffer.subarray(0, offset).toString('utf8'), stat: before }
  } finally {
    await handle.close()
  }
}

function hookEvent(value, now) {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !FIELDS.has(key)) ||
    value.v !== 1 ||
    !validId(value.id) ||
    !validId(value.paneId) ||
    !validId(value.launchToken) ||
    !validId(value.sessionId) ||
    !provider(value.provider) ||
    value.source !== 'hook' ||
    !HOOKS.has(value.event) ||
    !Number.isSafeInteger(value.at) ||
    value.at < 0 ||
    value.at > now
  )
    return null
  for (const key of ['sessionId', 'agentId', 'toolId', 'turnId'])
    if (value[key] !== undefined && value[key] !== null && !validId(value[key])) return null
  for (const key of ['toolName', 'notificationType', 'startSource'])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(value[key]))
    )
      return null
  if (value.continuing !== undefined && typeof value.continuing !== 'boolean') return null
  return { ...value }
}

/** One app-owned consumer; callers schedule scans, never one timer per pane. */
export function createAgentStateStore({ dir, now = Date.now, onChange = () => {} }) {
  if (typeof dir !== 'string' || !isAbsolute(dir))
    throw new Error('An absolute agent-status directory is required.')
  const root = resolve(dir)
  const eventsDir = join(root, 'events')
  const stateFile = join(root, 'state.json')
  const clock = () => (typeof now === 'function' ? now() : now)
  const bootAt = clock()
  const active = new Map()
  const recovered = new Map()
  let warnings = [],
    loaded = false,
    dirty = false,
    disposed = false,
    closing = false
  let iterator = null,
    pending = Promise.resolve(),
    scanFlight = null,
    disposeFlight = null
  let lastPublished = ''

  const warn = (message) => {
    if (warnings.length < 24 && !warnings.includes(message)) warnings.push(message)
  }
  function publicSnapshot() {
    const result = {}
    for (const [paneId, item] of [...active].sort(([a], [b]) => a.localeCompare(b)))
      Object.defineProperty(result, paneId, {
        value: clone(publicAgentState(item.state, clock())),
        enumerable: true
      })
    return result
  }
  function publish() {
    const value = publicSnapshot()
    const encoded = JSON.stringify(value)
    if (encoded !== lastPublished) {
      lastPublished = encoded
      try {
        onChange(value)
      } catch {
        /* observer cannot lose events */
      }
    }
    return value
  }
  function serial(fn) {
    if (disposed || closing) return Promise.reject(new Error('Agent state store is disposed.'))
    const next = pending
      .catch(() => {})
      .then(() => {
        if (disposed) throw new Error('Agent state store is disposed.')
        return fn()
      })
    pending = next.catch(() => {})
    return next
  }
  async function load() {
    if (loaded) return true
    try {
      const raw = await readBounded(stateFile, MAX_SNAPSHOT)
      let value
      try {
        value = JSON.parse(raw.text)
      } catch {
        value = null
      }
      if (
        !record(value) ||
        value.v !== 1 ||
        !Array.isArray(value.states) ||
        value.states.length > MAX_PANES
      ) {
        warn('Invalid saved agent states were ignored; live evidence is required.')
      } else {
        for (const item of value.states) {
          if (
            !record(item) ||
            !validateAgentState(item.state) ||
            !validId(item.state.paneId) ||
            !validId(item.state.launchToken) ||
            !provider(item.state.provider) ||
            !Number.isFinite(item.savedAt) ||
            clock() - item.savedAt > RETAIN_STATE
          ) {
            warn('Invalid or expired saved agent state was ignored.')
            continue
          }
          const state = unconfirmed(item.state)
          const current = active.get(state.paneId)
          recovered.set(state.paneId, { state, savedAt: item.savedAt })
          if (
            current &&
            !current.observed &&
            current.state.launchToken === state.launchToken &&
            current.state.provider === state.provider
          ) {
            current.state = state
          }
        }
      }
      loaded = true
      return true
    } catch (error) {
      if (error.code === 'ENOENT') {
        loaded = true
        return true
      }
      warn(`Saved agent states cannot be read (${errorCode(error)}); events are retained.`)
      return false
    }
  }
  async function persist() {
    if (!dirty) return loaded
    if (!loaded) return false
    let temporary
    try {
      await directory(root)
      await checkPath(stateFile, true)
      const merged = new Map(recovered)
      for (const [id, item] of active) merged.set(id, { state: item.state, savedAt: clock() })
      const states = [...merged.values()]
        .filter((item) => clock() - item.savedAt <= RETAIN_STATE)
        .sort(
          (a, b) =>
            Number(active.has(b.state.paneId)) - Number(active.has(a.state.paneId)) ||
            b.savedAt - a.savedAt
        )
        .slice(0, MAX_PANES)
      const data = JSON.stringify({ v: 1, states })
      if (Buffer.byteLength(data) > MAX_SNAPSHOT) throw new Error('snapshot limit')
      temporary = join(root, `state-${randomUUID()}.tmp`)
      const file = await fs.open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(data, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await checkPath(stateFile, true)
      await fs.rename(temporary, stateFile)
      dirty = false
      return true
    } catch (error) {
      warn(`Agent states could not be saved (${errorCode(error)}); events are retained.`)
      return false
    } finally {
      if (temporary) await fs.unlink(temporary).catch(() => {})
    }
  }
  async function removeFile(file, before) {
    try {
      const current = await checkPath(file)
      if (
        !current.isFile() ||
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        current.size !== before.size ||
        current.mtimeMs !== before.mtimeMs
      )
        return false
      await fs.unlink(file)
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return true
      warn(`An agent event could not be removed (${errorCode(error)}).`)
      return false
    }
  }
  async function scanEvents() {
    warnings = []
    await load()
    const stats = { examined: 0, accepted: 0, deferred: 0, rejected: 0, removed: 0 }
    const removals = []
    const candidates = []
    try {
      await directory(eventsDir)
      if (!iterator) iterator = await fs.opendir(eventsDir)
      for (let i = 0; i < MAX_SCAN; i++) {
        const entry = await iterator.read()
        if (!entry) {
          await iterator.close()
          iterator = null
          break
        }
        stats.examined++
        if (
          TEMP.test(entry.name) &&
          !entry.name.includes('..') &&
          entry.isFile() &&
          !entry.isSymbolicLink()
        ) {
          const path = join(eventsDir, entry.name)
          try {
            const stat = await checkPath(path)
            if (stat.isFile() && clock() - stat.mtimeMs > TTL)
              removals.push({ path, stat, independent: true })
          } catch (error) {
            warn(`An unfinished agent event could not be inspected (${errorCode(error)}).`)
          }
          continue
        }
        if (
          !FILE.test(entry.name) ||
          entry.name.includes('..') ||
          !entry.isFile() ||
          entry.isSymbolicLink()
        ) {
          stats.rejected++
          warn('An unsupported agent event path was skipped.')
          continue
        }
        const path = join(eventsDir, entry.name)
        try {
          const raw = await readBounded(path, MAX_EVENT)
          let parsed
          try {
            parsed = JSON.parse(raw.text)
          } catch {
            parsed = null
          }
          const event = hookEvent(parsed, clock())
          if (!event || clock() - event.at > TTL || clock() - raw.stat.mtimeMs > TTL) {
            stats.rejected++
            removals.push({ path, stat: raw.stat, independent: true })
            warn('An invalid or expired agent event was discarded.')
          } else candidates.push({ event, path, stat: raw.stat })
        } catch (error) {
          stats.rejected++
          if (error.code === 'ESIZE') {
            try {
              const stat = await checkPath(path)
              if (stat.isFile()) removals.push({ path, stat, independent: true })
            } catch {
              /* changing source is left untouched */
            }
          }
          warn(`An agent event could not be read (${errorCode(error)}).`)
        }
      }
    } catch (error) {
      warn(`Agent event spool unavailable (${errorCode(error)}).`)
      if (iterator) {
        await iterator.close().catch(() => {})
        iterator = null
      }
    }
    candidates.sort((a, b) => a.event.at - b.event.at || a.event.id.localeCompare(b.event.id))
    for (const candidate of candidates) {
      const { event } = candidate
      const current = active.get(event.paneId)
      if (!current) {
        stats.deferred++
        continue
      }
      if (
        current.state.launchToken !== event.launchToken ||
        current.state.provider !== event.provider
      ) {
        stats.rejected++
        removals.push({ ...candidate, independent: true })
        continue
      }
      const before = current.state
      let next = reduceAgentState(before, event, clock())
      if (event.at < bootAt && next !== before) {
        // Historical evidence may revise an actor's state, but a later screen
        // observation cannot confirm that newly recovered state on its behalf.
        next = event.agentId
          ? {
              ...next,
              children: next.children.map((child) =>
                child.agentId === event.agentId ? { ...child, confirmed: false } : child
              )
            }
          : { ...next, confirmed: false }
      }
      if (JSON.stringify(next) !== JSON.stringify(before)) {
        current.state = next
        current.observed ||= event.at >= bootAt
        dirty = true
        stats.accepted++
      }
      removals.push(candidate)
    }
    const saved = await persist()
    for (const item of removals)
      if ((item.independent || saved) && (await removeFile(item.path, item.stat))) stats.removed++
    return { states: publish(), warnings: [...warnings], stats }
  }
  return {
    register: (registration) =>
      serial(async () => {
        await load()
        const { paneId, provider: kind, launchToken, startedAt = clock() } = registration || {}
        if (
          !validId(paneId) ||
          !validId(launchToken) ||
          !provider(kind) ||
          !Number.isSafeInteger(startedAt) ||
          startedAt < 0
        )
          throw new Error('Invalid agent registration.')
        const prior = active.get(paneId)
        if (prior && prior.state.launchToken === launchToken && prior.state.provider === kind)
          return publish()
        if (!prior && active.size >= MAX_PANES) throw new Error('Too many registered agent states.')
        const saved = recovered.get(paneId)
        const state =
          saved?.state.launchToken === launchToken && saved.state.provider === kind
            ? unconfirmed(saved.state)
            : createAgentState({ paneId, provider: kind, launchToken, startedAt })
        active.set(paneId, { state, observed: false })
        dirty = true
        await persist()
        return publish()
      }),
    unregister: (paneId, token = undefined) =>
      serial(async () => {
        const current = active.get(paneId)
        if (!current || (token !== undefined && token !== current.state.launchToken))
          return publish()
        current.state = reduceAgentState(
          current.state,
          {
            v: 1,
            id: randomUUID(),
            paneId,
            provider: current.state.provider,
            launchToken: current.state.launchToken,
            event: 'PtyExit',
            at: clock(),
            source: 'lifecycle',
            sessionId: current.state.sessionId
          },
          clock()
        )
        publish()
        active.delete(paneId)
        recovered.delete(paneId)
        dirty = true
        await persist()
        return publish()
      }),
    scan: () => {
      if (!scanFlight)
        scanFlight = serial(scanEvents).finally(() => {
          scanFlight = null
        })
      return scanFlight
    },
    observe: (paneId, token, screenEvent) =>
      serial(async () => {
        const current = active.get(paneId)
        const eventName = typeof screenEvent === 'string' ? screenEvent : screenEvent?.event
        if (!current || current.state.launchToken !== token || !SCREENS.has(eventName))
          return publish()
        const event = {
          v: 1,
          id: randomUUID(),
          paneId,
          provider: current.state.provider,
          launchToken: token,
          event: eventName,
          source: 'screen',
          at: clock(),
          sessionId: current.state.sessionId
        }
        if (
          eventName === 'ScreenLimit' &&
          ((typeof screenEvent?.reset === 'string' && screenEvent.reset.length <= 160) ||
            (Number.isFinite(screenEvent?.reset) && screenEvent.reset >= 0))
        )
          event.reset = screenEvent.reset
        const next = reduceAgentState(current.state, event, clock())
        if (JSON.stringify(next) !== JSON.stringify(current.state)) {
          current.state = next
          current.observed = true
          dirty = true
        }
        await persist()
        return publish()
      }),
    // Codex panes shown working with no hook for quietMs: their rollout may
    // show a turn end whose Stop hook never ran (codexTurnEnd.js).
    turnEndCandidates: (quietMs) => {
      const at = clock()
      const out = []
      for (const [paneId, item] of active) {
        const state = item.state
        if (state.provider !== 'codex' || !state.sessionId || state.lastHookAt === null) continue
        if (at - state.lastHookAt < quietMs) continue
        if (publicAgentState(state, at).state !== 'working') continue
        out.push({
          paneId,
          launchToken: state.launchToken,
          sessionId: state.sessionId,
          turnId: state.turnId,
          lastEventAt: Math.max(state.lastEventAt, state.lastHookAt)
        })
      }
      return out
    },
    // A turn end read from that pane's own session rollout. Bound to its
    // launch and current session; the reducer rejects anything older.
    rolloutTurnEnd: (paneId, token, end = {}) =>
      serial(async () => {
        const current = active.get(paneId)
        if (
          !current ||
          current.state.launchToken !== token ||
          current.state.provider !== 'codex' ||
          !current.state.sessionId ||
          end.sessionId !== current.state.sessionId ||
          !Number.isSafeInteger(end.at) ||
          !['complete', 'error', 'aborted'].includes(end.ended)
        )
          return publish()
        const event = {
          v: 1,
          id: randomUUID(),
          paneId,
          provider: 'codex',
          launchToken: token,
          sessionId: current.state.sessionId,
          event: 'RolloutTurnEnd',
          source: 'rollout',
          at: Math.min(end.at, clock()),
          ended: end.ended
        }
        if (validId(end.turnId)) event.turnId = end.turnId
        const next = reduceAgentState(current.state, event, clock())
        if (JSON.stringify(next) !== JSON.stringify(current.state)) {
          current.state = next
          current.observed = true
          dirty = true
          await persist()
        }
        return publish()
      }),
    // A chat pane (src/main/chat/sessions.js) has no hooks of its own: the
    // manager reads the turn from Claude's stream and reports it here as the
    // hook event it stands for. Same validation (hookEvent) and reducer as a
    // spooled hook, so a chat pane follows exactly a terminal pane's states.
    recordChatEvent: (paneId, token, eventName, { sessionId, toolId, notificationType } = {}) =>
      serial(async () => {
        const current = active.get(paneId)
        if (!current || current.state.launchToken !== token || !CHAT_EVENTS.has(eventName))
          return publish()
        const at = clock()
        const candidate = {
          v: 1,
          id: randomUUID(),
          paneId,
          provider: current.state.provider,
          launchToken: token,
          sessionId: sessionId ?? current.state.sessionId,
          event: eventName,
          at,
          source: 'hook'
        }
        if (toolId !== undefined && toolId !== null) candidate.toolId = toolId
        if (notificationType !== undefined) candidate.notificationType = notificationType
        const event = hookEvent(candidate, at)
        if (!event) return publish()
        const next = reduceAgentState(current.state, event, at)
        if (JSON.stringify(next) !== JSON.stringify(current.state)) {
          current.state = next
          current.observed = true
          dirty = true
          await persist()
        }
        return publish()
      }),
    snapshot: () => publicSnapshot(),
    warnings: () => [...warnings],
    dispose: () => {
      if (disposeFlight) return disposeFlight
      closing = true
      disposeFlight = pending.then(async () => {
        await persist()
        disposed = true
        if (iterator) {
          await iterator.close().catch(() => {})
          iterator = null
        }
      })
      return disposeFlight
    }
  }
}
