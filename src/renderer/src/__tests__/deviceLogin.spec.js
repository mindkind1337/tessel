import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectDeviceLogin, mouseClickBytes, linkClickOpens } from '../deviceLogin'

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
    expect(r.showUrl).toEqual({ row: 9, col: 32 })
    expect(grokFirst[8].slice(30, 34)).toBe('here')
  })
  it('Grok with its URL: host, and the code from user_code', () => {
    const r = detectDeviceLogin(grokSecond)
    expect(r.url).toBe('https://accounts.x.ai/oauth2/device?user_code=ABCD-1234')
    expect(r.host).toBe('accounts.x.ai')
    expect(r.known).toBe(true)
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
    expect(pane).toContain("t('pane.link.ctrlClick', 'Ctrl+click to open')")
  })
  it('remembers an SGR mouse request even when Always select drops it', () => {
    expect(pane).toContain('mouseSgrAsked = true')
  })
})
