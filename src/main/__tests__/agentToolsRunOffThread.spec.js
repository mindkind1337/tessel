// @vitest-environment node
// run() (git, PowerShell...: scm:status, git:worktrees, the model probes'
// program lookup) starts its program from the worker thread, never with
// child_process.execFile on the main thread, and answers as before.
import { it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFileOff: vi.fn(), execFile: vi.fn() }))
vi.mock('../spawnOffThread', () => ({ execFileOff: mocks.execFileOff, spawnOff: vi.fn() }))
vi.mock('child_process', async (orig) => ({ ...(await orig()), execFile: mocks.execFile }))
import { run } from '../agentTools'

it('runs through execFileOff with the same arguments and result shape', async () => {
  mocks.execFileOff.mockImplementationOnce((file, args, opts, cb) => cb(null, 'git version 2\n', ''))
  const res = await run('git', ['--version'], { timeout: 5000 })
  expect(res).toEqual({ ok: true, code: 0, stdout: 'git version 2\n', stderr: '', error: null })
  const [file, args, opts] = mocks.execFileOff.mock.calls[0]
  expect(file).toBe('git')
  expect(args).toEqual(['-c', 'core.fsmonitor=false', '--version'])
  expect(opts).toMatchObject({ windowsHide: true, timeout: 5000 })
  expect(mocks.execFile).not.toHaveBeenCalled()
})

it('a failure: ok false, its exit code and message', async () => {
  mocks.execFileOff.mockImplementationOnce((file, args, opts, cb) => cb(Object.assign(new Error('Command failed'), { code: 128 }), '', 'fatal: not a git repository'))
  expect(await run('git', ['status'])).toEqual({ ok: false, code: 128, stdout: '', stderr: 'fatal: not a git repository', error: 'Command failed' })
})
