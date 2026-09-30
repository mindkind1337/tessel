// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), run: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../agentTools', () => ({ run: mocks.run, shimTarget: vi.fn(), psQuote: (s) => s }))
vi.mock('../i18n', () => ({ t: (_key, fallback) => fallback }))
import { runHeadless, cancelHeadless } from '../agentHeadless'

function child() {
  const p = new EventEmitter()
  p.stdout = new EventEmitter()
  p.stderr = new EventEmitter()
  p.stdin = new EventEmitter()
  p.stdin.end = vi.fn()
  p.kill = vi.fn()
  return p
}
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
const found = { stdout: JSON.stringify({ app: 'C:/fake/claude.exe', path: '' }) }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.run.mockResolvedValue(found)
})
afterEach(() => { cancelHeadless('repo') })

it('keeps the replacement run cancellable when the cancelled process closes late', async () => {
  const oldChild = child()
  const newChild = child()
  mocks.spawn.mockReturnValueOnce(oldChild).mockReturnValueOnce(newChild)
  const oldRun = runHeadless('claude', 'old', { key: 'repo' })
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1))
  expect(cancelHeadless('repo')).toBe(true)
  const newRun = runHeadless('claude', 'new', { key: 'repo' })
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2))
  oldChild.emit('close', 0)
  expect((await oldRun).cancelled).toBe(true)
  const cancelled = cancelHeadless('repo')
  newChild.emit('close', 0)
  await newRun
  expect(cancelled).toBe(true)
  expect(newChild.kill).toHaveBeenCalledOnce()
})

it.runIf(process.platform === 'win32')('does not revive a cancelled lookup when a replacement owns the same key', async () => {
  const oldLookup = deferred()
  const newLookup = deferred()
  mocks.run.mockReturnValueOnce(oldLookup.promise).mockReturnValueOnce(newLookup.promise)
  const unexpected = child()
  mocks.spawn.mockReturnValue(unexpected)
  const oldRun = runHeadless('claude', 'old', { key: 'repo' })
  expect(cancelHeadless('repo')).toBe(true)
  const newRun = runHeadless('claude', 'new', { key: 'repo' })
  oldLookup.resolve(found)
  await new Promise((resolve) => setImmediate(resolve))
  const spawnCount = mocks.spawn.mock.calls.length
  unexpected.emit('close', 0)
  const oldResult = await oldRun
  const cancelled = cancelHeadless('repo')
  newLookup.resolve(found)
  await newRun
  expect(spawnCount).toBe(0)
  expect(oldResult.cancelled).toBe(true)
  expect(cancelled).toBe(true)
})
