import { describe, it, expect, vi } from 'vitest'
import { stopThenRetry, stuckMessage } from '../agentUpdateRetry'

const labels = { a: '#1 OpenCode', b: '#2 OpenCode' }
const label = (id) => labels[id]

function deps(over = {}) {
  const calls = []
  const d = {
    stopAndWait: vi.fn(async (ids) => { calls.push(['stop', ids]); return { ok: true } }),
    runUpdate: vi.fn(async () => { calls.push(['update']); return true }),
    relaunch: vi.fn(async () => { calls.push(['relaunch']) }),
    release: vi.fn((ids) => calls.push(['release', ids])),
    onStuck: vi.fn(),
    label,
    ...over
  }
  return { d, calls }
}

describe('stopThenRetry', () => {
  it('updates only after the stopped panes really ended, and keeps them for the relaunch', async () => {
    let finish
    const { d, calls } = deps({ stopAndWait: vi.fn(() => new Promise((r) => { finish = r })) })
    const job = { name: 'OpenCode' }
    const p = stopThenRetry(job, ['a', 'b'], d)
    await Promise.resolve()
    expect(d.runUpdate).not.toHaveBeenCalled() // still waiting for the processes
    expect(job.phase).toBe('retrying')
    finish({ ok: true })
    expect(await p).toBe('retried')
    expect(calls).toEqual([['update']])
    expect(job.paused).toEqual(['a', 'b']) // relaunched once the update ends
    expect(d.relaunch).not.toHaveBeenCalled()
    expect(d.release).not.toHaveBeenCalled()
  })

  it('a pane that does not end in time: no update, no relaunch, panes left stopped for you', async () => {
    const { d } = deps({ stopAndWait: vi.fn(async () => ({ ok: false, stuck: ['a'] })) })
    const job = { name: 'OpenCode' }
    expect(await stopThenRetry(job, ['a', 'b'], d)).toBe('stuck')
    expect(d.runUpdate).not.toHaveBeenCalled()
    expect(d.relaunch).not.toHaveBeenCalled()
    expect(d.release).toHaveBeenCalledWith(['a', 'b'])
    expect(d.onStuck).toHaveBeenCalledWith({ stuck: ['a'], stopped: ['a', 'b'] })
    expect(job.phase).toBe('failed')
    expect(job.paused).toEqual([])
  })

  it('the wait itself failing counts as not stopped', async () => {
    const { d } = deps({ stopAndWait: vi.fn(async () => { throw new Error('ipc') }) })
    const job = { name: 'OpenCode' }
    expect(await stopThenRetry(job, ['a'], d)).toBe('stuck')
    expect(d.runUpdate).not.toHaveBeenCalled()
    expect(d.onStuck).toHaveBeenCalledWith({ stuck: ['a'], stopped: ['a'] })
  })

  it('the install pane not opening relaunches the stopped panes (already ended)', async () => {
    const { d, calls } = deps({ runUpdate: vi.fn(async () => false) })
    const job = { name: 'OpenCode' }
    expect(await stopThenRetry(job, ['a'], d)).toBe('failed')
    expect(calls[0][0]).toBe('stop')
    expect(d.relaunch).toHaveBeenCalledWith(job, 'resumed (not updated)')
    expect(job.phase).toBe('failed')
  })
})

describe('stuckMessage', () => {
  it('names the pane and says the update did not run', () => {
    expect(stuckMessage({ stuck: ['a'], stopped: ['a'] }, label)).toBe(
      '#1 OpenCode could not be stopped cleanly; update not run. Restart it when you are ready.'
    )
    expect(stuckMessage({ stuck: ['a'], stopped: ['a', 'b'] }, label)).toBe(
      '#1 OpenCode could not be stopped cleanly; update not run. #2 OpenCode is stopped too. Restart them when you are ready.'
    )
  })
})
