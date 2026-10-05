import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createSessionLister } from '../sessionListClient'
import { serve } from '../sessionListWorker'

// A fake utility process wired to the real worker code.
function fakeFork(list, { answer = true } = {}) {
  const forks = []
  const fork = () => {
    const child = new EventEmitter()
    const port = new EventEmitter()
    port.postMessage = (msg) => setTimeout(() => child.emit('message', msg), 0)
    serve(port, list)
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
