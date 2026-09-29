import { describe, it, expect, vi } from 'vitest'
import { installWindowVisibility } from '../windowVisibility'

function fakeApi(initial = true) {
  let listener = null
  return {
    windowShown: vi.fn(async () => initial),
    onWindowShown: vi.fn((cb) => {
      listener = cb
      return () => (listener = null)
    }),
    emit: (v) => listener && listener(v),
    listening: () => !!listener
  }
}

describe('window visibility follows the real window', () => {
  it('says hidden while the window is minimized, with a visibilitychange at each change', async () => {
    const doc = document
    const api = fakeApi(true)
    const changes = []
    doc.addEventListener('visibilitychange', () => changes.push(doc.visibilityState))
    const stop = installWindowVisibility({ doc, api })
    await Promise.resolve()
    expect(doc.visibilityState).toBe('visible')
    expect(doc.hidden).toBe(false)

    api.emit(false)
    expect(doc.visibilityState).toBe('hidden')
    expect(doc.hidden).toBe(true)
    expect(doc.documentElement.classList.contains('window-hidden')).toBe(true)

    api.emit(false) // no change, no event
    api.emit(true)
    expect(doc.visibilityState).toBe('visible')
    expect(doc.documentElement.classList.contains('window-hidden')).toBe(false)
    expect(changes).toEqual(['hidden', 'visible'])

    stop()
    expect(api.listening()).toBe(false)
    expect(doc.visibilityState).toBe('visible')
  })

  it('starts hidden when the window already is (asked once at start)', async () => {
    const doc = document
    const api = fakeApi(false)
    const stop = installWindowVisibility({ doc, api })
    await Promise.resolve()
    await Promise.resolve()
    expect(api.windowShown).toHaveBeenCalledTimes(1)
    expect(doc.visibilityState).toBe('hidden')
    stop()
    expect(doc.visibilityState).toBe('visible')
  })

  it('does nothing without the main process API (older preload)', () => {
    const doc = document
    const stop = installWindowVisibility({ doc, api: {} })
    expect(doc.visibilityState).toBe('visible')
    expect(() => stop()).not.toThrow()
  })
})
