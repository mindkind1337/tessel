// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import {
  accountLoginUrl,
  loginEnvironment,
  resolveAccountCommand,
  createProviderLogin
} from '../providerLogin'

function fixture(overrides = {}) {
  const events = new EventEmitter()
  const child = {
    pid: 12345,
    onData(fn) {
      events.on('data', fn)
      return { dispose: () => events.off('data', fn) }
    },
    onExit(fn) {
      events.on('exit', fn)
      return { dispose: () => events.off('exit', fn) }
    }
  }
  const spawnPty = vi.fn(async () => child)
  const runStatus = vi.fn(async () => ({
    ok: true,
    status: { loggedIn: true, email: 'fixture@test.invalid' }
  }))
  const kill = vi.fn(async () => {
    events.emit('exit', { exitCode: 1 })
  })
  const login = createProviderLogin({
    env: { PATH: 'fixture', ANTHROPIC_API_KEY: 'secret' },
    resolveCommand: () => ({ file: 'fixture.exe', pre: ['script.js'] }),
    spawnPty,
    runStatus,
    kill,
    ...overrides
  })
  return { events, child, spawnPty, runStatus, kill, login }
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
const home = process.platform === 'win32' ? 'C:\\disposable account' : '/disposable account'

describe('provider login links and environment', () => {
  it('publishes only complete provider HTTPS authentication links', () => {
    expect(accountLoginUrl('codex', 'https://auth.openai.com/oauth/authorize?a=1')).toBeNull()
    expect(
      accountLoginUrl(
        'codex',
        '\x1b[32mhttps://auth.openai.com/oauth/authorize?a=1&state=x\x1b[0m\r\n'
      )
    ).toBe('https://auth.openai.com/oauth/authorize?a=1&state=x')
    for (const url of [
      'http://auth.openai.com/oauth',
      'https://auth.openai.com.evil.test/oauth',
      'https://token@auth.openai.com/oauth',
      'https://auth.openai.com:8443/oauth',
      'https://developers.openai.com/codex',
      'https://claude.ai/oauth/authorize'
    ])
      expect(accountLoginUrl('codex', url + '\n')).toBeNull()
    expect(
      accountLoginUrl('claude', 'Browser: https://claude.ai/oauth/authorize?state=test\n')
    ).toContain('https://claude.ai/oauth/authorize')
  })
  it('isolates home and removes competing credentials and parent agent variables case insensitively', () => {
    const env = loginEnvironment('codex', home, {
      home: 'real',
      USERPROFILE: 'real',
      codex_home: 'real',
      openai_api_key: 'secret',
      ANTHROPIC_AUTH_TOKEN: 'secret',
      CLAUDECODE: '1',
      PATH: 'bin',
      HTTPS_PROXY: 'proxy'
    })
    expect(env).toEqual({
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: home,
      PATH: 'bin',
      HTTPS_PROXY: 'proxy'
    })
    expect(() => loginEnvironment('unknown', home)).toThrow()
  })
  it('resolves a known npm shim directly without shell interpolation', () => {
    const root = process.platform === 'win32' ? 'C:\\bin & tools' : '/bin & tools'
    const slash = process.platform === 'win32' ? '\\' : '/'
    const codex = root + slash + 'codex.cmd',
      script = root + slash + 'node_modules' + slash + 'codex.js'
    const node = root + slash + 'node.exe'
    const existing = new Set([codex, script, node])
    const result = resolveAccountCommand('codex', {
      platform: 'win32',
      env: { Path: root },
      toolDirs: [],
      exists: (p) => existing.has(p),
      read: () => '"%dp0%\\node_modules/codex.js" %*'
    })
    expect(result).toEqual({ file: node, pre: [script] })
    expect(() =>
      resolveAccountCommand('codex', {
        platform: 'win32',
        env: { Path: root },
        toolDirs: [],
        exists: (p) => p === codex,
        read: () => 'unknown shell script'
      })
    ).toThrow(/launcher/)
  })
})
describe('private browser login lifecycle', () => {
  it('runs Codex with isolated environment, URL-only progress and no output leakage', async () => {
    const f = fixture(),
      progress = vi.fn()
    const result = f.login({ provider: 'codex', home, onProgress: progress })
    await settle()
    f.events.emit('data', 'secret-token\r\nhttps://auth.openai.com/oauth/authorize?state=')
    expect(progress).not.toHaveBeenCalled()
    f.events.emit('data', 'fixture\r\n')
    expect(progress).toHaveBeenCalledWith({
      url: 'https://auth.openai.com/oauth/authorize?state=fixture'
    })
    f.events.emit('exit', { exitCode: 0 })
    expect(await result).toEqual({ ok: true })
    expect(f.spawnPty.mock.calls[0][1]).toEqual(['script.js', 'login'])
    expect(f.spawnPty.mock.calls[0][2].env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(f.runStatus).not.toHaveBeenCalled()
    expect(f.events.listenerCount('data')).toBe(0)
  })
  it('checks Claude status in the same isolated home after successful login', async () => {
    const f = fixture(),
      result = f.login({ provider: 'claude', home })
    await settle()
    expect(f.spawnPty.mock.calls[0][1]).toEqual(['script.js', 'auth', 'login', '--claudeai'])
    f.events.emit('exit', { exitCode: 0 })
    expect((await result).status.email).toBe('fixture@test.invalid')
    expect(f.runStatus.mock.calls[0][1]).toEqual(['script.js', 'auth', 'status', '--json'])
    expect(f.runStatus.mock.calls[0][2].env.CLAUDE_CONFIG_DIR).toBe(home)
  })
  it('waits for actual child exit before cancellation resolves and temporary cleanup may run', async () => {
    const controller = new AbortController(),
      kill = vi.fn(async () => {})
    const f = fixture({ kill }),
      done = vi.fn()
    const result = f.login({ provider: 'codex', home, signal: controller.signal }).then(done)
    await settle()
    controller.abort()
    await settle()
    expect(kill).toHaveBeenCalledOnce()
    expect(done).not.toHaveBeenCalled()
    f.events.emit('exit', { exitCode: 1 })
    await result
    expect(done).toHaveBeenCalledWith({ ok: false, error: 'Sign-in cancelled.' })
  })
  it('times out and suppresses raw command errors', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ timeoutMs: 200 }),
        result = f.login({ provider: 'codex', home })
      await settle()
      f.events.emit('data', 'some access_token=secret')
      await vi.advanceTimersByTimeAsync(200)
      expect(await result).toEqual({ ok: false, error: 'Sign-in timed out. Try again.' })
      expect(f.kill).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
  it('bounds failed teardown without claiming its still-running temporary home is safe to delete', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const f = fixture({
        kill: async () => {
          throw new Error('fixture termination failure')
        },
        teardownMs: 100
      })
      const result = f.login({ provider: 'claude', home, signal: controller.signal })
      await settle()
      controller.abort()
      await vi.advanceTimersByTimeAsync(100)
      expect(await result).toEqual({
        ok: false,
        cleanupSafe: false,
        error: 'Sign-in could not be stopped. Its temporary files were retained.'
      })
      expect(f.runStatus).not.toHaveBeenCalled()
      expect(f.events.listenerCount('data')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not launch an already cancelled login and reports failed verification safely', async () => {
    const f = fixture({
      runStatus: async () => {
        throw new Error('secret credential')
      }
    })
    const controller = new AbortController()
    controller.abort()
    expect((await f.login({ provider: 'claude', home, signal: controller.signal })).ok).toBe(false)
    expect(f.spawnPty).not.toHaveBeenCalled()
    const result = f.login({ provider: 'claude', home })
    await settle()
    f.events.emit('exit', { exitCode: 0 })
    expect(await result).toEqual({ ok: false, error: 'Could not verify the signed-in account.' })
  })
})
