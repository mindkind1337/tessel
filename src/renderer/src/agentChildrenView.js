// How a pane shows its agent's sub-agents (Claude Code's own list style):
// "7m 57s · ↓ 105.8k tokens".

export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

export function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1000) return `${n}`
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000000).toFixed(1)}M`
}

// Minutes, for how long one has been quiet: "16m", "2h 5m".
function formatQuiet(ms) {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}

// The line for one sub-agent: its time (still counting while it runs). A
// quiet one (unfinished, nothing written for a while: a long tool, or
// stopped) says for how long, never that it finished.
export function childTime(c, now = Date.now()) {
  if (c.state === 'quiet') return c.lastAt ? `quiet ${formatQuiet(now - c.lastAt)}` : 'quiet'
  if (!c.startedAt) return ''
  const end = c.state === 'running' ? now : c.state === 'done' && c.endedAt ? c.endedAt : now
  return formatElapsed(end - c.startedAt)
}

// Shown in the pane header: those running, the quiet ones, and those really
// finished in the last half hour (older ones stay in the list only when you
// open it).
export const RECENT_MS = 30 * 60 * 1000
export function childrenSummary(list, now = Date.now()) {
  const running = list.filter((c) => c.state === 'running').length
  const quiet = list.filter((c) => c.state === 'quiet').length
  const recent = list.filter((c) => c.state === 'done' && c.endedAt && now - c.endedAt < RECENT_MS).length
  return { running, quiet, recent, total: list.length }
}
