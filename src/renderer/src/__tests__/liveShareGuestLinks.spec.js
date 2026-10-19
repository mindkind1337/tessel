// Live Share, as a guest: links in a host's terminal and conversation
// (liveShareGuestLinks.js). Nothing a host prints is looked up or opened on
// the guest's own computer.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { guestFileTarget, guestUrlTarget } from '../liveShareGuestLinks'

describe('a file path in a host’s terminal', () => {
  it('relative to the host’s project: a link to the project’s file (lshare://)', () => {
    expect(guestFileTarget('ws-1', 'src/app.js')).toBe('lshare://ws-1\\src\\app.js')
    expect(guestFileTarget('ws-1', 'src\\main\\index.js')).toBe('lshare://ws-1\\src\\main\\index.js')
    expect(guestFileTarget('ws-1', './README.md')).toBe('lshare://ws-1\\README.md')
  })

  it.each(['C:\\Users\\me\\Downloads\\tool.exe', 'C:/Windows/System32/calc.exe', '/home/me/run.sh', '\\\\server\\share\\a.js', '~/x.js', '$HOME/a.js', '%APPDATA%\\a.js', 'file:///C:/a.js', 'src/../../outside.js', '../secret.txt'])(
    'anything else stays plain text: %s',
    (p) => {
      expect(guestFileTarget('ws-1', p)).toBeNull()
    }
  )

  it('no project known: no link', () => {
    expect(guestFileTarget(null, 'src/app.js')).toBeNull()
    expect(guestFileTarget('bad id!', 'src/app.js')).toBeNull()
  })
})

describe('an address in a host’s terminal or conversation', () => {
  it('filtered as the host’s pages are: secrets out, local addresses flagged', () => {
    expect(guestUrlTarget('https://example.com/docs?page=2&q=private')).toEqual({ url: 'https://example.com/docs?page=2', local: false, trimmed: true })
    expect(guestUrlTarget('https://example.com/reset/abc123?token=x').url).toBe('https://example.com/')
    expect(guestUrlTarget('http://localhost:5173/').local).toBe(true)
    expect(guestUrlTarget('http://192.168.1.1/admin').local).toBe(true)
    expect(guestUrlTarget('file:///C:/x')).toBeNull()
    expect(guestUrlTarget('javascript:alert(1)')).toBeNull()
    expect(guestUrlTarget(null)).toBeNull()
  })
})

// The wiring, read from the sources (the components need a full window to mount).
describe('guest panes never use the local file or browser paths', () => {
  const src = (p) => fs.readFileSync(join(__dirname, '..', p), 'utf8')
  it('TerminalPane: a Live Share pane takes the guest link paths before any local lookup', () => {
    const pane = src('components/TerminalPane.vue')
    const provider = pane.indexOf("if (props.node.backend === 'liveshare') return guestFileLinks(y, callback)")
    expect(provider).toBeGreaterThan(0)
    expect(provider).toBeLessThan(pane.indexOf('.resolveFiles({ cwd, paths: unknown })'))
    // The guest's file links never open outside Tessel (no Shift+click to files:open).
    const guest = pane.slice(pane.indexOf('function guestFileLinks('), pane.indexOf('// A file path (src/app.js:12:5'))
    expect(guest).not.toMatch(/openFile\(|shiftKey|resolveFiles/)
    const openLink = pane.slice(pane.indexOf('function openLink(uri'), pane.indexOf('function openLink(uri') + 700)
    expect(openLink.indexOf("backend === 'liveshare'")).toBeGreaterThan(0)
    expect(openLink.indexOf("backend === 'liveshare'")).toBeLessThan(openLink.indexOf('shellApi.openExternal'))
    // The link router (links/openTarget.js) comes after the guest guard, never before it.
    expect(openLink.indexOf("backend === 'liveshare'")).toBeLessThan(openLink.indexOf('ctx.openTarget'))
  })
  it('the chat view: a host’s conversation opens web links through openGuestUrl', () => {
    const view = src('components/chat/orca/NativeChatTranscriptView.vue')
    expect(view).toMatch(/openWeb: guestOpenWeb\.value/)
    expect(view).toMatch(/panelCtx\.openGuestUrl\(url/)
  })
  it('App: guest links open in the Live Share view session, the system browser only by choice', () => {
    const app = src('App.vue')
    const fn = app.slice(app.indexOf('function openGuestUrl('), app.indexOf('// --- Chat agents (ChatPane.vue'))
    expect(fn).toMatch(/guestUrlTarget\(raw\)/)
    expect(fn).toMatch(/leaf\.viewPartition = viewPartition\(session\)/)
    expect(fn).toMatch(/if \(link\.local\) return showToast/)
    // openExternalUrl only from the toast's button.
    expect(fn.match(/openExternalUrl\(/g)).toHaveLength(1)
    expect(fn).toMatch(/run: \(\) => openExternalUrl\(link\.url\)/)
  })
})
