import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import { promptShowsPlaceholder } from '../promptCheck'

// A real terminal buffer, drawn like Codex draws its screen.
async function screen(writes) {
  const term = new Terminal({ cols: 90, rows: 12, allowProposedApi: true })
  for (const w of writes) await new Promise((r) => term.write(w, r))
  return term
}
const PROMPT = '\x1b[1m›\x1b[0m '
const PLACEHOLDER = '\x1b[2mAsk Codex to do anything\x1b[0m'
const STATUS = '\r\n\r\n  GPT-6-Astra xhigh · C:\\Tessel · Analyser et améliorer le design'
// Codex puts the cursor back at the start of the input line.
const CURSOR_TO_INPUT = '\x1b[2A\r\x1b[2C'

describe('promptShowsPlaceholder (real xterm buffer)', () => {
  it('an empty Codex prompt: placeholder drawn dim, cursor at its start', async () => {
    const t = await screen(['• Done.\r\n\r\n', PROMPT + PLACEHOLDER, STATUS, CURSOR_TO_INPUT])
    expect(promptShowsPlaceholder(t)).toBe(true)
  })

  it('the same words typed by the user: not dim, cursor after them', async () => {
    const t = await screen(['• Done.\r\n\r\n', PROMPT + 'Ask Codex to do anything', STATUS, '\x1b[2A\r\x1b[26C'])
    expect(promptShowsPlaceholder(t)).toBe(false)
  })

  it('the same words typed, even with the cursor moved to the start: not dim', async () => {
    const t = await screen(['• Done.\r\n\r\n', PROMPT + 'Ask Codex to do anything', STATUS, CURSOR_TO_INPUT])
    expect(promptShowsPlaceholder(t)).toBe(false)
  })

  it('an old placeholder line above, a draft in the current prompt', async () => {
    const t = await screen([PROMPT + PLACEHOLDER + '\r\n• Working…\r\n\r\n', PROMPT + 'Do not send this draft yet', STATUS, '\x1b[2A\r\x1b[28C'])
    expect(promptShowsPlaceholder(t)).toBe(false)
  })

  it('a folded paste in the current prompt', async () => {
    const t = await screen(['\r\n', PROMPT + '[Pasted Content 400 chars]', STATUS, '\x1b[2A\r\x1b[28C'])
    expect(promptShowsPlaceholder(t)).toBe(false)
  })

  it('no prompt on the cursor line', async () => {
    const t = await screen(['PS C:\\Tessel> '])
    expect(promptShowsPlaceholder(t)).toBe(false)
  })
})
