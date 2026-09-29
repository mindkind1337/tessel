// Bounded, provider-independent subagent lifecycle. Events describe observations;
// they never start work, change permissions, or answer an approval.
export const SUBAGENT_LIMITS = { groups: 32, agents: 64, field: 512, tools: 128, label: 120 }
// Token/duration-only changes of a working child: at most one progress event
// and one group snapshot per this many ms (state changes are never held back).
export const SUBAGENT_THROTTLE_MS = 1000
const FINAL = new Set(['idle', 'completed', 'failed', 'stopped'])
export const subagentId = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value)
    ? value
    : null
const text = (value) => (typeof value === 'string' && value ? value.slice(0, 512) : undefined)
const number = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

export function subagentTokens(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  for (const key of ['total_tokens', 'totalTokens'])
    if (number(usage[key]) !== undefined) return usage[key]
  const keys = [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens'
  ]
  const values = keys.map((key) => number(usage[key])).filter((value) => value !== undefined)
  return values.length ? values.reduce((a, b) => a + b, 0) : undefined
}

// deliverTo(fn): held-back snapshots are then also sent by a timer once their
// window has passed (fn gets the events), so the last one always arrives.
export function createSubagentTracker(now = Date.now, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let deliver = null,
    timer = null
  const groups = new Map(),
    entries = new Map(),
    lastSnapshot = new Map(), // groupId -> time of its last snapshot
    dirty = new Set() // groupIds with a held-back metric change
  function snapshot(groupId, out) {
    const group = groups.get(groupId)
    if (!group) return
    lastSnapshot.set(groupId, now())
    dirty.delete(groupId)
    const labels = new Set()
    const agents = [...group.values()].map((entry) => {
      const base = (entry.description || entry.subagentType || entry.id).slice(0, SUBAGENT_LIMITS.label)
      let label = base,
        ordinal = 1
      while (labels.has(label)) {
        const suffix = ` (${++ordinal})`
        label = base.slice(0, SUBAGENT_LIMITS.label - suffix.length) + suffix
      }
      labels.add(label)
      const { id, state, tokens, startedAt, settledAt } = entry
      return {
        id,
        label,
        state,
        ...(tokens !== undefined ? { tokens } : {}),
        startedAt,
        ...(settledAt !== undefined ? { settledAt } : {})
      }
    })
    out.push({ type: 'subagents', groupId, agents })
  }
  function event(entry, phase, out, extra = {}) {
    const {
      id,
      groupId,
      state,
      subagentType,
      description,
      model,
      startedAt,
      settledAt,
      tokens,
      durationMs,
      parentToolUseId
    } = entry
    out.push({
      type: 'subagent',
      phase,
      id,
      groupId,
      status: state,
      ...(subagentType ? { subagentType } : {}),
      ...(description ? { description } : {}),
      ...(model ? { model } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      startedAt,
      ...(settledAt !== undefined ? { settledAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(tokens !== undefined ? { tokens, usage: { totalTokens: tokens } } : {}),
      ...extra
    })
  }
  function upsert(id, groupId, fields, out) {
    // Its own group's held-back change goes with this update's snapshot.
    if (dirty.size) flush(out, entries.get(id)?.groupId ?? groupId)
    if (!subagentId(id) || !subagentId(groupId)) return null
    let entry = entries.get(id),
      created = false
    if (!entry) {
      if (!groups.has(groupId)) {
        if (groups.size >= SUBAGENT_LIMITS.groups) {
          const oldest = groups.keys().next().value
          for (const old of groups.get(oldest).keys()) entries.delete(old)
          groups.delete(oldest)
          lastSnapshot.delete(oldest)
          dirty.delete(oldest)
        }
        groups.set(groupId, new Map())
      }
      if (groups.get(groupId).size >= SUBAGENT_LIMITS.agents) return null
      entry = {
        id,
        groupId,
        state: 'working',
        startedAt: number(fields.startedAt) ?? now(),
        tools: new Map(),
        // The parent turn open when it was first seen (never sent in events).
        ...(fields.owner != null ? { owner: fields.owner } : {})
      }
      groups.get(groupId).set(id, entry)
      entries.set(id, entry)
      created = true
    }
    let changed = created,
      metricOnly = false
    for (const key of ['description', 'subagentType', 'model', 'parentToolUseId']) {
      const value = text(fields[key])
      if (value !== undefined && value !== entry[key]) {
        entry[key] = value
        changed = true
      }
    }
    const described = changed
    for (const key of ['tokens', 'durationMs']) {
      const value = number(fields[key])
      if (value !== undefined && value !== entry[key]) {
        entry[key] = value
        metricOnly = !described
        changed = true
      }
    }
    const requested = fields.state,
      previousState = entry.state
    let ended = false
    if (
      (requested === 'working' || FINAL.has(requested) || requested === 'unverifiable') &&
      requested !== entry.state &&
      (entry.state === 'working' || (entry.state === 'unverifiable' && FINAL.has(requested)))
    ) {
      entry.state = requested
      changed = true
      ended = requested !== 'working'
      if (ended) {
        entry.settledAt = number(fields.settledAt) ?? now()
        entry.durationMs ??= Math.max(0, entry.settledAt - entry.startedAt)
      }
    }
    // A working child's token/duration-only change is held back within the
    // throttle window: the next snapshot (at the latest its end) carries it.
    const stateChanged = created || entry.state !== previousState
    if (changed && metricOnly && !stateChanged && entry.state === 'working') {
      const last = lastSnapshot.get(entry.groupId)
      if (last !== undefined && now() - last < SUBAGENT_THROTTLE_MS) {
        dirty.add(entry.groupId)
        schedule(SUBAGENT_THROTTLE_MS - (now() - last))
        return entry
      }
    }
    if (created) event(entry, 'start', out)
    if (ended) event(entry, 'end', out)
    else if (changed && !created) event(entry, 'progress', out)
    if (changed) snapshot(entry.groupId, out)
    return entry
  }
  function schedule(ms) {
    if (!deliver || timer) return
    timer = setTimer(() => {
      timer = null
      const out = []
      flush(out)
      if (out.length) deliver(out)
      if (dirty.size) schedule(SUBAGENT_THROTTLE_MS)
    }, Math.max(0, ms))
    timer?.unref?.()
  }
  function deliverTo(fn) {
    deliver = typeof fn === 'function' ? fn : null
    if (!deliver && timer) {
      clearTimer(timer)
      timer = null
    }
  }
  // Snapshots of groups with a held-back change whose window has passed.
  function flush(out, except = undefined) {
    for (const groupId of [...dirty]) {
      if (groupId === except) continue
      const last = lastSnapshot.get(groupId)
      if (last === undefined || now() - last >= SUBAGENT_THROTTLE_MS) snapshot(groupId, out)
    }
  }
  function progress(id, tool, out) {
    if (dirty.size) flush(out)
    const entry = entries.get(id)
    if (!entry || entry.state !== 'working' || !subagentId(tool?.id)) return
    const status = tool.status === 'completed' || tool.status === 'failed' ? tool.status : 'running'
    const previous = entry.tools.get(tool.id)
    if (previous === status || previous === 'completed' || previous === 'failed') return
    if (entry.tools.size >= SUBAGENT_LIMITS.tools)
      entry.tools.delete(entry.tools.keys().next().value)
    entry.tools.set(tool.id, status)
    event(entry, 'progress', out, { tool: { id: tool.id, name: text(tool.name) || '', status } })
  }
  // groupId null: every child. owner: also the children first seen while that
  // turn was open, whatever their group.
  function settle(groupId, status, out, owner = undefined) {
    for (const entry of entries.values()) {
      const mine =
        (groupId == null && owner == null) ||
        (groupId != null && entry.groupId === groupId) ||
        (owner != null && entry.owner === owner)
      if (mine && entry.state === 'working') {
        upsert(
          entry.id,
          entry.groupId,
          { state: status === 'interrupted' ? 'stopped' : 'unverifiable' },
          out
        )
      }
    }
  }
  return { get: (id) => entries.get(id), upsert, progress, settle, snapshot, flush, deliverTo }
}
