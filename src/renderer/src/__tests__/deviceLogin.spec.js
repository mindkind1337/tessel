import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectDeviceLogin, columnOfIndex, mouseClickBytes, linkClickOpens, clickPassesThrough } from '../deviceLogin'

const pane = readFileSync(join(__dirname, '..', 'components', 'TerminalPane.vue'), 'utf8')
// Grok Build 1.0.62's real screens (fixtures/grokDeviceLogin.json says how
// they were read), at three pane widths.
const { screens } = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'grokDeviceLogin.json'), 'utf8'))
const read = (s) => detectDeviceLogin(s.lines, { wrapped: s.wrapped, cols: s.cols })
const GROK_URL = 'https://accounts.x.ai/oauth2/device?user_code=K7Q2-M9XD'

describe('Grok, on its real screens', () => {
  it('before its URL: the code, and the first row of "show full URL" at every width', () => {
    // The first cell that answered a click on the real Grok: row 24 col 37 at
    // 120 columns, row 25 col 12 at 60, row 25 col 10 at 44 (index + 1 here).
    for (const [name, row, index] of [
      ['first120', 24, 36],
      ['first60', 25, 11],
      ['first44', 25, 9]
    ]) {
      const r = read(screens[name])
      // Not named before a known page shows (the phrases alone vouch for nothing).
      expect(r, name).toMatchObject({ provider: 'other', label: '', url: null, code: 'K7Q2-M9XD', known: false })
      expect(r.showUrl, name).toEqual({ row, index })
      expect(screens[name].lines[row - 1].slice(index)).toMatch(/^Copying not working\?/)
    }
  })
  it('its URL screen: the page, known, with the code; a URL Grok wrapped itself is whole again', () => {
    for (const name of ['url120', 'url44']) {
      const r = read(screens[name])
      expect(r, name).toMatchObject({ provider: 'grok', label: 'Grok', host: 'accounts.x.ai', page: 'https://accounts.x.ai/oauth2/device', url: GROK_URL, code: 'K7Q2-M9XD', known: true, showUrl: null })
    }
    // Without the width the cut rows are not joined: the half URL is never
    // named as Grok's page, and it is shown whole (what would open).
    const cut = detectDeviceLogin(screens.url44.lines, { wrapped: screens.url44.wrapped })
    expect(cut.known).toBe(false)
    expect(cut.page).toBe(cut.url)
  })
})

