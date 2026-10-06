// @vitest-environment node
// The DPAPI helper: the sealed blob goes in through stdin and the key comes
// back on stdout. A fake PowerShell stands in — no real DPAPI call.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { unprotectDpapi, powershellPath } from '../cookieImport/dpapi'

function fakeChild({ key = Buffer.from('unsealed-key'), code = 0, failStdin = false } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let input = ''
  child.stdin = {
    on: vi.fn(),
    end: vi.fn((buf) => {
      input += String(buf)
      // Answer on the next tick, as a real process would.
      setImmediate(() => {
        if (code === 0 && !failStdin) child.stdout.emit('data', Buffer.from(key.toString('base64')))
        child.emit('close', code)
      })
    })
  }
  child.kill = vi.fn()
  child._input = () => input
  return child
}

describe('unprotectDpapi', () => {
  it('passes the blob as base64 on stdin and returns the key from stdout', async () => {
    const child = fakeChild({ key: Buffer.from('K'.repeat(32)) })
    const spawnFn = vi.fn(() => child)
    const out = await unprotectDpapi(Buffer.from('sealed'), { spawnFn })
    expect(out).toEqual(Buffer.from('K'.repeat(32)))
    // The blob is sent base64-encoded, never on the command line.
    expect(child._input()).toBe(Buffer.from('sealed').toString('base64'))
    const args = spawnFn.mock.calls[0][1]
    expect(args).not.toContain(Buffer.from('sealed').toString('base64'))
  })

  it('rejects when PowerShell exits non-zero', async () => {
    const spawnFn = vi.fn(() => fakeChild({ code: 1 }))
    await expect(unprotectDpapi(Buffer.from('x'), { spawnFn })).rejects.toThrow()
  })

  it('rejects when nothing comes back', async () => {
    const spawnFn = vi.fn(() => fakeChild({ failStdin: true }))
    await expect(unprotectDpapi(Buffer.from('x'), { spawnFn })).rejects.toThrow()
  })

  it('points at the system PowerShell', () => {
    expect(powershellPath({ SystemRoot: 'C:\\Windows' }).replace(/\\/g, '/')).toContain('System32/WindowsPowerShell/v1.0/powershell.exe')
  })
})
