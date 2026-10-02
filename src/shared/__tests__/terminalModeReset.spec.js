// Reset Terminal: the reset bytes clear in a real terminal emulator (the one
// the terminal host keeps) every input mode a crashed program can leave on.
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { buildInputModeReset } from '../terminalModeReset'

const write = (vt, data) => new Promise((resolve) => vt.write(data, resolve))

// Mouse (any-event + SGR), bracketed paste, focus, application cursor and
// keypad, alternate screen, hidden cursor: what a TUI turns on.
const ARMED = '\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?1h\x1b=\x1b[?66h\x1b[?1049h\x1b[?25l'

describe('buildInputModeReset', () => {
  it('turns every armed input mode off and leaves the alternate screen', async () => {
    const vt = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
    await write(vt, ARMED)
    expect(vt.modes.mouseTrackingMode).toBe('any')
    expect(vt.buffer.active.type).toBe('alternate')
    await write(vt, buildInputModeReset())
    expect(vt.modes).toMatchObject({
      mouseTrackingMode: 'none',
      bracketedPasteMode: false,
      sendFocusMode: false,
      applicationCursorKeysMode: false,
      applicationKeypadMode: false
    })
    expect(vt.buffer.active.type).toBe('normal')
    vt.dispose()
  })

  it('keeps focus reporting when asked (a local ConPTY owns it)', async () => {
    const vt = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
    await write(vt, ARMED)
    await write(vt, buildInputModeReset({ keepFocusReporting: true }))
    expect(vt.modes.sendFocusMode).toBe(true)
    expect(vt.modes.mouseTrackingMode).toBe('none')
    vt.dispose()
  })

  it('keeps the text on the normal screen', async () => {
    const vt = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
    await write(vt, 'PS C:\\> hello')
    await write(vt, buildInputModeReset())
    expect(vt.buffer.active.getLine(0).translateToString(true)).toBe('PS C:\\> hello')
    vt.dispose()
  })
})
