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
