// @vitest-environment node
// The check made for a terminal opening on a host: the shim install and the
// agents found there are asked at once (neither needs the other), and the
// host's first terminal joins a check already running instead of a second.
import { describe, it, expect } from 'vitest'
import { createRemoteAgentCheck } from '../remoteAgentSetup'

const found = { claude: '/usr/bin/claude', codex: null, vscodeClaude: null, bins: { claude: '/usr/bin/claude' }, host: {} }

describe('the host agent check', () => {
  it('asks the shim and the agents at once, not one after the other', async () => {
    const started = []
    let finishShim
    const check = createRemoteAgentCheck({
      ensureShim: () => {
        started.push('shim')
        return new Promise((resolve) => (finishShim = () => resolve({ ok: true })))
      },
      agentTools: async () => {
        started.push('tools')
        return found
      },
      agentBins: [{ id: 'claude', bin: 'claude' }]
    })
    const p = check.check('ssh-h')
    await Promise.resolve()
    await Promise.resolve()
    // The agents are asked while the shim install still runs.
    expect(started).toEqual(['shim', 'tools'])
    finishShim()
    const status = await p
    expect(status).toMatchObject({ hostId: 'ssh-h', shim: 'ok', claude: '/usr/bin/claude', agents: { claude: '/usr/bin/claude' } })
  })

  it('a failing shim or agent list still gives the other\'s answer', async () => {
    const check = createRemoteAgentCheck({
      ensureShim: async () => {
        throw new Error('no node')
      },
      agentTools: async () => found,
      agentBins: [{ id: 'claude', bin: 'claude' }]
    })
    expect(await check.check('ssh-h')).toMatchObject({ shim: 'failed', claude: '/usr/bin/claude' })
    const check2 = createRemoteAgentCheck({
      ensureShim: async () => ({ ok: true }),
      agentTools: async () => {
        throw new Error('busy')
      }
    })
    expect(await check2.check('ssh-h')).toMatchObject({ shim: 'ok', error: 'busy' })
  })

  it('the host\'s first terminal joins the check a pane already started (one request to the host)', async () => {
    let calls = 0
    let finish
    const sent = []
    const check = createRemoteAgentCheck({
      ensureShim: async () => ({ ok: true }),
      agentTools: () => {
        calls++
        return new Promise((resolve) => (finish = () => resolve(found)))
      },
      send: (s) => sent.push(s)
    })
    const asked = check.check('ssh-h')
    const started = check.hostStarted('ssh-h')
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)
    finish()
    expect(await started).toBe(await asked)
    // The window hears it once, as before.
    expect(sent).toHaveLength(1)
  })
})
