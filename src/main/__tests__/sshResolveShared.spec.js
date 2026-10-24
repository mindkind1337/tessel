// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createSshResolver } from '../ssh/sshResolve'

const target = { id: 'ssh-a', label: 'Box', host: 'box.example.com', port: 22, username: 'me' }
const G = 'hostname box.example.com\nport 22\nuser me\n'

describe('ssh -G for panes opened together on one host', () => {
  it('runs once for several panes at the same time, and caches the answer', async () => {
    const calls = []
    const runFile = vi.fn((_exe, _args, _opts, cb) => {
      calls.push(1)
      setTimeout(() => cb(null, G), 20)
    })
    const r = createSshResolver({ sshExe: () => 'ssh.exe', runFile, home: 'C:/home' })
    const all = await Promise.all([r.resolve(target), r.resolve(target), r.resolve(target)])
    expect(runFile).toHaveBeenCalledTimes(1)
    expect(all[1]).toBe(all[0])
    expect(all[2]).toBe(all[0])
    await r.resolve(target)
    expect(runFile).toHaveBeenCalledTimes(1)
  })

  it('a failed lookup is not stuck: the next one asks again', async () => {
    let n = 0
    const runFile = (_exe, _args, _opts, cb) => cb(++n === 1 ? new Error('x') : null, G)
    let clock = 0
    const r = createSshResolver({ sshExe: () => 'ssh.exe', runFile, home: 'C:/home', now: () => (clock += 10_000_000) })
    const first = await r.resolve(target)
    expect(first.ok).toBe(false)
    const second = await r.resolve(target)
    expect(second.ok).toBe(true)
  })
})
