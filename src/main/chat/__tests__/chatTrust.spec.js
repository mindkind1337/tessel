// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createChatTrust, trustKey, MAX_FOLDERS } from '../chatTrust'

let tmp, file
beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-chat-trust-'))
  file = join(tmp, 'chat-trust.json')
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('chat trust', () => {
  it('trusts exact folders only, case and trailing separator insensitive', () => {
    const store = createChatTrust({ file })
    const dir = join(tmp, 'Proj')
    expect(store.isTrusted(dir)).toBe(false)
    store.trust(dir)
    expect(store.isTrusted(dir)).toBe(true)
    expect(store.isTrusted(dir.toUpperCase() + '\\')).toBe(true)
    expect(store.isTrusted(join(dir, 'sub'))).toBe(false)
    expect(store.isTrusted(tmp)).toBe(false)
    // A worktree whose project root the caller passes.
    expect(store.isTrusted(join(tmp, 'wt'), [dir])).toBe(true)
  })

  it('persists, and a new store reads it', () => {
    createChatTrust({ file, now: () => 5 }).trust(tmp)
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(data).toEqual({ version: 1, folders: { [trustKey(tmp)]: { trusted: true, at: 5 } } })
    expect(createChatTrust({ file }).isTrusted(tmp)).toBe(true)
  })

  it('refuses relative or odd paths', () => {
    const store = createChatTrust({ file })
    expect(store.trust('relative\\dir')).toBe(false)
    expect(store.trust('')).toBe(false)
    expect(store.isTrusted(null)).toBe(false)
    expect(store.trust(`${tmp}\0x`)).toBe(false)
  })

  it('ask: a yes is remembered, a no or a failure is not', async () => {
    const ask = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('x'))
    const store = createChatTrust({ file, ask })
    const a = join(tmp, 'a')
    const b = join(tmp, 'b')
    expect(await store.ask(a)).toBe(true)
    expect(ask).toHaveBeenCalledWith({ dir: a })
    expect(store.isTrusted(a)).toBe(true)
    expect(await store.ask(b)).toBe(false)
    expect(await store.ask(b)).toBe(false)
    expect(store.isTrusted(b)).toBe(false)
  })

  it('keeps at most the newest folders', () => {
    let t = 0
    const store = createChatTrust({ file, now: () => ++t, max: 5 })
    for (let i = 0; i < 10; i++) store.trust(join(tmp, `d${i}`))
    expect(store.list()).toHaveLength(5)
    expect(store.isTrusted(join(tmp, 'd0'))).toBe(false)
    expect(store.isTrusted(join(tmp, 'd9'))).toBe(true)
  })

  it('ignores a damaged file', () => {
    fs.writeFileSync(file, '{nope')
    expect(createChatTrust({ file }).isTrusted(tmp)).toBe(false)
  })
})
