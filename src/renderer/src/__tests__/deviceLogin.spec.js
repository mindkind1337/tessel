import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectDeviceLogin, columnOfIndex, mouseClickBytes, linkClickOpens } from '../deviceLogin'

const pane = readFileSync(join(__dirname, '..', 'components', 'TerminalPane.vue'), 'utf8')

const grokFirst = [
  '',
  '     Approve in your browser to finish signing in.',
  '',
  '                       ABCD-1234',
  '',
  "     Make sure your browser shows this code.",
  "     If it doesn't open, click here to copy.",
  '',
  '   Copying not working? Click here to show full URL.',
  '',
  '                    Waiting for approval...'
]
const grokSecond = [
  '       Select the URL below with your mouse and copy manually.',
  '',
  '     https://accounts.x.ai/oauth2/device?user_code=ABCD-1234',
  '                      ctrl+q  go back'
]

describe('detectDeviceLogin', () => {
  it('Grok before its URL: the code, and the cell of "here" in show full URL', () => {
    const r = detectDeviceLogin(grokFirst)
    expect(r.provider).toBe('grok')
    expect(r.url).toBeNull()
    expect(r.code).toBe('ABCD-1234')
    expect(r.showUrl).toEqual({ row: 9, index: 30 })
    expect(grokFirst[8].slice(30, 34)).toBe('here')
  })
  it('Grok with its URL: host, and the code from user_code', () => {
    const r = detectDeviceLogin(grokSecond)
    expect(r.url).toBe('https://accounts.x.ai/oauth2/device?user_code=ABCD-1234')
    expect(r.host).toBe('accounts.x.ai')
    expect(r.known).toBe(true)
    expect(r.page).toBe('https://accounts.x.ai/oauth2/device')
    expect(r.code).toBe('ABCD-1234')
    expect(r.showUrl).toBeNull()
  })
  it('GitHub CLI: the code, and the fixed device page', () => {
    const r = detectDeviceLogin([
      '! First copy your one-time code: 1A2B-3C4D',
      'Press Enter to open github.com in your browser...'
    ])
    expect(r.provider).toBe('github')
    expect(r.url).toBe('https://github.com/login/device')
    expect(r.code).toBe('1A2B-3C4D')
  })
  it('Codex device code', () => {
    const r = detectDeviceLogin([
      'Follow these steps to sign in with ChatGPT using device code authorization:',
      '1. Open this link in your browser and sign in to your account',
      '   https://auth.openai.com/codex/device',
      '2. Enter this one-time code (expires in 15 minutes)',
      '   ABCD-12345'
    ])
    expect(r.provider).toBe('codex')
    expect(r.code).toBe('ABCD-12345')
  })
  it('Claude Code and Gemini: a page to open, no device code', () => {
    const c = detectDeviceLogin([
      "Browser didn't open? Use the url below to sign in",
      'https://claude.ai/oauth/authorize?code=true&client_id=x'
    ])
    expect(c.provider).toBe('claude')
    expect(c.code).toBeNull()
    const g = detectDeviceLogin([
      'Please visit the following URL to authorize the application:',
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      'Enter the authorization code:'
    ])
    expect(g.provider).toBe('gemini')
  })
  it('an unknown host still shows, as unknown, with its name', () => {
    const r = detectDeviceLogin(['Enter the code', 'ABCD-1234', 'https://login.example.org/device'])
    expect(r.known).toBe(false)
    expect(r.host).toBe('login.example.org')
  })
  it('no banner for ordinary URLs, http, credentials or plain text', () => {
    expect(detectDeviceLogin(['see https://example.com/docs for more'])).toBeNull()
    expect(detectDeviceLogin(['Enter the code', 'http://accounts.x.ai/oauth2/device?user_code=ABCD-1234'])).toBeNull()
    expect(detectDeviceLogin(['Enter the code', 'https://user:pw@evil.test/device?user_code=ABCD-1234'])).toBeNull()
    expect(detectDeviceLogin(['Approve in your browser'])).toBeNull()
    expect(detectDeviceLogin([])).toBeNull()
  })
})

