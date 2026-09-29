// The sub-agents of a Claude Code or Codex conversation, polled once per conversation
// however many places show them (the sidebar's agent rows). Same data path
// and guards as the pane header's AgentChildren.vue: window.shellApi
// .agentChildren({ agent, sessionId, accountId }), an answer for another
// conversation or older than the last request is dropped, nothing is asked
// while the window is hidden; every 5 s while one runs, else every 20 s.
import { reactive } from 'vue'

const feeds = new Map() // key -> feed

import { listsChildren, childShownState } from './agentChildrenView'
export { CHILD_AGENTS, listsChildren } from './agentChildrenView'

export function childrenKey({ agent, sessionId, accountId } = {}) {
  if (!listsChildren(agent) || !sessionId) return null
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
// sub-agents to show (not Claude Code or Codex, no conversation yet).
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

// Only the active children show at once (running: see childActive); every
// other one (finished, or quiet: stopped, crashed, or its parent's turn is
// over) folds under "+ N more", newest first.
const RANK = { running: 0, quiet: 1, done: 1 }
export function splitChildren(list, ctx = {}) {
  const now = typeof ctx === 'number' ? ctx : ctx.now ?? Date.now()
  const opts = { now, parentIdleSince: typeof ctx === 'number' ? null : ctx.parentIdleSince ?? null }
  const rows = (list || []).map((c) => {
    const state = childShownState(c, opts)
    return state === c.state ? c : { ...c, state }
  })
  const sorted = rows.sort(
    (a, b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3) || (b.startedAt || 0) - (a.startedAt || 0)
  )
  const shown = []
  const older = []
  for (const c of sorted) {
    ;(c.state === 'running' ? shown : older).push(c)
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
