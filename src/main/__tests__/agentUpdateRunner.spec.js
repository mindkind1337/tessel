// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { stepArgv, commandFor, classifyFailure, createUpdateRunner, fakeSpawn } from '../agentUpdateRunner'
import { createInstallLogs } from '../installLog'

describe('steps', () => {
  it('splits Tessel’s own steps into plain words', () => {
    expect(stepArgv('npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest')).toEqual([
      'npm',
      'install',
      '-g',
      '--ignore-scripts',
      '@earendil-works/pi-coding-agent@latest'
    ])
    expect(stepArgv('claude update')).toEqual(['claude', 'update'])
  })
  it('refuses anything a shell would read as syntax', () => {
    for (const bad of ['npm i -g x & del *', 'npm i x|y', 'a > b', 'npm "x"', 'a;b', 'a %PATH%', '$(x)', '', '   ']) {
      expect(stepArgv(bad)).toBeNull()
    }
  })
  it('runs through cmd on Windows (npm is a .cmd), directly elsewhere', () => {
    expect(commandFor(['npm', 'install', '-g', 'x@latest'], 'win32')).toEqual({ file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm install -g x@latest'] })
    expect(commandFor(['claude', 'update'], 'linux')).toEqual({ file: 'claude', args: ['update'] })
  })
})

describe('classifyFailure', () => {
  const k = (output, extra = {}) => classifyFailure({ output, exitCode: 1, ...extra }).kind
  it('files in use (npm EBUSY / EPERM on a rename, claude.exe in use)', () => {
    expect(k('npm error code EBUSY\nnpm error syscall rename')).toBe('in-use')
    expect(k("npm error Error: EPERM: operation not permitted, rename 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex'")).toBe('in-use')
    expect(k('Error: claude.exe is in use by another process')).toBe('in-use')
    expect(k('The process cannot access the file because it is being used by another process.')).toBe('in-use')
    expect(k('npm error code EPERM')).toBe('in-use')
  })
  it('permission denied (npm global prefix)', () => {
    expect(k("npm error Error: EPERM: operation not permitted, mkdir 'C:\\Program Files\\nodejs\\node_modules\\x'")).toBe('permission')
    expect(k('npm error code EACCES')).toBe('permission')
  })
  it('network', () => {
    expect(k('npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed')).toBe('network')
    expect(k('npm error code ETIMEDOUT')).toBe('network')
    expect(k('npm error code UNABLE_TO_GET_ISSUER_CERT_LOCALLY')).toBe('network')
  })
  it('not found', () => {
    expect(k('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x')).toBe('not-found')
    expect(k("'npm' is not recognized as an internal or external command,")).toBe('not-found')
    expect(classifyFailure({ output: '', exitCode: 9009 }).kind).toBe('not-found')
    expect(classifyFailure({ spawnError: Object.assign(new Error('spawn cmd.exe ENOENT'), { code: 'ENOENT' }) }).kind).toBe('not-found')
  })
  it('timeout, and anything else with the line that tells it', () => {
    expect(classifyFailure({ output: 'x', timedOut: true }).kind).toBe('timeout')
    const r = classifyFailure({ output: 'step 1\nnpm error something odd happened\nnpm error A complete log of this run can be found in: x\n', exitCode: 1 })
    expect(r).toEqual({ kind: 'failed', detail: 'npm error something odd happened' })
  })
  it('gives the matching line as the detail', () => {
    expect(classifyFailure({ output: 'a\nnpm error code EBUSY\nb', exitCode: 1 }).detail).toBe('npm error code EBUSY')
  })
})

describe('runner', () => {
  let dir, logs, results, spawned
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-updrun-'))
    results = []
    spawned = []
    logs = createInstallLogs({ dir, appVersion: '9.9.9', notify: (r) => results.push(r) })
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const make = (script, opts = {}) => {
    const inner = fakeSpawn(script)
    return createUpdateRunner({
      spawn: (file, args, o) => {
        spawned.push({ file, args, opts: o })
        return inner(file, args, o)
      },
      getEnv: () => ({ Path: 'C:\\fresh\\path;C:\\npm', HOME: 'h' }),
      logs,
      platform: 'win32',
      cwd: 'C:\\Users\\me',
      ...opts
    })
  }

  it('success: runs each step with the fresh environment, hidden, output in the install log', async () => {
    const runner = make(() => ({ output: 'added 1 package in 3s\n', exitCode: 0 }))
    const r = await runner.run({ agentId: 'codex', name: 'Codex CLI', steps: ['npm install -g @openai/codex@latest'] })
    expect(r.ok).toBe(true)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('cmd.exe')
    expect(spawned[0].args).toEqual(['/d', '/s', '/c', 'npm install -g @openai/codex@latest'])
    expect(spawned[0].opts).toMatchObject({ windowsHide: true, cwd: 'C:\\Users\\me', env: { Path: 'C:\\fresh\\path;C:\\npm', HOME: 'h' } })
    expect(r.file).toMatch(/installs[\\/]Update-Codex-CLI-\d{8}-\d{6}\.log$/)
    const text = fs.readFileSync(r.file, 'utf8')
    expect(text).toContain('npm install -g @openai/codex@latest')
    expect(text).toContain('added 1 package in 3s')
    expect(text).toContain('===== SUCCEEDED')
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)
  })

  it('failure: stops at the failing step, classifies it, logs FAILED', async () => {
    const runner = make((file, args) => (args[3].startsWith('claude') ? { stderr: 'Error: EBUSY: resource busy or locked, unlink claude.exe\n', exitCode: 1 } : {}))
    const r = await runner.run({ agentId: 'claude', name: 'Claude Code', steps: ['claude update', 'npm --version'] })
    expect(r).toMatchObject({ ok: false, kind: 'in-use', exitCode: 1, reason: 'exit code 1' })
    expect(r.detail).toContain('EBUSY')
    expect(spawned).toHaveLength(1) // the second step never ran
    expect(fs.readFileSync(r.file, 'utf8')).toMatch(/===== FAILED \(in-use: exit code 1\)/)
  })

  it('timeout: ends the tree it started, by its PID', async () => {
    const killed = []
    const runner = make(() => ({ hang: true, output: 'fetching…\n' }), {
      timeoutMs: 30,
      killTree: (pid) => killed.push(pid)
    })
    const r = await runner.run({ agentId: 'gemini', name: 'Gemini', steps: ['npm install -g @google/gemini-cli@latest'] })
    expect(r).toMatchObject({ ok: false, kind: 'timeout' })
    // fakeSpawn has no pid: the child itself was told to end instead.
    expect(killed).toEqual([])
    expect(fs.readFileSync(r.file, 'utf8')).toContain('===== FAILED (timeout')
  })

  it('timeout with a real pid: killTree gets that pid', async () => {
    const killed = []
    const inner = fakeSpawn(() => ({ hang: true }))
    const runner = createUpdateRunner({
      spawn: (f, a, o) => {
        const c = inner(f, a, o)
        c.pid = 4242
        return c
      },
      logs,
      platform: 'win32',
      timeoutMs: 20,
      graceMs: 10,
      killTree: (pid) => killed.push(pid)
    })
    const p = runner.run({ agentId: 'x', name: 'X', steps: ['npm install -g x@latest'] })
    const r = await p
    expect(killed).toEqual([4242])
    expect(r.kind).toBe('timeout')
  }, 10000)

  it('could not start: not found', async () => {
    const runner = make(() => ({ error: { code: 'ENOENT', message: 'spawn cmd.exe ENOENT' } }))
    const r = await runner.run({ agentId: 'x', name: 'X', steps: ['npm install -g x@latest'] })
    expect(r).toMatchObject({ ok: false, kind: 'not-found' })
  })

  it('one at a time; never runs a step that is not plain words', async () => {
    const runner = make(() => ({ delayMs: 20 }))
    const first = runner.run({ agentId: 'a', name: 'A', steps: ['npm install -g a@latest'] })
    expect(runner.busy()).toBe('a')
    const second = await runner.run({ agentId: 'b', name: 'B', steps: ['npm install -g b@latest'] })
    expect(second).toMatchObject({ ok: false, kind: 'busy' })
    expect((await first).ok).toBe(true)
    expect(runner.busy()).toBeNull()
    const bad = await runner.run({ agentId: 'c', name: 'C', steps: ['npm install -g c & calc'] })
    expect(bad.ok).toBe(false)
    expect(spawned.map((s) => s.args[3])).toEqual(['npm install -g a@latest'])
  })
})
