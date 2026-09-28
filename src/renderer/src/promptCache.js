// Prompt cache timer (Settings > Agents, after Orca's): Claude keeps a
// conversation cached for a while after its last answer; a message sent after
// that re-sends the whole context uncached (slower, costs more). A pane shows
// how long is left.

export const CACHE_TTLS = [
  { ms: 5 * 60 * 1000, label: '5 minutes' },
  { ms: 60 * 60 * 1000, label: '1 hour' }
]

// -> { remainingMs, label ('m:ss', or 'h:mm:ss'), level: 'ok' | 'warn' | 'expired' }
export function cacheCountdown(startedAt, ttlMs, now = Date.now()) {
  const remainingMs = Math.max(0, ttlMs - (now - startedAt))
  const s = Math.ceil(remainingMs / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  const label = h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
  const level = remainingMs === 0 ? 'expired' : remainingMs <= 60 * 1000 ? 'warn' : 'ok'
  return { remainingMs, label, level }
}
