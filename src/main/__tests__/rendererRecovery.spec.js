import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  createRecoveryBreaker,
  createLowMemoryGate,
  installRendererRecovery,
  recoveryPromptContent,
  shouldRecoverRenderer,
  RECOVERY_WINDOW_MS,
  LOW_MEMORY_REPEAT_OOM_WINDOW_MS
} from '../rendererRecovery'
import { flatten } from '../i18n'
import frMain from '../../renderer/src/i18n/locales/fr/main.json'

const MB = 1024 * 1024

describe('shouldRecoverRenderer', () => {
  it('reloads after every crash, never after a clean exit', () => {
    for (const reason of ['abnormal-exit', 'crashed', 'killed', 'launch-failed', 'memory-eviction', 'oom'])
      expect(shouldRecoverRenderer({ reason })).toBe(true)
    expect(shouldRecoverRenderer({ reason: 'clean-exit' })).toBe(false)
    expect(shouldRecoverRenderer({ reason: 'integrity-failure' })).toBe(false)
    expect(shouldRecoverRenderer(null)).toBe(false)
  })
  it('a page killed while it navigates (a reload) is not a crash', () => {
    expect(shouldRecoverRenderer({ reason: 'killed' }, { navigating: true })).toBe(false)
    expect(shouldRecoverRenderer({ reason: 'crashed' }, { navigating: true })).toBe(true)
  })
})

describe('createRecoveryBreaker', () => {
  it('allows 3 reloads within 60 s, then opens', () => {
    const b = createRecoveryBreaker()
    expect(b.registerAttempt(0)).toEqual({ allowed: true, recentCount: 1 })
    expect(b.registerAttempt(1000)).toEqual({ allowed: true, recentCount: 2 })
    expect(b.registerAttempt(2000)).toEqual({ allowed: true, recentCount: 3 })
    expect(b.registerAttempt(3000)).toEqual({ allowed: false, recentCount: 3 })
    // A refused attempt is not counted.
    expect(b.recentCount(3000)).toBe(3)
  })
  it('old reloads age out of the rolling window', () => {
    const b = createRecoveryBreaker()
    b.registerAttempt(0)
    b.registerAttempt(10_000)
    b.registerAttempt(20_000)
    expect(b.registerAttempt(RECOVERY_WINDOW_MS - 1).allowed).toBe(false)
    // At 60 s the first one (t=0) is out: one slot again.
    expect(b.registerAttempt(RECOVERY_WINDOW_MS)).toEqual({ allowed: true, recentCount: 3 })
    expect(b.recentCount(RECOVERY_WINDOW_MS + 30_000)).toBe(1)
  })
  it('reset gives a fresh budget', () => {
    const b = createRecoveryBreaker({ windowMs: 1000, maxReloads: 2 })
    b.registerAttempt(0)
    b.registerAttempt(1)
    expect(b.registerAttempt(2).allowed).toBe(false)
    b.reset()
    expect(b.recentCount(2)).toBe(0)
    expect(b.registerAttempt(3).allowed).toBe(true)
  })
})

describe('createLowMemoryGate', () => {
  const oom = { reason: 'oom' }
  const gate = (freeMB, opts = {}) =>
    createLowMemoryGate({ platform: 'win32', freemem: () => freeMB * MB, totalmem: () => 16384 * MB, ...opts })

  it('the first out-of-memory crash always reloads', () => {
    expect(gate(100).assess(oom, 1000)).toBeNull()
  })
  it('a second one within 5 minutes with under 512 MB free asks', () => {
    const g = gate(300)
    g.recordRecoveredDeath(oom, 1000)
    expect(g.assess(oom, 4500)).toEqual({ freeMB: 300, totalMB: 16384, sincePreviousOomMs: 3500 })
  })
  it('enough free memory, another reason, too late or not Windows: reload', () => {
    const plenty = gate(2048)
    plenty.recordRecoveredDeath(oom, 1000)
    expect(plenty.assess(oom, 2000)).toBeNull()

    const g = gate(100)
    g.recordRecoveredDeath(oom, 1000)
    expect(g.assess({ reason: 'crashed' }, 2000)).toBeNull()
    expect(g.assess(oom, 1000 + LOW_MEMORY_REPEAT_OOM_WINDOW_MS + 1)).toBeNull()
    expect(g.assess(oom, 1000)).toBeNull()

    const mac = gate(100, { platform: 'darwin' })
    mac.recordRecoveredDeath(oom, 1000)
    expect(mac.assess(oom, 2000)).toBeNull()
  })
  it('only an out-of-memory death that was recovered starts the window', () => {
    const g = gate(100)
    g.recordRecoveredDeath({ reason: 'crashed' }, 1000)
    expect(g.assess(oom, 2000)).toBeNull()
  })
  it('an unreadable or invalid reading never asks', () => {
    for (const freemem of [() => { throw new Error('x') }, () => NaN, () => -1, () => undefined]) {
      const g = createLowMemoryGate({ platform: 'win32', freemem, totalmem: () => 0 })
      g.recordRecoveredDeath(oom, 1000)
      expect(g.assess(oom, 2000)).toBeNull()
    }
  })
})

