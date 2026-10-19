// Where an agent's edit lands in its file, for the chat's "open at the first
// change" links (renderer/src/chat/agentEdits.js), from what the agent itself
// recorded, so the window never has to guess.
//
// Claude Code writes a structuredPatch with every Edit / MultiEdit / Write
// result (toolUseResult in its transcript, tool_use_result in its live
// stream): [{ oldStart, oldLines, newStart, newLines, lines: [' ctx', '-a',
// '+b'] }]. The first changed line is the new file's line of the first + or
// - row (a deletion: the line that now stands where it was).
// -> a positive line number, or null.
export function structuredPatchLine(toolUseResult) {
  const tur = toolUseResult && typeof toolUseResult === 'object' && !Array.isArray(toolUseResult) ? toolUseResult : null
  const hunks = tur && Array.isArray(tur.structuredPatch) ? tur.structuredPatch : null
  if (!hunks || !hunks.length) return null
  let best = null
  for (const h of hunks.slice(0, 200)) {
    if (!h || typeof h !== 'object' || !Number.isSafeInteger(h.newStart)) continue
    let n = Math.max(1, h.newStart)
    const lines = Array.isArray(h.lines) ? h.lines.slice(0, 5000) : []
    let found = null
    for (const l of lines) {
      if (typeof l !== 'string') continue
      if (l.startsWith('+') || l.startsWith('-')) {
        found = n
        break
      }
      n++
    }
    // A hunk without its rows: its start is the best there is.
    const line = found ?? Math.max(1, h.newStart)
    if (best === null || line < best) best = line
  }
  return best
}

// A folder an agent said it worked in (a transcript line's cwd, Codex's
// turn_context): kept only when it is a plain absolute path (Windows or
// POSIX), never a network or device path. The window only joins relative
// tool paths to it; it opens nothing by itself.
export function validCwd(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return null
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  if (/^[\\/]{2}/.test(value)) return null
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') ? value : null
}