describe('what a known host vouches for', () => {
  it('a hostile OAuth page on github.com is not the device flow', () => {
    const r = detectDeviceLogin(['Approve in your browser', 'https://github.com/login/oauth/authorize?client_id=evil&scope=repo', 'ABCD-1234'])
    expect(r.known).toBe(false)
    expect(r.label).toBe('')
    expect(r.page).toBe('https://github.com/login/oauth/authorize')
  })
  it('storage.googleapis.com is not Gemini, and a port shows in the page', () => {
    const r = detectDeviceLogin(['Enter the code', 'https://storage.googleapis.com/b/page.html'])
    expect(r.known).toBe(false)
    expect(r.provider).toBe('other')
    const p = detectDeviceLogin(['Enter the code ABCD-1234', 'https://accounts.x.ai:8443/oauth2/device'])
    expect(p.page).toBe('https://accounts.x.ai:8443/oauth2/device')
  })
})

describe('several pages, wrapped URLs, and the code near the prompt', () => {
  it('two different https pages: no banner', () => {
    expect(detectDeviceLogin(['Enter the code ABCD-1234', 'https://github.com/login/device', 'https://evil.test/x'])).toBeNull()
  })
  it('a URL wrapped by the terminal is whole again', () => {
    const r = detectDeviceLogin(['Approve in your browser', 'https://accounts.x.ai/oauth2/dev', 'ice?user_code=ABCD-1234'], [false, false, true])
    expect(r.url).toBe('https://accounts.x.ai/oauth2/device?user_code=ABCD-1234')
  })
  it('a code far from the prompt (a log or listing) is not offered', () => {
    const far = ['Enter the code', 'https://github.com/login/device', ...Array(10).fill('x'), 'build ABCD-1234']
    expect(detectDeviceLogin(far).code).toBeNull()
    const near = ['Enter the code', 'https://github.com/login/device', 'ABCD-1234']
    expect(detectDeviceLogin(near).code).toBe('ABCD-1234')
  })
})

describe('columnOfIndex', () => {
  const cell = (chars, width = 1) => ({ getChars: () => chars, getWidth: () => width })
  const row = (cells) => ({ length: cells.length, getCell: (x) => cells[x] })
  it('counts cells, not string positions, past wide characters and surrogate pairs', () => {
    const r = row([cell('日', 2), cell('', 0), cell('😀', 2), cell('', 0), cell(' '), cell('h'), cell('e')])
    const text = '日😀 he'
    expect(text.indexOf('h')).toBe(4)
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
})

describe('TerminalPane sign-in banner and link clicks', () => {
  it('scans on output, skips Live Share, never opens by itself', () => {
    expect(pane).toContain('scheduleSignInScan()')
    expect(pane).toMatch(/function scheduleSignInScan\(\) \{\s*if \(signInTimer \|\| props\.node\.backend === 'liveshare' \|\| props\.node\.liveShare\) return/)
    expect(pane).toContain('data-test="device-login-banner"')
    expect(pane).toContain('openLink(s.url, event, true)')
  })
  it('the link gate and the hover hint', () => {
    expect(pane).toContain('if (!force && !linkClickOpens(term && term.modes.mouseTrackingMode, event)) return')
    expect(pane).toContain("t('pane.link.ctrlClick', 'Shift+click to open')")
    // Shift/Cmd/Ctrl lets the click through; the router's other-browser flag is not used.
    expect(pane).toContain("event: term && term.modes.mouseTrackingMode !== 'none' ? undefined : event")
  })
  it('remembers an SGR mouse request even when Always select drops it', () => {
    expect(pane).toContain('mouseAsked.add(m)')
  })
  it('the synthetic click: cells, a fresh read, a program holding the mouse, the alternate screen', () => {
    expect(pane).toContain('columnOfIndex(buf.getLine(buf.baseY + found.showUrl.row - 1)')
    expect(pane).toMatch(/const now = readSignIn\(\)\s+if \(!now \|\| !now\.showUrl \|\| !mouseClickable\(\)\)/)
    expect(pane).toContain("term.buffer.active.type === 'alternate'")
    expect(pane).toContain('if (m === 1049 || m === 1047 || m === 47) mouseAsked.clear()')
  })
  it('Settings > Terminal explains plain clicks and Shift/Cmd+click, in English and French', () => {
    const set = readFileSync(join(__dirname, '..', 'components', 'settings', 'SettingsTerminal.vue'), 'utf8')
    expect(set).toContain('settings.terminal.mouseProgramsHint')
    const fr = readFileSync(join(__dirname, '..', 'i18n', 'locales', 'fr', 'settings.json'), 'utf8')
    expect(fr).toContain('"mouseProgramsHint"')
  })
})
