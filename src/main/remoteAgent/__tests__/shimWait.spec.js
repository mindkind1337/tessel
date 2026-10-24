// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { waitForShim, SHIM_WAIT_MS } from '../shimWait'

describe('waitForShim', () => {
  it('gives the install when it is done in time', async () => {
    await expect(waitForShim(Promise.resolve({ ok: true, result: {} }), 50)).resolves.toEqual({ ok: true, result: {} })
  })

  it('gives a timeout instead of waiting for an install stuck behind other work', async () => {
    vi.useFakeTimers()
    try {
      let finish
      const install = new Promise((resolve) => (finish = resolve))
      const waited = waitForShim(install, SHIM_WAIT_MS)
      await vi.advanceTimersByTimeAsync(SHIM_WAIT_MS + 1)
      await expect(waited).resolves.toMatchObject({ ok: false, reason: 'timeout' })
      // It goes on in the background: finishing later is harmless.
      finish({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not leave an unhandled rejection when the late install fails', async () => {
    vi.useFakeTimers()
    try {
      let fail
      const install = new Promise((_resolve, reject) => (fail = reject))
      const waited = waitForShim(install, 10)
      await vi.advanceTimersByTimeAsync(11)
      await waited
      fail(new Error('late'))
      await Promise.resolve()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is what a new pane on a host waits on (index.js prepareRemoteAgent)', () => {
    const src = fs.readFileSync(join(__dirname, '..', '..', 'index.js'), 'utf8')
    expect(src).toMatch(/let shim = await waitForShim\(remoteShims\.ensure\(target\.id\)\)/)
  })
})
