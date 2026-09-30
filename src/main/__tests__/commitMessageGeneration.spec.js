// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
vi.mock('../i18n', () => ({ t: (_key, fallback) => fallback }))
import { createCommitMessageGeneration } from '../commitMessageGeneration'

const root = resolve('fake-repository')
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
function setup() {
  const diff = deferred()
  const scm = {
    scmStagedDiff: vi.fn(() => diff.promise),
    repoOf: vi.fn(async () => ({ top: root })),
    commitPrompt: (text) => text,
    cleanGeneratedMessage: (text) => text.trim()
  }
  const runHeadless = vi.fn(async () => ({ ok: true, text: 'Fix the bug' }))
  const cancelHeadless = vi.fn(() => false)
  return { diff, scm, runHeadless, cancelHeadless, service: createCommitMessageGeneration({ scm, runHeadless, cancelHeadless }) }
}

it('honors Stop while the staged diff is still being read, without starting an agent', async () => {
  const { diff, service, runHeadless } = setup()
  const generating = service.generate({ root, agent: 'claude' })
  const cancellation = await service.cancel({ root })
  diff.resolve({ ok: true, top: root, diff: 'staged changes' })
  const result = await generating
  expect(cancellation.ok).toBe(true)
  expect(result).toMatchObject({ ok: false, cancelled: true })
  expect(runHeadless).not.toHaveBeenCalled()
})

it('keeps normal generation and error handling intact, releasing the reservation', async () => {
  const { diff, scm, service, runHeadless } = setup()
  diff.resolve({ ok: false, error: 'No staged files' })
  expect(await service.generate({ root })).toEqual({ ok: false, error: 'No staged files' })
  expect(runHeadless).not.toHaveBeenCalled()
  scm.scmStagedDiff.mockResolvedValue({ ok: true, top: root, diff: 'changes' })
  expect(await service.generate({ root, agent: 'codex' })).toEqual({ ok: true, message: 'Fix the bug' })
  expect(runHeadless).toHaveBeenCalledWith('codex', 'changes', { cwd: root, key: root })
})

it('rejects duplicate requests while preparing the diff', async () => {
  const { diff, scm, service } = setup()
  const first = service.generate({ root })
  const second = await service.generate({ root })
  expect(second.ok).toBe(false)
  expect(scm.scmStagedDiff).toHaveBeenCalledTimes(1)
  diff.resolve({ ok: false, error: 'No staged files' })
  await first
})

it('cancels a running agent once and suppresses any late success', async () => {
  const { diff, service, runHeadless, cancelHeadless } = setup()
  const answer = deferred()
  runHeadless.mockReturnValue(answer.promise)
  diff.resolve({ ok: true, top: root, diff: 'changes' })
  const generating = service.generate({ root })
  await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledOnce())
  expect(await service.cancel({ root })).toEqual({ ok: true })
  expect(await service.cancel({ root })).toEqual({ ok: true })
  expect(cancelHeadless).toHaveBeenCalledExactlyOnceWith(root)
  answer.resolve({ ok: true, text: 'Late answer' })
  expect(await generating).toMatchObject({ ok: false, cancelled: true })
})

it('can cancel an active run using another folder in the repository', async () => {
  const { diff, service, runHeadless, cancelHeadless } = setup()
  const answer = deferred()
  runHeadless.mockReturnValue(answer.promise)
  diff.resolve({ ok: true, top: root, diff: 'changes' })
  const generating = service.generate({ root })
  await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledOnce())
  expect(await service.cancel({ root: resolve(root, 'subfolder') })).toEqual({ ok: true })
  expect(cancelHeadless).toHaveBeenCalledWith(root)
  answer.resolve({ ok: false, cancelled: true })
  await generating
})

it('does not let a late cancellation lookup stop a newer request', async () => {
  const { diff, scm, service, runHeadless, cancelHeadless } = setup()
  const lookup = deferred()
  scm.repoOf.mockReturnValue(lookup.promise)
  const cancelling = service.cancel({ root: resolve(root, 'subfolder') })
  const answer = deferred()
  runHeadless.mockReturnValue(answer.promise)
  diff.resolve({ ok: true, top: root, diff: 'changes' })
  const generating = service.generate({ root })
  await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledOnce())
  lookup.resolve({ top: root })
  expect(await cancelling).toEqual({ ok: false })
  expect(cancelHeadless).not.toHaveBeenCalled()
  answer.resolve({ ok: true, text: 'New answer' })
  expect(await generating).toEqual({ ok: true, message: 'New answer' })
})
