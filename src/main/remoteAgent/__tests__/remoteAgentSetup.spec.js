import { describe, it, expect, vi } from 'vitest'
import { createShimInstaller, instanceName, parseInstallOutput, readInstallId, remoteProjectDataDir, remoteServerEnv, shimVersion, newRemoteToken } from '../remoteAgentSetup'

const SOURCE = "#!/usr/bin/env node\n'use strict'\nconst VERSION = '1.0.0'\n"

describe('remoteAgentSetup', () => {
  it('reads the shim version from its source', () => {
    expect(shimVersion(SOURCE)).toBe('1.0.0')
    expect(shimVersion("const VERSION = '1.0.0; rm -rf'")).toBe(null)
    expect(shimVersion('')).toBe(null)
  })

  it('names the socket per build and host, stable and safe', () => {
    const a = instanceName('tessel-dev', 'ssh-abc')
    expect(a).toMatch(/^[a-z0-9-]{1,40}$/)
    expect(instanceName('tessel-dev', 'ssh-abc')).toBe(a)
    expect(instanceName('tessel', 'ssh-abc')).not.toBe(a)
    expect(instanceName('Tessel Dev!', 'x')).toMatch(/^tesseldev-[0-9a-f]{12}$/)
  })

  it('keeps each remote project data folder apart', () => {
    const a = remoteProjectDataDir('C:\\ud', 'ssh-a', '/home/u/p')
    expect(a).toBe(remoteProjectDataDir('C:\\ud', 'ssh-a', '/home/u/p'))
    expect(a).not.toBe(remoteProjectDataDir('C:\\ud', 'ssh-a', '/home/u/q'))
    expect(a).not.toBe(remoteProjectDataDir('C:\\ud', 'ssh-b', '/home/u/p'))
    expect(a.startsWith('C:\\ud')).toBe(true)
    expect(remoteProjectDataDir('C:\\ud', '../x', '/p')).not.toContain('..')
  })

  it('gives a pane outside any project the host folder', () => {
    expect(remoteProjectDataDir('C:\\ud', 'ssh-a', null)).toMatch(/ssh-a[\\/]_host$/)
    expect(remoteProjectDataDir('C:\\ud', 'ssh-a', '/p')).not.toMatch(/_host$/)
  })

  it('names the socket per install too', () => {
    expect(instanceName('tessel', 'ssh-a', '1111111111111111')).not.toBe(instanceName('tessel', 'ssh-a', '2222222222222222'))
  })

  it('keeps one install id in its file', () => {
    const files = {}
    const fsApi = { readFileSync: (f) => { if (!(f in files)) throw new Error('none'); return files[f] }, writeFileSync: (f, v) => (files[f] = v) }
    const a = readInstallId('id', fsApi)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(readInstallId('id', fsApi)).toBe(a)
    files.id = 'junk'
    expect(readInstallId('id', fsApi)).not.toBe('junk')
  })

  it('gives server.cjs only the variables it needs', () => {
    const env = remoteServerEnv(
      { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\a', ANTHROPIC_API_KEY: 'sk-x', GITHUB_TOKEN: 'g', TESSEL_TEAM_SECRET: 'old' },
      { TESSEL_PANE_ID: 'p', TESSEL_REMOTE: '1', EMPTY: '' }
    )
    expect(env).toEqual({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\a', TESSEL_PANE_ID: 'p', TESSEL_REMOTE: '1' })
  })

  it('makes 64-hex tokens', () => {
    expect(newRemoteToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(newRemoteToken()).not.toBe(newRemoteToken())
  })

  it('takes the last JSON line of the install output', () => {
    expect(parseInstallOutput('noise\n{"ok":true,"changed":["a"]}\n')).toEqual({ ok: true, changed: ['a'] })
    expect(parseInstallOutput('nothing')).toBe(null)
  })

  it('installs once per host, and again after a failure', async () => {
    const install = vi.fn(async () => ({ rc: 0, out: '{"ok":true}\n', err: '' }))
    const shims = createShimInstaller({ install, source: SOURCE })
    const [a, b] = await Promise.all([shims.ensure('h1'), shims.ensure('h1')])
    expect(a).toEqual({ ok: true, result: { ok: true } })
    expect(b).toBe(a)
    expect(install).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledWith('h1', { version: '1.0.0', source: SOURCE })
    await shims.ensure('h2')
    expect(install).toHaveBeenCalledTimes(2)

    install.mockResolvedValueOnce({ rc: 81, out: '', err: '' })
    expect(await shims.ensure('h3')).toMatchObject({ ok: false, reason: 'no-node' })
    expect(await shims.ensure('h3')).toMatchObject({ ok: true })
  })

  it('treats a partial install (exit 1 with its JSON line) as installed', async () => {
    const shims = createShimInstaller({ install: async () => ({ rc: 1, out: '{"ok":false,"errors":["codex"]}', err: '' }), source: SOURCE })
    expect(await shims.ensure('h')).toMatchObject({ ok: true, result: { errors: ['codex'] } })
    const bad = createShimInstaller({ install: async () => ({ rc: 1, out: '', err: 'boom' }), source: SOURCE })
    expect(await bad.ensure('h')).toMatchObject({ ok: false, reason: 'failed' })
  })

  it('reports a session error and an old node', async () => {
    const shims = createShimInstaller({ install: async () => ({ error: 'not signed in' }), source: SOURCE })
    expect(await shims.ensure('h')).toMatchObject({ ok: false, reason: 'failed', detail: 'not signed in' })
    const old = createShimInstaller({ install: async () => ({ rc: 82 }), source: SOURCE })
    expect(await old.ensure('h')).toMatchObject({ ok: false, reason: 'old-node' })
    const none = createShimInstaller({ install: vi.fn(), source: 'no version' })
    expect(await none.ensure('h')).toMatchObject({ ok: false })
  })
})
