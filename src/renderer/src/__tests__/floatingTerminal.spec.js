import { describe, it, expect, vi } from 'vitest'
import {
  createFloatingTerminal,
  loadFloatingState,
  isFloatingToggleKey,
  clampHeight,
  FLOATING_STORAGE_KEY,
  DEFAULT_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT
} from '../floatingTerminal'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v)
    }
  }
}

// A fake createLeaf: "attaches" to a terminal still in the host when asked
// for its id, else starts a new one.
function fakeHost(running = []) {
  const live = new Set(running)
  let n = 0
  const calls = []
  const createLeaf = vi.fn(async (shellId, agent, cwd, worktree, opts) => {
    calls.push({ shellId, cwd, opts })
    if (opts.id && live.has(opts.id)) return { type: 'leaf', id: opts.id, attached: true, startDir: cwd }
    const id = opts.id || `pane-${++n}`
    live.add(id)
    return { type: 'leaf', id, attached: false, startDir: cwd }
  })
  const killPty = vi.fn((id) => live.delete(id))
  return { live, calls, createLeaf, killPty }
}

function make({ storage = memoryStorage(), host = fakeHost(), cwd = 'C:\\proj' } = {}) {
  const dropBuffer = vi.fn()
  const ft = createFloatingTerminal({
    createLeaf: host.createLeaf,
    killPty: host.killPty,
    dropBuffer,
    storage,
    startOptions: () => ({ shellId: 'powershell', cwd, opts: {} })
  })
  return { ft, storage, host, dropBuffer }
}

const saved = (storage) => JSON.parse(storage.data[FLOATING_STORAGE_KEY])

