// Is an agent's input prompt empty? Read from the terminal itself, not from
// text (the same words could be typed): the line the cursor is on starts with
// the prompt character, the cursor sits right after it (nothing typed), and
// what follows is drawn dim (a placeholder). Codex draws an empty prompt as
// "› Ask Codex to do anything" with the text dim; typed text is not dim and
// moves the cursor.
export function promptShowsPlaceholder(term, promptChar = '›') {
  if (!term) return false
  const buf = term.buffer.active
  const line = buf.getLine(buf.baseY + buf.cursorY)
  if (!line) return false
  const text = line.translateToString(true)
  const at = text.indexOf(promptChar)
  if (at === -1 || text.slice(0, at).trim()) return false
  // The input starts after the prompt and one space; the cursor is there.
  const start = at + promptChar.length + 1
  if (buf.cursorX !== start) return false
  let dimCells = 0
  for (let x = start; x < text.length; x++) {
    const cell = line.getCell(x)
    if (!cell || !cell.getChars().trim()) continue
    if (!cell.isDim()) return false
    dimCells++
  }
  return dimCells > 0
}

// What an agent's input box holds, read from the terminal: from the prompt line
// up to the line the cursor is on (an Enter taken as a new line leaves the
// cursor one line below the text). Null when no prompt is found near the cursor.
// A menu drawn with the same mark gives its own words, never a pointer.
export function promptBoxText(term, promptChar = '›') {
  if (!term) return null
  const buf = term.buffer.active
  const cursorAt = buf.baseY + buf.cursorY
  for (let y = cursorAt; y >= Math.max(0, cursorAt - 12); y--) {
    const line = buf.getLine(y)
    if (!line) return null
    const text = line.translateToString(true)
    const at = text.indexOf(promptChar)
    if (at === -1 || text.slice(0, at).trim()) continue
    const out = [text.slice(at + promptChar.length)]
    for (let below = y + 1; below <= cursorAt; below++) out.push(buf.getLine(below)?.translateToString(true) || '')
    return out.join('\n').trim()
  }
  return null
}
