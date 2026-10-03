import { describe, expect, it } from 'vitest'
import { promptSuggestionOnScreen, suggestionScreenRows } from '../chat/terminalChatExtras'
import { Terminal } from '@xterm/headless'

// A screen row: its text, and which cells are greyed (dim, coloured or inverted).
const row = (text, styledFrom = -1, styledTo = text.length) => ({
  text,
  styled: Array.from(text, (_, i) => styledFrom >= 0 && i >= styledFrom && i < styledTo)
})

describe("Claude Code's prompt suggestion on screen", () => {
  it('a greyed message in the empty prompt is the suggestion', () => {
    const rows = [row('* Brewed for 8s · done 11:39'), row('─'.repeat(40)), row('> ok push une release', 2), row('─'.repeat(40))]
    expect(promptSuggestionOnScreen(rows)).toBe('ok push une release')
  })
  it('text the user typed (default colour) is not a suggestion', () => {
    expect(promptSuggestionOnScreen([row('> ok push une release')])).toBe('')
  })
  it('partly greyed text is not a suggestion', () => {
    expect(promptSuggestionOnScreen([row('> ok push une release', 2, 6)])).toBe('')
  })
  it('an empty prompt or no prompt: nothing', () => {
    expect(promptSuggestionOnScreen([row('> '), row('just output', 0)])).toBe('')
    expect(promptSuggestionOnScreen([])).toBe('')
  })
  // The empty prompt at the bottom: an older greyed row above it (the echo of
  // the last message sent) is not a suggestion, or Tab would send it again.
  it('an empty prompt stops the search: an older greyed row above it is not a suggestion', () => {
    const rows = [row('> push the release', 2), row('● Done.'), row('─'.repeat(40)), row('> '), row('─'.repeat(40))]
    expect(promptSuggestionOnScreen(rows)).toBe('')
    expect(promptSuggestionOnScreen([row('> push the release', 2), row('│ >                         │')])).toBe('')
  })
  // Read from a real terminal buffer: a wide character (CJK, emoji) takes two
  // cells, so a row's text and its cells are matched cell by cell.
  it('reads the screen cell by cell: wide characters keep the style check on the right cells', async () => {
    const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
    const write = (data) => new Promise((r) => term.write(data, r))
    await write('\x1b[2m> 日本語 ok\x1b[0m')
    expect(promptSuggestionOnScreen(suggestionScreenRows(term.buffer.active, term.rows))).toBe('日本語 ok')
    // Greyed, then typed in the default colour after the wide characters: not a suggestion.
    await write('\r\n\x1b[2m> 日本語\x1b[0m ok')
    expect(promptSuggestionOnScreen(suggestionScreenRows(term.buffer.active, term.rows))).toBe('')
    term.dispose()
  })
  it('a prompt drawn in a box', () => {
    expect(promptSuggestionOnScreen([row('│ > run the tests           │', 4, 17)])).toBe('run the tests')
  })
})