describe('floating terminal', () => {
  it('toggles: shown with a terminal in the project folder, then hidden', async () => {
    const { ft, host } = make()
    expect(ft.state.open).toBe(false)
    await ft.toggle()
    expect(ft.state.open).toBe(true)
    expect(ft.state.leaf.id).toBe('pane-1')
    expect(host.calls[0]).toMatchObject({ shellId: 'powershell', cwd: 'C:\\proj' })
    expect(host.calls[0].opts.keepOnFailure).toBe(true)
    await ft.toggle()
    expect(ft.state.open).toBe(false)
    // Hidden, it keeps running.
    expect(host.killPty).not.toHaveBeenCalled()
    expect(ft.state.leaf.id).toBe('pane-1')
  })

  it('reuses its terminal when shown again (no second terminal)', async () => {
    const { ft, host } = make()
    await ft.show()
    ft.hide()
    await ft.show()
    expect(host.createLeaf).toHaveBeenCalledTimes(1)
    expect(ft.state.leaf.id).toBe('pane-1')
  })

  it('shows once even when toggled twice while starting', async () => {
    const { ft, host } = make()
    const a = ft.show()
    const b = ft.ensureLeaf()
    await Promise.all([a, b])
    expect(host.createLeaf).toHaveBeenCalledTimes(1)
  })

  it('remembers its height and whether it is shown', async () => {
    const storage = memoryStorage()
    const { ft } = make({ storage })
    await ft.show()
    ft.setHeight(0.6)
    expect(saved(storage)).toEqual({ open: true, height: 0.6, ptyId: 'pane-1' })
    ft.hide()
    expect(saved(storage).open).toBe(false)
    const again = make({ storage }).ft
    expect(again.state.height).toBe(0.6)
    expect(again.state.open).toBe(false)
  })

  it('re-attaches the terminal still running in the host after a reload', async () => {
    const storage = memoryStorage({ [FLOATING_STORAGE_KEY]: JSON.stringify({ open: true, height: 0.5, ptyId: 'pane-7' }) })
    const host = fakeHost(['pane-7'])
    const { ft } = make({ storage, host })
    // Kept by the startup clean-up of unused host terminals.
    expect(ft.ptyIds()).toEqual(['pane-7'])
    await ft.restoreAtStart()
    expect(host.calls[0].opts.id).toBe('pane-7')
    expect(ft.state.leaf).toMatchObject({ id: 'pane-7', attached: true })
    expect(ft.state.open).toBe(true)
  })

  it('has the keyboard when shown again after a reload (not the grid pane under it)', async () => {
    const storage = memoryStorage({ [FLOATING_STORAGE_KEY]: JSON.stringify({ open: true, height: 0.5, ptyId: 'pane-7' }) })
    const { ft } = make({ storage, host: fakeHost(['pane-7']) })
    expect(ft.hasKeyboard()).toBe(true)
    ft.hide()
    expect(ft.hasKeyboard()).toBe(false)
    const hidden = make({ storage: memoryStorage({ [FLOATING_STORAGE_KEY]: JSON.stringify({ open: false }) }) })
    expect(hidden.ft.hasKeyboard()).toBe(false)
  })

  it('re-attaches lazily when it was hidden at reload', async () => {
    const storage = memoryStorage({ [FLOATING_STORAGE_KEY]: JSON.stringify({ open: false, ptyId: 'pane-7' }) })
    const host = fakeHost(['pane-7'])
    const { ft } = make({ storage, host })
    await ft.restoreAtStart()
    expect(host.createLeaf).not.toHaveBeenCalled()
    expect(ft.ptyIds()).toEqual(['pane-7'])
    await ft.show()
    expect(ft.state.leaf).toMatchObject({ id: 'pane-7', attached: true })
  })

  it('close stops its terminal and hides; the next one is new', async () => {
    const storage = memoryStorage()
    const { ft, host, dropBuffer } = make({ storage })
    await ft.show()
    ft.close()
    expect(host.killPty).toHaveBeenCalledWith('pane-1')
    expect(dropBuffer).toHaveBeenCalledWith('pane-1')
    expect(ft.state).toMatchObject({ open: false, leaf: null })
    expect(saved(storage).ptyId).toBe(null)
    expect(ft.ptyIds()).toEqual([])
    await ft.show()
    expect(ft.state.leaf.id).toBe('pane-2')
  })

  it('restart replaces its terminal and stays shown', async () => {
    const { ft, host } = make()
    await ft.show()
    await ft.restart()
    expect(host.killPty).toHaveBeenCalledWith('pane-1')
    expect(ft.state.leaf.id).toBe('pane-2')
    expect(ft.state.open).toBe(true)
  })

  it('reads bad saved values safely', () => {
    expect(loadFloatingState(memoryStorage({ [FLOATING_STORAGE_KEY]: '{oops' }))).toEqual({ open: false, height: DEFAULT_HEIGHT, ptyId: null })
    expect(loadFloatingState(memoryStorage({ [FLOATING_STORAGE_KEY]: JSON.stringify({ open: 'yes', height: 5, ptyId: '../x' }) }))).toEqual({
      open: false,
      height: MAX_HEIGHT,
      ptyId: null
    })
    expect(clampHeight(0)).toBe(MIN_HEIGHT)
    expect(loadFloatingState(null).open).toBe(false)
  })

  it('Ctrl+` (the key left of 1 on any layout) toggles; not with Shift or Alt', () => {
    expect(isFloatingToggleKey({ ctrlKey: true, key: '`', code: 'Backquote' })).toBe(true)
    expect(isFloatingToggleKey({ ctrlKey: true, key: '²', code: 'Backquote' })).toBe(true)
    expect(isFloatingToggleKey({ ctrlKey: true, key: '`' })).toBe(true)
    expect(isFloatingToggleKey({ ctrlKey: true, shiftKey: true, key: '~', code: 'Backquote' })).toBe(false)
    expect(isFloatingToggleKey({ ctrlKey: true, altKey: true, key: '`', code: 'Backquote' })).toBe(false)
    expect(isFloatingToggleKey({ key: '`', code: 'Backquote' })).toBe(false)
    expect(isFloatingToggleKey({ ctrlKey: true, key: 'Escape', code: 'Escape' })).toBe(false)
  })
})
