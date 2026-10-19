import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createSessionLister } from '../sessionListClient'
import { serve } from '../sessionListWorker'

// A fake utility process wired to the real worker code.
function fakeFork(list, { answer = true, methods } = {}) {
  const forks = []
  const fork = () => {
    const child = new EventEmitter()
    const port = new EventEmitter()
    port.postMessage = (msg) => setTimeout(() => child.emit('message', msg), 0)
    serve(port, list, methods)
    child.postMessage = (msg) => answer && setTimeout(() => port.emit('message', { data: msg }), 0)
    child.kill = vi.fn(() => child.emit('exit'))
    forks.push(child)
    return child
  }
  return { fork, forks }
}

describe('the session list in its own process', () => {
  it('answers from the worker, one process for several asks', async () => {
    const list = vi.fn((query, home, roots) => [{ id: query.limit + home + roots.claude }])
    const { fork, forks } = fakeFork(list)
    const fallback = vi.fn(() => [])
    const lister = createSessionLister({ fork, fallback })
    const [a, b] = await Promise.all([lister.list({ limit: 1 }, 'H', { claude: 'C' }), lister.list({ limit: 2 }, 'H', { claude: 'D' })])
    expect(a).toEqual([{ id: '1HC' }])
    expect(b).toEqual([{ id: '2HD' }])
    expect(forks).toHaveLength(1)
    expect(fallback).not.toHaveBeenCalled()
    lister.close()
    expect(forks[0].kill).toHaveBeenCalled()
  })

  it('reads here when the process cannot start, fails or does not answer', async () => {
    const fallback = vi.fn(() => [{ id: 'here' }])
    expect(await createSessionLister({ fork: () => { throw new Error('no') }, fallback }).list({})).toEqual([{ id: 'here' }])
    const failing = fakeFork(() => {
      throw new Error('bad')
    })
    expect(await createSessionLister({ fork: failing.fork, fallback }).list({})).toEqual([{ id: 'here' }])
    const silent = fakeFork(() => [], { answer: false })
    expect(await createSessionLister({ fork: silent.fork, fallback, replyMs: 20 }).list({})).toEqual([{ id: 'here' }])
  })

  it('stops the process when unused, and starts it again when asked', async () => {
    const { fork, forks } = fakeFork(() => [])
    const lister = createSessionLister({ fork, fallback: () => [], idleMs: 10 })
    await lister.list({})
    await new Promise((r) => setTimeout(r, 40))
    expect(forks[0].kill).toHaveBeenCalled()
    await lister.list({})
    expect(forks).toHaveLength(2)
    lister.close()
  })
})

describe("the agents' other file readings in that process (call)", () => {
  it('answers a method from the worker (async ones too), never read here', async () => {
    const methods = { agentModel: vi.fn((q, home) => ({ model: q.agentId + home })), children: vi.fn(async (name, id) => [{ id: name + id }]) }
    const { fork, forks } = fakeFork(() => [], { methods })
    const fallbacks = { agentModel: vi.fn(), children: vi.fn() }
    const lister = createSessionLister({ fork, fallback: () => [], fallbacks })
    expect(await lister.call('agentModel', { agentId: 'claude' }, 'H')).toEqual({ model: 'claudeH' })
    expect(await lister.call('children', 'codex', 's1')).toEqual([{ id: 'codexs1' }])
    // An answer that is null or undefined is still the worker's answer.
    methods.agentModel.mockReturnValueOnce(null)
    expect(await lister.call('agentModel', {}, 'H')).toBeNull()
    expect(fallbacks.agentModel).not.toHaveBeenCalled()
    expect(fallbacks.children).not.toHaveBeenCalled()
    expect(forks).toHaveLength(1)
    lister.close()
  })

  it('a method that throws there rejects here, without running it again here', async () => {
    const methods = { agentModel: () => { throw new Error('bad file') } }
    const { fork } = fakeFork(() => [], { methods })
    const fallbacks = { agentModel: vi.fn(() => 'here') }
    const lister = createSessionLister({ fork, fallback: () => [], fallbacks })
    await expect(lister.call('agentModel', {})).rejects.toThrow('bad file')
    expect(fallbacks.agentModel).not.toHaveBeenCalled()
    lister.close()
  })

  it('reads here when the process cannot start, or cannot send its answer', async () => {
    const fallbacks = { agentModel: vi.fn((q) => ({ model: q.agentId })) }
    const none = createSessionLister({ fork: () => { throw new Error('no') }, fallback: () => [], fallbacks })
    expect(await none.call('agentModel', { agentId: 'a' })).toEqual({ model: 'a' })
    // An answer that cannot be cloned: the worker says so, read here.
    const methods = { agentModel: () => ({ fn: () => {} }) }
    const forks = []
    const fork = () => {
      const child = new EventEmitter()
      const port = new EventEmitter()
      port.postMessage = (msg) => {
        structuredClone(msg) // what a real port does: throws on a function
        setTimeout(() => child.emit('message', msg), 0)
      }
      serve(port, () => [], methods)
      child.postMessage = (msg) => setTimeout(() => port.emit('message', { data: msg }), 0)
      child.kill = vi.fn()
      forks.push(child)
      return child
    }
    const lister = createSessionLister({ fork, fallback: () => [], fallbacks })
    expect(await lister.call('agentModel', { agentId: 'c' })).toEqual({ model: 'c' })
    lister.close()
  })

  it('a method with no answer in time fails, never read again on the main thread', async () => {
    const fallbacks = { agentModel: vi.fn(() => ({ model: 'here' })) }
    const silent = fakeFork(() => [], { answer: false })
    const lister = createSessionLister({ fork: silent.fork, fallback: () => [], fallbacks, replyMs: 20 })
    await expect(lister.call('agentModel', { agentId: 'b' })).rejects.toThrow('no answer in time')
    expect(fallbacks.agentModel).not.toHaveBeenCalled()
    lister.close()
  })

  it("the real worker's methods: the sub-agents reader by name, an unknown one answers nothing", async () => {
    const { METHODS } = await import('../sessionListWorker')
    expect(Object.keys(METHODS).sort()).toEqual(['agentModel', 'children', 'findAgentSession', 'findCodexSession'])
    expect(await METHODS.children('nope', 'id')).toEqual([])
  })
})
