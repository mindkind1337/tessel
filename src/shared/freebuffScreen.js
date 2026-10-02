// What Freebuff's screen says of it (it has no hooks): working, waiting for
// an answer, blocked on a question before it can start, or ready. Only its
// live composer area and dialogs are read, never status words in the
// conversation above them. After Orca's src/shared/freebuff-screen-status.ts,
// MIT, Copyright (c) 2026 Lovecast Inc.
//
// lines: the visible screen's lines; alternate: whether the terminal shows
// its alternate screen (Freebuff's full-screen UI).
// -> { state: 'working' | 'waiting' | 'blocked' | 'ready' } or null (not known).
const clean = (line) => String(line).replace(/^[│┃\s]+|[│┃\s]+$/g, '').trim()

export function freebuffScreenState(lines, alternate) {
  const list = Array.isArray(lines) ? lines.map((l) => String(l ?? '')) : []
  const text = list.join('\n')
  if (!alternate) {
    // Before its UI starts: its question about the repository's agent files.
    if (/freebuff found agent files in this repository/.test(text) && /Load and run these\? \[y\/N\]/.test(text))
      return { state: 'blocked' }
    return null
  }
  if (/Press ENTER to login\.\.\./.test(text)) return { state: 'blocked' }
  const footer = list.findLastIndex((line) => /\/model\s+to change.*Chat:/.test(line))
  if (footer < 0) return null
  const dialog = list.findLastIndex((line) => /[╭─].*Some questions for you.*[─╮]/.test(line))
  if (dialog >= 0 && dialog < footer && /↑↓ navigate/.test(list.slice(dialog, footer).join('\n'))) {
    const question = list
      .slice(dialog + 1, footer)
      .map(clean)
      .find((line) => /^[▼▶▸▾►]/.test(line))
    return { state: 'waiting', ...(question ? { question: question.replace(/^[▼▶▸▾►]\s*/, '') } : {}) }
  }
  const top = list.findLastIndex((line, i) => i < footer && /^\s*╭─+╮\s*$/.test(line))
  if (top < 0 || footer - top > 12) return null
  const status = (list[top - 1] || '').trim()
  if (/^(?:thinking|working|connecting|retrying)\.\.\./.test(status) || status.startsWith('high demand — in line'))
    return { state: 'working' }
  if (status === '' && text.includes('Your first message starts the session.')) return { state: 'ready' }
  if (/^(?:\d+[hms]\s*)+left\b|^unlimited\b/.test(status) && /End session/.test(status)) return { state: 'ready' }
  return null
}
