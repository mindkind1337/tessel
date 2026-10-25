// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createRemoteAgentCheck } from '../remoteAgentSetup'

describe('"Check again" clicked repeatedly', () => {
  it('shares the fresh check already running, then asks again once it is done', async () => {
    let calls = 0
    let finish
    const check = createRemoteAgentCheck({
      ensureShim: async () => ({ ok: true }),
      agentTools: () => {
        calls++
        return new Promise((resolve) => (finish = () => resolve({ claude: '/usr/bin/claude', codex: null, vscodeClaude: null, bins: {}, host: {} })))
      },
      agentBins: []
    })
    const a = check.check('ssh-h', { fresh: true })
    const b = check.check('ssh-h', { fresh: true })
    const c = check.check('ssh-h', { fresh: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)
    finish()
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(rb).toBe(ra)
    expect(rc).toBe(ra)
    const d = check.check('ssh-h', { fresh: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(2)
    finish()
    await d
  })
})

describe('the agent check of a host', () => {
  it('asks for the agents without waiting for the shim install (both queued at once), and reports both', async () => {
    const order = []
    let shimDone
    const check = createRemoteAgentCheck({
      ensureShim: () => {
        order.push('shim')
        return new Promise((resolve) => (shimDone = () => resolve({ ok: true })))
      },
      agentTools: async () => {
        order.push('agents')
        return { claude: '/usr/bin/claude', codex: null, vscodeClaude: null, bins: {}, host: {} }
      },
      agentBins: []
    })
    const p = check.hostStarted('ssh-h')
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['shim', 'agents'])
    shimDone()
    const st = await p
    expect(st).toMatchObject({ hostId: 'ssh-h', claude: '/usr/bin/claude', shim: 'ok' })
    // The window's own check meanwhile gets this answer, no second look.
    expect(await check.check('ssh-h')).toBe(st)
    expect(order).toEqual(['shim', 'agents'])
  })
  it('a shim that fails or throws still gives the agents found', async () => {
    const check = createRemoteAgentCheck({
      ensureShim: async () => {
        throw new Error('no node')
      },
      agentTools: async () => ({ claude: null, codex: '/usr/bin/codex', vscodeClaude: null, bins: {}, host: {} }),
      agentBins: []
    })
    expect(await check.check('ssh-h')).toMatchObject({ codex: '/usr/bin/codex', shim: 'failed' })
  })
})
