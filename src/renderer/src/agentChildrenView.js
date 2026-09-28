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

// The line for one sub-agent: its time (still counting while it runs).
export function childTime(c, now = Date.now()) {
  if (!c.startedAt) return ''
  return formatElapsed((c.state === 'running' ? now : c.endedAt || now) - c.startedAt)
}

// Shown in the pane header: those running, and those finished in the last
// half hour (older ones stay in the list only when you open it).
export const RECENT_MS = 30 * 60 * 1000
export function childrenSummary(list, now = Date.now()) {
  const running = list.filter((c) => c.state === 'running').length
  const recent = list.filter((c) => c.state !== 'running' && c.endedAt && now - c.endedAt < RECENT_MS).length
  return { running, recent, total: list.length }
}
