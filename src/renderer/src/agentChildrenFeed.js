// The sub-agents of a Claude Code conversation, polled once per conversation
// however many places show them (the sidebar's agent rows). Same data path
// and guards as the pane header's AgentChildren.vue: window.shellApi
// .agentChildren({ agent, sessionId, accountId }), an answer for another
// conversation or older than the last request is dropped, nothing is asked
// while the window is hidden; every 5 s while one runs, else every 20 s.
import { reactive } from 'vue'

const feeds = new Map() // key -> feed

export function childrenKey({ agent, sessionId, accountId } = {}) {
  if (agent !== 'claude' || !sessionId) return null
  return JSON.stringify([agent, sessionId, accountId === undefined ? null : accountId])
}

function makeFeed(key, args, api, doc) {
  const feed = {
    key,
    refs: 0,
    seq: 0,
    timer: 0,
    disposed: false,
    state: reactive({ list: [], at: 0 })
  }
  const running = () => feed.state.list.some((c) => c.state === 'running')
  feed.refresh = async () => {
    if (feed.disposed || !api || !api.agentChildren) return
    if (doc && doc.visibilityState === 'hidden') return
    const my = ++feed.seq
    try {
      const res = await api.agentChildren({
        agent: args.agent,
        sessionId: args.sessionId,
        ...(args.accountId !== undefined ? { accountId: args.accountId } : {})
      })
      if (feed.disposed || my !== feed.seq) return
      feed.state.list = Array.isArray(res) ? res : []
      feed.state.at = Date.now()
    } catch {
      // next time
    }
  }
  feed.schedule = () => {
    clearTimeout(feed.timer)
    if (feed.disposed) return
    feed.timer = setTimeout(async () => {
      await feed.refresh()
      feed.schedule()
    }, running() ? 5000 : 20000)
  }
  return feed
}

// -> { state: { list, at }, refresh, release } or null when this pane has no
// sub-agents to show (not Claude Code, no conversation yet).
export function acquireChildren(args, { api = typeof window !== 'undefined' ? window.shellApi : null, doc = typeof document !== 'undefined' ? document : null } = {}) {
  const key = childrenKey(args || {})
  if (!key) return null
  let feed = feeds.get(key)
  if (!feed) {
    feed = makeFeed(key, args, api, doc)
    feeds.set(key, feed)
    feed.refresh().then(() => feed.schedule())
  }
  feed.refs++
  let released = false
  return {
    state: feed.state,
    refresh: () => feed.refresh(),
    release: () => {
      if (released) return
      released = true
      feed.refs--
      if (feed.refs <= 0) {
        feed.disposed = true
        clearTimeout(feed.timer)
        feeds.delete(key)
      }
    }
  }
}

// Orca shows a parent's live children at once; Tessel keeps the whole
// conversation's list, so those long finished (over 30 min) fold under
// "N more". Running first, then quiet, then the newest.
export const RECENT_CHILD_MS = 30 * 60 * 1000
const RANK = { running: 0, quiet: 1, done: 2 }
export function splitChildren(list, now = Date.now()) {
  const sorted = [...(list || [])].sort(
    (a, b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3) || (b.startedAt || 0) - (a.startedAt || 0)
  )
  const shown = []
  const older = []
  for (const c of sorted) {
    const old = c.state === 'done' && (!c.endedAt || now - c.endedAt >= RECENT_CHILD_MS)
    ;(old ? older : shown).push(c)
  }
  return { shown, older }
}

// A child's state as Orca's dot: running works, done is done, quiet has no
// recent update.
export function childDotState(c) {
  if (c.state === 'running') return 'working'
  if (c.state === 'done') return 'done'
  if (c.state === 'quiet') return 'unverifiable'
  return 'idle'
}

export function _resetFeedsForTest() {
  for (const f of feeds.values()) {
    f.disposed = true
    clearTimeout(f.timer)
  }
  feeds.clear()
}