describe('recoveryPromptContent', () => {
  it('names the free memory and ends with Quit', () => {
    const c = recoveryPromptContent({ cause: 'low-memory', freeMB: 300 })
    expect(c.detail).toContain('300 MB')
    expect(c.detail).toMatch(/closing apps/)
    expect(c.buttons).toEqual(['Reload', 'Quit'])
  })
  it('crash loop and launch failure say how many times', () => {
    expect(recoveryPromptContent({ cause: 'crash-loop', recentCount: 3 }).detail).toContain('3 times')
    const launch = recoveryPromptContent({ cause: 'launch-failed', recentCount: 3 })
    expect(launch.detail).toContain('3 times')
    expect(launch.buttons).toEqual(['Try Again', 'Quit'])
  })
  it('every key has French with the same placeholders', () => {
    const fr = flatten(frMain)
    const used = []
    const t = (key, english, vars) => {
      used.push([key, english])
      return english
    }
    for (const cause of ['low-memory', 'launch-failed', 'crash-loop']) recoveryPromptContent({ cause }, t)
    const names = (s) => [...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',')
    const bad = used.filter(([k, en]) => fr[k] == null || names(fr[k]) !== names(en)).map(([k]) => k)
    expect(bad).toEqual([])
  })
})

// --- Wiring with a fake window -------------------------------------------------
function fakeWindow() {
  const wc = new EventEmitter()
  wc.destroyed = false
  wc.isDestroyed = () => wc.destroyed
  const win = new EventEmitter()
  win.webContents = wc
  win.destroyed = false
  win.isDestroyed = () => win.destroyed
  return win
}

