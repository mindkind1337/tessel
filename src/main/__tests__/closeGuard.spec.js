import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { createCloseGuard, shouldAskBeforeClose } from '../closeGuard'

function fakeWindow({ crashed = false, loading = false } = {}) {
  const wc = {
    sent: [],
    isDestroyed: () => false,
    isCrashed: () => crashed,
    isLoading: () => loading,
    send(channel) {
      this.sent.push(channel)
    }
  }
  return {
    webContents: wc,
    closed: 0,
    isDestroyed: () => false,
    close() {
      this.closed++
    }
  }
}
function closeEvent() {
  return { prevented: false, preventDefault() { this.prevented = true } }
}

describe('shouldAskBeforeClose', () => {
  it('asks only when nothing lets the close through', () => {
    expect(shouldAskBeforeClose({})).toBe(true)
    for (const k of ['allowed', 'quitting', 'sessionEnding', 'crashed', 'loading', 'unresponsive']) {
      expect(shouldAskBeforeClose({ [k]: true })).toBe(false)
    }
  })
})

describe('createCloseGuard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('holds the close and asks the page; its yes closes the window', () => {
    const g = createCloseGuard()
    const win = fakeWindow()
    const ev = closeEvent()
    expect(g.onClose(ev, win)).toBe(true)
    expect(ev.prevented).toBe(true)
    expect(win.webContents.sent).toEqual(['editor:confirmClose'])
    g.ack()
    g.allow(win)
    expect(win.closed).toBe(1)
    // The close that follows goes through.
    const again = closeEvent()
    expect(g.onClose(again, win)).toBe(false)
    expect(again.prevented).toBe(false)
  })

  it('Cancel (an ack, then nothing) keeps the window open, however long the dialog stays', () => {
    const g = createCloseGuard({ timeoutMs: 4000 })
    const win = fakeWindow()
    g.onClose(closeEvent(), win)
    g.ack()
    vi.advanceTimersByTime(60000)
    expect(win.closed).toBe(0)
    // A second × asks again.
    const ev = closeEvent()
    expect(g.onClose(ev, win)).toBe(true)
    expect(ev.prevented).toBe(true)
  })

  it('a page that never answers does not keep the window: it closes after the timeout', () => {
    const g = createCloseGuard({ timeoutMs: 4000 })
    const win = fakeWindow()
    g.onClose(closeEvent(), win)
    vi.advanceTimersByTime(3999)
    expect(win.closed).toBe(0)
    vi.advanceTimersByTime(1)
    expect(win.closed).toBe(1)
    expect(g.allowed).toBe(true)
  })

  it('never holds a crashed, loading or unresponsive page', () => {
    for (const opts of [{ crashed: true }, { loading: true }]) {
      const g = createCloseGuard()
      const ev = closeEvent()
      expect(g.onClose(ev, fakeWindow(opts))).toBe(false)
      expect(ev.prevented).toBe(false)
    }
    const g = createCloseGuard()
    g.setUnresponsive(true)
    const ev = closeEvent()
    expect(g.onClose(ev, fakeWindow())).toBe(false)
    expect(ev.prevented).toBe(false)
    g.setUnresponsive(false)
    expect(g.onClose(closeEvent(), fakeWindow())).toBe(true)
  })

  it('never holds the window while the app quits (an update install, before-quit)', () => {
    let quitting = true
    const g = createCloseGuard({ isQuitting: () => quitting })
    const ev = closeEvent()
    expect(g.onClose(ev, fakeWindow())).toBe(false)
    expect(ev.prevented).toBe(false)
    quitting = false
    expect(g.onClose(closeEvent(), fakeWindow())).toBe(true)
  })

  it('never holds the window when Windows signs out or shuts down', () => {
    const g = createCloseGuard({ sessionResetMs: 60000 })
    const win = fakeWindow()
    g.onClose(closeEvent(), win) // a question pending when the shutdown starts
    g.sessionEnding()
    const ev = closeEvent()
    expect(g.onClose(ev, win)).toBe(false)
    expect(ev.prevented).toBe(false)
    // A shutdown cancelled by another program: asked again later.
    vi.advanceTimersByTime(60000)
    expect(g.onClose(closeEvent(), win)).toBe(true)
  })

  it('a reloaded page drops the pending question (no timer closes the window later)', () => {
    const g = createCloseGuard({ timeoutMs: 4000 })
    const win = fakeWindow()
    g.onClose(closeEvent(), win)
    g.pageGone()
    vi.advanceTimersByTime(10000)
    expect(win.closed).toBe(0)
  })
})

describe('main wiring', () => {
  const main = fs.readFileSync(join(__dirname, '..', 'index.js'), 'utf8')
  it('the window close, the page answers and Windows session end go through the guard', () => {
    expect(main).toMatch(/mainWindow\.on\('close', \(event\) => closeGuard\.onClose\(event, mainWindow\)\)/)
    expect(main).toMatch(/mainWindow\.on\('query-session-end', \(\) => closeGuard\.sessionEnding\(\)\)/)
    expect(main).toMatch(/mainWindow\.on\('session-end', \(\) => closeGuard\.sessionEnding\(\)\)/)
    expect(main).toMatch(/app\.on\('session-end', \(\) => \{\s*closeGuard\.sessionEnding\(\)/)
    expect(main).toMatch(/'editor:closeAck'[\s\S]{0,200}closeGuard\.ack\(\)/)
    expect(main).toMatch(/'editor:closeWindow'[\s\S]{0,200}closeGuard\.allow\(mainWindow\)/)
    expect(main).toMatch(/isQuitting: \(\) => appQuitting/)
    // An update install closes the window without asking.
    expect(main).toMatch(/beforeInstall: async[\s\S]{0,300}appQuitting = true/)
  })
})
