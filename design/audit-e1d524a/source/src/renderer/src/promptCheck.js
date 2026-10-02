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