describe('installRendererRecovery', () => {
  let win
  let clock
  let deps
  let answers
  beforeEach(() => {
    vi.useFakeTimers()
    clock = 0
    win = fakeWindow()
    answers = []
    deps = {
      win,
      loadPage: vi.fn(() => Promise.resolve()),
      isQuitting: vi.fn(() => false),
      showMessageBox: vi.fn(async () => ({ response: answers.length ? answers.shift() : 0 })),
      quit: vi.fn(),
      platform: 'win32',
      freemem: () => 8000 * MB,
      totalmem: () => 16000 * MB,
      now: () => clock
    }
  })
  afterEach(() => vi.useRealTimers())

  const crash = (reason = 'crashed') => win.webContents.emit('render-process-gone', {}, { reason, exitCode: 1 })
  const tick = async (ms = 250) => {
    clock += ms
    await vi.advanceTimersByTimeAsync(ms)
  }

  it('reloads the page 250 ms after a crash', async () => {
    installRendererRecovery(deps)
    crash()
    expect(deps.loadPage).not.toHaveBeenCalled()
    await tick()
    expect(deps.loadPage).toHaveBeenCalledTimes(1)
  })

  it('never reloads after a clean exit, while quitting, or once the window is gone', async () => {
    installRendererRecovery(deps)
    crash('clean-exit')
    await tick()
    deps.isQuitting.mockReturnValue(true)
    crash()
    await tick()
    deps.isQuitting.mockReturnValue(false)
    crash()
    win.destroyed = true
    await tick()
    expect(deps.loadPage).not.toHaveBeenCalled()
  })

  it('one reload for crash events in a burst', async () => {
    installRendererRecovery(deps)
    crash()
    crash('oom')
    await tick()
    expect(deps.loadPage).toHaveBeenCalledTimes(1)
  })

  it('a page that loads again before the timer cancels the reload', async () => {
    installRendererRecovery(deps)
    crash()
    win.webContents.emit('did-finish-load')
    await tick()
    expect(deps.loadPage).not.toHaveBeenCalled()
  })

  it('a page killed during its own reload is left alone', async () => {
    installRendererRecovery(deps)
    win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    crash('killed')
    await tick()
    expect(deps.loadPage).not.toHaveBeenCalled()
    win.webContents.emit('did-finish-load')
    crash('killed')
    await tick()
    expect(deps.loadPage).toHaveBeenCalledTimes(1)
  })

  it('a fourth crash within 60 s asks instead of reloading; Reload gives a fresh budget', async () => {
    installRendererRecovery(deps)
    for (let i = 0; i < 3; i++) {
      crash()
      await tick(1000)
    }
    expect(deps.loadPage).toHaveBeenCalledTimes(3)
    answers.push(0)
    crash()
    await tick(1000)
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1)
    const [parent, opts] = deps.showMessageBox.mock.calls[0]
    expect(parent).toBe(win)
    expect(opts.detail).toContain('3 times')
    expect(opts.cancelId).toBe(0)
    // The user's Reload.
    expect(deps.loadPage).toHaveBeenCalledTimes(4)
    crash()
    await tick(1000)
    expect(deps.loadPage).toHaveBeenCalledTimes(5)
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('Quit in the question quits the app and never reloads', async () => {
    installRendererRecovery(deps)
    for (let i = 0; i < 3; i++) {
      crash()
      await tick(1000)
    }
    answers.push(1)
    crash()
    await tick(1000)
    expect(deps.quit).toHaveBeenCalledTimes(1)
    expect(deps.loadPage).toHaveBeenCalledTimes(3)
  })

  it('crashes after the 60 s window reload again', async () => {
    installRendererRecovery(deps)
    for (let i = 0; i < 3; i++) {
      crash()
      await tick(1000)
    }
    await tick(RECOVERY_WINDOW_MS)
    crash()
    await tick()
    expect(deps.loadPage).toHaveBeenCalledTimes(4)
    expect(deps.showMessageBox).not.toHaveBeenCalled()
  })

  it('a launch failure loop asks with Try Again', async () => {
    installRendererRecovery(deps)
    for (let i = 0; i < 4; i++) {
      crash('launch-failed')
      await tick(1000)
    }
    expect(deps.showMessageBox.mock.calls[0][1].buttons[0]).toBe('Try Again')
  })

  it('Windows, a second out-of-memory crash on a PC low on memory asks', async () => {
    let free = 300 * MB
    deps.freemem = () => free
    installRendererRecovery(deps)
    crash('oom')
    await tick()
    expect(deps.loadPage).toHaveBeenCalledTimes(1)
    answers.push(1)
    crash('oom')
    await tick()
    expect(deps.loadPage).toHaveBeenCalledTimes(1)
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1)
    expect(deps.showMessageBox.mock.calls[0][1].detail).toContain('300 MB')
    expect(deps.quit).toHaveBeenCalledTimes(1)
  })

  it('a second out-of-memory crash with plenty of memory just reloads', async () => {
    installRendererRecovery(deps)
    crash('oom')
    await tick()
    crash('oom')
    await tick()
    expect(deps.loadPage).toHaveBeenCalledTimes(2)
    expect(deps.showMessageBox).not.toHaveBeenCalled()
  })

  it('one question at a time, and none answered by a reload once quitting', async () => {
    let answer
    deps.showMessageBox = vi.fn(() => new Promise((r) => (answer = r)))
    installRendererRecovery(deps)
    for (let i = 0; i < 4; i++) {
      crash()
      await tick(1000)
    }
    crash()
    await tick(1000)
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1)
    deps.isQuitting.mockReturnValue(true)
    answer({ response: 0 })
    await tick()
    expect(deps.loadPage).toHaveBeenCalledTimes(3)
    expect(deps.quit).not.toHaveBeenCalled()
  })

  it('a failing load is logged, not thrown', async () => {
    const log = { info: vi.fn(), error: vi.fn() }
    deps.loadPage = vi.fn(() => Promise.reject(new Error('ERR_ABORTED')))
    installRendererRecovery({ ...deps, log })
    crash()
    await tick()
    expect(log.error).toHaveBeenCalledWith('window', expect.stringContaining('ERR_ABORTED'))
  })

  it('the window closing stops a pending reload and unhooks', async () => {
    installRendererRecovery(deps)
    crash()
    win.emit('closed')
    await tick()
    expect(deps.loadPage).not.toHaveBeenCalled()
    expect(win.webContents.listenerCount('render-process-gone')).toBe(0)
  })
})
