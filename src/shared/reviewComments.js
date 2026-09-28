// Comments left on diff lines in a review, sent to the agent in one message
// with "Request changes": each tied to its file and line, with the code it is
// about, so the agent knows exactly where.
//   comment: { file, line, side: 'new'|'old', code, text }

// The line a comment points at: the new file's line, or the old one for a
// removed line.
export function commentLocation(c) {
  return `${c.file}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}`
}

// general text + the comments -> the message for the agent ('' when empty).
export function reviewMessage(general, comments) {
  const parts = []
  const text = String(general || '').trim()
  if (text) parts.push(text)
  const list = (Array.isArray(comments) ? comments : []).filter((c) => c && String(c.text || '').trim())
  if (list.length) {
    const sorted = [...list].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
    const lines = [`Comments on specific lines (${sorted.length}):`]
    for (const c of sorted) {
      lines.push(`- ${commentLocation(c)}: ${String(c.text).trim()}`)
      const code = String(c.code || '').trim()
      if (code) lines.push(`  > ${code.length > 160 ? `${code.slice(0, 160)}…` : code}`)
    }
    parts.push(lines.join('\n'))
  }
  return parts.join('\n\n')
}
