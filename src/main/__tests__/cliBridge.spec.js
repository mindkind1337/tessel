import { describe, it, expect, vi } from 'vitest'
import { createCliBridge } from '../cliBridge'

describe('createCliBridge', () => {
  it('holds requests until the window is ready, then matches the answers', async () => {
    const send = vi.fn()
    const bridge = createCliBridge({ send })
    const p = bridge.ask('status', {})
    expect(send).not.toHaveBeenCalled()
    bridge.setReady(true)
    expect(send).toHaveBeenCalledWith('cli:request', expect.objectContaining({ method: 'status', params: {} }))
    const { id } = send.mock.calls[0][1]
    expect(bridge.reply({ id: 'other', ok: true })).toBe(false)
    expect(bridge.reply({ id, ok: true, result: { projects: [] } })).toBe(true)
    await expect(p).resolves.toEqual({ projects: [] })
    expect(bridge.reply({ id, ok: true })).toBe(false)
  })

  it('passes the window’s error on, with a safe code', async () => {
    const send = vi.fn()
    const bridge = createCliBridge({ send })
    bridge.setReady(true)
    const p = bridge.ask('newPane', {})
    bridge.reply({ id: send.mock.calls[0][1].id, ok: false, error: { code: 'unknown_agent', message: 'No agent' } })
    await expect(p).rejects.toMatchObject({ code: 'unknown_agent', message: 'No agent' })
    const p2 = bridge.ask('newPane', {})
    bridge.reply({ id: send.mock.calls[1][1].id, ok: false, error: { code: 'Bad Code!', message: 5 } })
    await expect(p2).rejects.toMatchObject({ code: 'failed' })
  })

  it('times out', async () => {
    vi.useFakeTimers()
    try {
      const bridge = createCliBridge({ send: vi.fn(), timeoutMs: 1000 })
      const p = bridge.ask('status')
      vi.advanceTimersByTime(1001)
      await expect(p).rejects.toMatchObject({ code: 'timeout' })
      expect(bridge.pendingCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a reload fails what was sent, and keeps what was not', async () => {
    const send = vi.fn()
    const bridge = createCliBridge({ send })
    bridge.setReady(true)
    const sent = bridge.ask('status')
    bridge.windowGone()
    await expect(sent).rejects.toMatchObject({ code: 'window_reloaded' })
    const later = bridge.ask('status')
    bridge.windowGone()
    expect(send).toHaveBeenCalledTimes(1)
    bridge.setReady(true)
    expect(send).toHaveBeenCalledTimes(2)
    bridge.reply({ id: send.mock.calls[1][1].id, ok: true, result: 1 })
    await expect(later).resolves.toBe(1)
  })
})
