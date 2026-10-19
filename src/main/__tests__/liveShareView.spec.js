// @vitest-environment node
// Live Share, as a guest: the session the host's pages open in
// (liveShareView.js). Its partition is one of its own per Live Share
// session, in memory; every request it makes to the guest's own computer or
// network is refused: by name (localhost, a private range, a .local name)
// and by what the name resolves to (a public-looking name pointing at
// 127.0.0.1 or 192.168.x.x), cached.
import { describe, it, expect, vi } from 'vitest'
import { isViewPartition, createHostCheck, guardViewSession } from '../liveShareView'

describe('a guest view session', () => {
  it('its partition: in memory, of a known shape only', () => {
    expect(isViewPartition('liveshare-view-3')).toBe(true)
    for (const p of ['persist:liveshare-view-3', 'liveshare-view-', 'liveshare-view-../x', 'persist:tessel-browser', null]) expect(isViewPartition(p)).toBe(false)
  })

  it('a host on the guest side is refused by name and by what it resolves to (cached)', async () => {
    const lookup = vi.fn(async (host) => (host === 'evil.example.com' ? [{ address: '192.168.1.1' }] : host === 'six.example.com' ? [{ address: '::1' }] : host === 'gone.example.com' ? Promise.reject(new Error('ENOTFOUND')) : [{ address: '93.184.216.34' }]))
    const check = createHostCheck({ lookup })
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '169.254.169.254', 'nas.local', '[::1]', 'intranet']) expect(await check(host), host).toBe(true)
    expect(await check('evil.example.com')).toBe(true)
    expect(await check('six.example.com')).toBe(true)
    expect(await check('example.com')).toBe(false)
    expect(await check('8.8.8.8')).toBe(false)
    // Not resolving: let through (it fails on its own).
    expect(await check('gone.example.com')).toBe(false)
    await check('evil.example.com')
    expect(lookup.mock.calls.filter(([h]) => h === 'evil.example.com')).toHaveLength(1)
  })

  it('every request of the session goes through the check; other schemes are refused', async () => {
    let handler = null
    const ses = { webRequest: { onBeforeRequest: vi.fn((h) => (handler = h)) } }
    expect(guardViewSession(ses, { check: async (host) => host === 'router.example.com' })).toBe(true)
    const ask = (url) => new Promise((resolve) => handler({ url, resourceType: 'mainFrame' }, resolve))
    expect(await ask('https://example.com/a')).toEqual({})
    expect(await ask('https://router.example.com/admin')).toEqual({ cancel: true })
    expect(await ask('file:///C:/x')).toEqual({ cancel: true })
    expect(await ask('data:text/plain,hi')).toEqual({})
    expect(await ask('not a url')).toEqual({ cancel: true })
  })
})
