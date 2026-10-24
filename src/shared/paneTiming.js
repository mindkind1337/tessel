// The log line that says where the time went when a pane opened (pty:create
// in index.js), so a slow pane shows in the log instead of being a feeling:
//   [pane] claude local pane-12-345 opened in 240 ms (steps: env 1, status hooks 9, terminal host 190, register 38)
// Only the kind of pane, its id and durations: no path, host or name.
export const SLOW_PANE_MS = 1500

// steps: [[name, ms], …] in order; steps under 1 ms are left out.
export function paneOpenLine(kind, id, totalMs, steps) {
  const list = (Array.isArray(steps) ? steps : [])
    .filter((s) => Array.isArray(s) && typeof s[0] === 'string' && Number.isFinite(s[1]) && s[1] >= 1)
    .map(([name, ms]) => `${name.replace(/[^\w .-]/g, '')} ${Math.round(ms)}`)
  const total = Math.max(0, Math.round(Number.isFinite(totalMs) ? totalMs : 0))
  const safeKind = String(kind || 'shell').replace(/[^\w .-]/g, '').slice(0, 40)
  const safeId = String(id || '').replace(/[^\w-]/g, '').slice(0, 60)
  return `${safeKind} ${safeId} opened in ${total} ms${total >= SLOW_PANE_MS ? ' (SLOW)' : ''}${list.length ? ` (steps: ${list.join(', ')})` : ''}`
}
