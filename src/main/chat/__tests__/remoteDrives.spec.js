// @vitest-environment node
// Network drive letters (remoteDrives.js), with a fake Windows answer.
import { describe, expect, it, vi } from 'vitest'
import { createRemoteDrives } from '../remoteDrives.js'

describe('network drives', () => {
  it('a path on a mapped network drive is remote; asked once, again after a while', async () => {
    let t = 0
    const run = vi.fn(async () => ['Z:', ' y: ', '', 'garbage'])
    const d = createRemoteDrives({ platform: 'win32', run, now: () => t })
    expect(await d.isRemote('Z:\\share\\shot.png')).toBe(true)
    expect(await d.isRemote('y:/x.png')).toBe(true)
    expect(await d.isRemote('C:\\Users\\me\\x.png')).toBe(false)
    expect(await d.isRemote('/tmp/x.png')).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    t += 10 * 60 * 1000
    await d.isRemote('C:\\x.png')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('outside Windows, or when Windows cannot say, no drive is taken for one', async () => {
    const run = vi.fn(async () => ['Z:'])
    expect(await createRemoteDrives({ platform: 'linux', run }).isRemote('Z:/x')).toBe(false)
    expect(run).not.toHaveBeenCalled()
    const failing = createRemoteDrives({ platform: 'win32', run: async () => Promise.reject(new Error('no powershell')) })
    expect(await failing.isRemote('Z:\\x.png')).toBe(false)
  })
})