describe('other programs', () => {
  it('GitHub CLI: the code, and the fixed device page', () => {
    const r = detectDeviceLogin(['! First copy your one-time code: 1A2B-3C4D', 'Press Enter to open github.com in your browser...'])
    expect(r).toMatchObject({ provider: 'github', url: 'https://github.com/login/device', code: '1A2B-3C4D', known: true })
  })
  it('Codex device code (its own words)', () => {
    const r = detectDeviceLogin([
      'Finish signing in via your browser',
      '',
      '  1. Open this link in your browser and sign in',
      '     https://auth.openai.com/codex/device',
      '',
      '  2. Enter this one-time code after you are signed in (expires in 15 minutes)',
      '     ABCD-12345'
    ])
    expect(r).toMatchObject({ provider: 'codex', label: 'Codex', known: true, url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' })
  })
  it('Claude Code and Gemini: a page to open whole, no device code, not named', () => {
    const c = detectDeviceLogin(["Browser didn't open? Use the url below to sign in", 'https://claude.ai/oauth/authorize?code=true&client_id=x&state=y'])
    expect(c).toMatchObject({ provider: 'other', label: '', known: false, code: null })
    expect(c.page).toBe('https://claude.ai/oauth/authorize?code=true&client_id=x&state=y')
    expect(c.url).toBe(c.page)
    const g = detectDeviceLogin(['Please visit the following URL to authorize the application:', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', 'Enter the authorization code:'])
    expect(g).toMatchObject({ provider: 'other', known: false, host: 'accounts.google.com' })
  })
  it('no banner for ordinary URLs, http, credentials or plain text', () => {
    expect(detectDeviceLogin(['see https://example.com/docs for more'])).toBeNull()
    expect(detectDeviceLogin(['Enter the code', 'http://accounts.x.ai/oauth2/device?user_code=ABCD-1234'])).toBeNull()
    expect(detectDeviceLogin(['Enter the code', 'https://user:pw@evil.test/device?user_code=ABCD-1234'])).toBeNull()
    expect(detectDeviceLogin(['Approve in your browser'])).toBeNull()
    expect(detectDeviceLogin([])).toBeNull()
  })
})

describe('what is shown is what opens', () => {
  it('only the exact device page of a provider is named', () => {
    for (const u of [
      'https://github.com/login/oauth/authorize?client_id=evil&scope=repo',
      'https://github.com/evil/device',
      'https://evil.x.ai.example.com/oauth2/device',
      'https://accounts.x.ai/oauth2/device/../evil',
      'https://storage.googleapis.com/b/device'
    ]) {
      const r = detectDeviceLogin(['Approve in your browser', u, 'ABCD-1234'])
      expect(r, u).toMatchObject({ known: false, label: '', provider: 'other' })
      expect(r.page, u).toBe(r.url)
    }
  })
  it('a known page with anything more than its code is shown whole, not named', () => {
    for (const u of ['https://accounts.x.ai/oauth2/device?user_code=ABCD-1234&continue=https://evil.test', 'https://accounts.x.ai/oauth2/device#x', 'https://accounts.x.ai:8443/oauth2/device']) {
      const r = detectDeviceLogin(['Approve in your browser', u])
      expect(r.known, u).toBe(false)
      expect(r.page, u).toBe(r.url)
      expect(r.url, u).toBe(new URL(u).href)
    }
  })
  it('a known page opens as its page and its code only', () => {
    const r = detectDeviceLogin(['Approve in your browser', 'https://accounts.x.ai/oauth2/device/?user_code=abcd-1234'])
    expect(r).toMatchObject({ known: true, page: 'https://accounts.x.ai/oauth2/device/', url: 'https://accounts.x.ai/oauth2/device/?user_code=abcd-1234', code: 'ABCD-1234' })
  })
  it('two different https pages: no banner', () => {
    expect(detectDeviceLogin(['Enter the code ABCD-1234', 'https://github.com/login/device', 'https://evil.test/x'])).toBeNull()
  })
  it('a URL the terminal wrapped is whole again; a full row only joins a URL that goes on', () => {
    const r = detectDeviceLogin(['Approve in your browser', 'https://accounts.x.ai/oauth2/dev', 'ice?user_code=ABCD-1234'], { wrapped: [false, false, true] })
    expect(r.url).toBe('https://accounts.x.ai/oauth2/device?user_code=ABCD-1234')
    const notUrl = detectDeviceLogin(['Approve in your browser to finish', 'ABCD-1234', 'https://github.com/login/device'], { cols: 33 })
    expect(notUrl.code).toBe('ABCD-1234')
  })
  it('a code far from the prompt (a log or listing) is not offered', () => {
    const far = ['Enter the code', 'https://github.com/login/device', ...Array(10).fill('x'), 'build ABCD-1234']
    expect(detectDeviceLogin(far).code).toBeNull()
    expect(detectDeviceLogin(['Enter the code', 'https://github.com/login/device', 'ABCD-1234']).code).toBe('ABCD-1234')
  })
})

describe('columnOfIndex', () => {
  const cell = (chars, width = 1) => ({ getChars: () => chars, getWidth: () => width })
  const row = (cells) => ({ length: cells.length, getCell: (x) => cells[x] })
  it('counts cells, not string positions, past wide characters and surrogate pairs', () => {
    const r = row([cell('日', 2), cell('', 0), cell('😀', 2), cell('', 0), cell(' '), cell('h'), cell('e')])
    expect('日😀 he'.indexOf('h')).toBe(4)
    expect(columnOfIndex(r, 4)).toBe(6)
  })
  it('an empty cell is one blank', () => {
    expect(columnOfIndex(row([cell(''), cell(''), cell('h')]), 2)).toBe(3)
  })
})

describe('mouse helpers', () => {
  it('writes an SGR press and release', () => {
    expect(mouseClickBytes(28, 9)).toBe('\x1b[<0;28;9M\x1b[<0;28;9m')
  })
  it('a plain click opens a link only when no program takes the mouse', () => {
    expect(linkClickOpens('none', {})).toBe(true)
    expect(linkClickOpens('any', {})).toBe(false)
    expect(linkClickOpens('any', { ctrlKey: true })).toBe(true)
    expect(linkClickOpens('vt200', { metaKey: true })).toBe(true)
    expect(linkClickOpens('drag', { shiftKey: true })).toBe(true)
  })
  it('under Always select, only a plain single click on one cell reaches a program that asked', () => {
    const p = { col: 10, row: 25, button: 0, detail: 1, mods: false, focused: true }
    const base = { alwaysSelect: true, programWantsClicks: true, down: p, up: p, selection: false, onLink: false }
    expect(clickPassesThrough(base)).toBe(true)
    expect(clickPassesThrough({ ...base, alwaysSelect: false })).toBe(false)
    expect(clickPassesThrough({ ...base, programWantsClicks: false })).toBe(false)
    expect(clickPassesThrough({ ...base, selection: true })).toBe(false)
    expect(clickPassesThrough({ ...base, onLink: true })).toBe(false)
    expect(clickPassesThrough({ ...base, up: { ...p, col: 11 } })).toBe(false)
    expect(clickPassesThrough({ ...base, up: { ...p, detail: 2 } })).toBe(false)
    expect(clickPassesThrough({ ...base, down: { ...p, mods: true } })).toBe(false)
    expect(clickPassesThrough({ ...base, down: { ...p, button: 2 }, up: { ...p, button: 2 } })).toBe(false)
    // xterm reports the mouse itself (a request that set other modes too went through): never a second click.
    expect(clickPassesThrough({ ...base, xtermReports: true })).toBe(false)
    // The click that only gave the terminal the keyboard.
    expect(clickPassesThrough({ ...base, down: { ...p, focused: false } })).toBe(false)
  })
})

describe('TerminalPane sign-in banner and clicks', () => {
  it('scans on output, skips Live Share, never opens by itself', () => {
    expect(pane).toContain('scheduleSignInScan()')
    expect(pane).toMatch(/function scheduleSignInScan\(\) \{\s*if \(signInTimer \|\| props\.node\.backend === 'liveshare' \|\| props\.node\.liveShare\) return/)
    expect(pane).toContain('data-test="device-login-banner"')
    expect(pane).toContain('openLink(s.url, event, true)')
    expect(pane).toContain('detectDeviceLogin(lines, { wrapped, cols: term.cols })')
  })
  it('the link gate and the hover hint', () => {
    expect(pane).toContain("const mouseTaken = !force && !!term && term.modes.mouseTrackingMode !== 'none'")
    expect(pane).toContain('if (mouseTaken && !linkClickOpens(term.modes.mouseTrackingMode, event)) return')
    expect(pane).toContain("t('pane.link.ctrlClick', 'Shift+click to open')")
    // Shift/Cmd/Ctrl lets a terminal click through; the router's other-browser flag is not used.
    expect(pane).toContain('ctx.openTarget(uri, { event: mouseTaken ? undefined : event })')
  })
  it('remembers a mouse request even when Always select drops it', () => {
    expect(pane).toContain('mouseAsked.add(m)')
    expect(pane).toContain('if (m === 1049 || m === 1047 || m === 47) mouseAsked.clear()')
  })
  it('the banner click: the cell itself, a fresh read, a program holding the mouse, the alternate screen', () => {
    expect(pane).toContain('found.showUrl = col ? { row: found.showUrl.row, col } : null')
    expect(pane).toMatch(/const now = readSignIn\(\)\s+if \(!now \|\| !now\.showUrl \|\| !mouseClickable\(\)\)/)
    expect(pane).toContain("term.buffer.active.type === 'alternate'")
  })
  it('a plain click passes through under Always select: never in Live Share, never with a link', () => {
    const fn = pane.slice(pane.indexOf('function onPassUp(')).split(/\r?\n\}\r?\n/)[0]
    expect(fn).toContain("props.node.backend === 'liveshare' || props.node.liveShare")
    expect(fn).toContain('programWantsClicks: mouseClickable()')
    expect(fn).toContain("xtermReports: term.modes.mouseTrackingMode !== 'none'")
    expect(pane).toContain('focused: !!term && !!term.textarea && document.activeElement === term.textarea')
    expect(pane).toContain("window.addEventListener('mouseup', onWindowMouseUp, true)")
    expect(pane).toContain("window.removeEventListener('mouseup', onWindowMouseUp, true)")
    // A reset or a new program ends the mouse requests remembered.
    expect(pane).toMatch(/registerEscHandler\(\{ final: 'c' \}, \(\) => \{\s*mouseAsked\.clear\(\)/)
    expect(pane).toContain('if (term.parser.registerEscHandler)')
    expect(pane).toMatch(/registerCsiHandler\(\{ intermediates: '!', final: 'p' \}, \(\) => \{\s*mouseAsked\.clear\(\)/)
    expect(pane).toMatch(/\(\) => props\.node\.launchedAt,\s*\(\) => mouseAsked\.clear\(\)/)
    expect(fn).toContain('selection: term.hasSelection()')
    expect(fn).toContain('onLink: performance.now() - linkClickAt < 250 || !!(term.element && term.element.querySelector(\'.xterm-cursor-pointer\'))')
    expect(fn).toContain('window.shellApi.writePty(props.node.id, mouseClickBytes(up.col, up.row))')
    expect(pane).toContain("hostEl.value.addEventListener('mouseup', onPassUp, { passive: true })")
    // Set first in openLink, before the Live Share branch.
    const open = pane.slice(pane.indexOf('function openLink(uri'), pane.indexOf('function openLink(uri') + 200)
    expect(open.indexOf('linkClickAt = performance.now()')).toBeGreaterThan(0)
    expect(open.indexOf('linkClickAt = performance.now()')).toBeLessThan(open.indexOf("backend === 'liveshare'"))
  })
  it('Settings > Terminal says what a click and a drag do, in English and French', () => {
    const set = readFileSync(join(__dirname, '..', 'components', 'settings', 'SettingsTerminal.vue'), 'utf8')
    expect(set).toContain('a single click still reaches them')
    expect(set).toContain('settings.terminal.mouseProgramsHint')
    const fr = JSON.parse(readFileSync(join(__dirname, '..', 'i18n', 'locales', 'fr', 'settings.json'), 'utf8'))
    expect(JSON.stringify(fr)).toContain('un clic simple leur parvient toujours')
    const frPanes = JSON.parse(readFileSync(join(__dirname, '..', 'i18n', 'locales', 'fr', 'panes.json'), 'utf8'))
    expect(JSON.stringify(frPanes)).toContain('"showFirst"')
  })
})
