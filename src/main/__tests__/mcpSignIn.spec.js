import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSignIn, signInStatus, activeSignIns, cancelSignIn, cancelAllSignIns, signInState, googleAccount } from '../mcpSignIn'
import { cliError } from '../agentTools'

const GOOGLE = { command: 'uvx', args: ['workspace-mcp', '--permissions', 'gmail:drafts'], env: { GOOGLE_OAUTH_CLIENT_ID: 'id' } }
const OUTLOOK = { command: 'cmd', args: ['/c', 'npx', '-y', '@softeria/ms-365-mcp-server', '--discovery'], env: {} }
const googleRef = { agent: 'codex', name: 'google-workspace', scope: 'user' }
const outlookRef = { agent: 'codex', name: 'outlook', scope: 'user' }

// A server on stdio: `tools` answers each tools/call by name.
function fakeSpawn(tools, calls = []) {
  const spawned = []
  const fn = (command, args, options) => {
    const child = new EventEmitter()
    child.pid = undefined
    child.kill = vi.fn(() => child.emit('exit', 0))
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.stdin.write = (line) => {
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') {
        setTimeout(() => child.stdout.emit('data', JSON.stringify({ id: msg.id, result: { serverInfo: { name: 'fake' } } }) + '\n'))
      } else if (msg.method === 'tools/call') {
        calls.push(msg.params)
        const answer = tools[msg.params.name]
        setTimeout(() => child.stdout.emit('data', JSON.stringify({ id: msg.id, result: typeof answer === 'function' ? answer(msg.params) : answer }) + '\n'))
      }
    }
    spawned.push({ command, args, options, child })
    return child
  }
  fn.spawned = spawned
  return fn
}
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError })
const GOOGLE_PAGE = 'https://accounts.google.com/o/oauth2/auth?client_id=x&state=y'
const dirs = []
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'tessel-signin-'))
  dirs.push(dir)
  return dir
}
function saveGoogleSignIn(dir, name = 'me@gmail.com.json', token = 'r1') {
  mkdirSync(join(dir, '.google_workspace_mcp', 'credentials'), { recursive: true })
  writeFileSync(join(dir, '.google_workspace_mcp', 'credentials', name), JSON.stringify({ refresh_token: token, client_id: 'cid', client_secret: 'cs' }))
}
const until = async (check) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(check()).toBe(true)
}
const fast = { pollMs: 5, expiresMs: 60000, graceMs: 0 }
const killed = (spawnFn, i = 0) => () => spawnFn.spawned[i].child.kill.mock.calls.length > 0

afterEach(() => {
  cancelAllSignIns()
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

describe('startSignIn', () => {
  it('refuses a server it does not know, and a bad address before starting anything', async () => {
    const spawnFn = fakeSpawn({})
    expect(await startSignIn({ name: 'notion' }, {}, { spawnFn })).toEqual({ ok: false, reason: 'unknownServer' })
    expect(await startSignIn({ name: 'constructor' }, {}, { spawnFn })).toEqual({ ok: false, reason: 'unknownServer' })
    for (const email of ['', 'me', '../../x@y', 'a b@c.d']) {
      expect(await startSignIn(googleRef, { email }, { spawnFn, configOf: async () => GOOGLE })).toEqual({ ok: false, reason: 'email' })
    }
    expect(spawnFn.spawned).toEqual([])
  })

  it("never starts a repository's .mcp.json, even one naming the right package", async () => {
    const spawnFn = fakeSpawn({})
    const configOf = vi.fn(async () => OUTLOOK)
    expect(await startSignIn({ ...outlookRef, scope: 'project' }, {}, { spawnFn, configOf })).toEqual({ ok: false, reason: 'projectScope' })
    expect(await signInState({ ...outlookRef, scope: 'project' }, { spawnFn, configOf })).toMatchObject({ signedIn: null, reason: 'projectScope' })
    expect(configOf).not.toHaveBeenCalled()
    expect(spawnFn.spawned).toEqual([])
  })

  it('does not run a different server that has the same name', async () => {
    const spawnFn = fakeSpawn({})
    const others = [
      { command: 'node', args: ['evil.js'], env: {} },
      { transport: 'http', url: 'https://x/workspace-mcp' },
      { command: 'cmd', args: ['/c', 'calc & rem workspace-mcp'], env: {} },
      { command: 'cmd', args: ['/c', 'calc', '&', 'uvx', 'workspace-mcp'], env: {} },
      { command: 'uvx', args: ['evil', 'workspace-mcp'], env: {} },
      { command: 'uvx', args: ['workspace-mcp-evil'], env: {} }
    ]
    for (const other of [
      ...others,
      { command: 'C:\\tmp\\evil\\uvx.exe', args: ['workspace-mcp'], env: {} },
      { command: '/tmp/evil/uvx', args: ['workspace-mcp'], env: {} },
      { command: 'uvx:ads.exe', args: ['workspace-mcp'], env: {} },
      { command: 'C:\\evil\\cmd.exe', args: ['/c', 'uvx', 'workspace-mcp'], env: {} },
      { command: 'uvx', args: ['--from=evil-pkg', 'workspace-mcp'], env: {} },
      { command: 'uvx', args: ['--with', 'evil-pkg', 'workspace-mcp'], env: {} },
      { command: 'uvx', args: ['--index-url=https://evil.example/simple', 'workspace-mcp'], env: {} },
      { command: 'uvx', args: ['workspace-mcp', '--permissions', 'gmail:drafts & calc'], env: {} },
      { command: 'uvx', args: ['workspace-mcp', '--unknown-flag'], env: {} }
    ]) {
      expect(await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => other })).toEqual({ ok: false, reason: 'otherServer' })
    }
    for (const other of [
      { command: '/tmp/evil/npx', args: ['-y', '@softeria/ms-365-mcp-server'], env: {} },
      { command: 'npx', args: ['--call=calc.exe', '@softeria/ms-365-mcp-server'], env: {} },
      { command: 'npx', args: ['-c', 'calc.exe', '@softeria/ms-365-mcp-server'], env: {} },
      { command: 'npx', args: ['--package=evil-pkg', '@softeria/ms-365-mcp-server'], env: {} },
      { command: 'npx', args: ['-y', '@softeria/ms-365-mcp-server', '--call=calc.exe'], env: {} },
      { command: 'cmd', args: ['/c', 'npx', '-y', '@softeria/ms-365-mcp-server', '--allowed-scopes', 'Mail.Read" & calc.exe & rem "'], env: {} }
    ]) {
      expect(await startSignIn(outlookRef, {}, { spawnFn, configOf: async () => other })).toEqual({ ok: false, reason: 'otherServer' })
      expect(await signInState(outlookRef, { spawnFn, configOf: async () => other })).toMatchObject({ signedIn: null, reason: 'otherServer' })
    }
    expect(await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => null })).toEqual({ ok: false, reason: 'notAdded' })
    expect(spawnFn.spawned).toEqual([])
  })

  it('Google: gives the page, runs with the agent settings, and is done when a sign-in is saved', async () => {
    const dir = home()
    const calls = []
    const spawnFn = fakeSpawn({ start_google_auth: text(`ACTION REQUIRED\n   Authorization URL: ${GOOGLE_PAGE}\n2. retry`) }, calls)
    const res = await startSignIn(googleRef, { email: ' me@gmail.com ' }, { spawnFn, configOf: async () => GOOGLE, baseEnv: { PATH: 'p' }, home: dir, ...fast })
    expect(res).toMatchObject({ ok: true, page: GOOGLE_PAGE, code: null })
    expect(calls).toEqual([{ name: 'start_google_auth', arguments: { service_name: 'gmail', user_google_email: 'me@gmail.com' } }])
    expect(spawnFn.spawned[0].options.env).toEqual({ PATH: 'p', GOOGLE_OAUTH_CLIENT_ID: 'id' })
    expect(signInStatus(res.id)).toMatchObject({ state: 'waiting' })
    saveGoogleSignIn(dir)
    await until(killed(spawnFn))
    expect(signInStatus(res.id)).toEqual({ state: 'done', account: 'me@gmail.com' })
    expect(signInStatus(res.id)).toEqual({ state: 'unknown', account: null })
  })

  it('Google, connecting again: an old saved sign-in, or the server refreshing it, is not a new one', async () => {
    const dir = home()
    saveGoogleSignIn(dir, 'me@gmail.com.json', 'old')
    const spawnFn = fakeSpawn({ start_google_auth: text(`x ${GOOGLE_PAGE}`) })
    const res = await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => GOOGLE, home: dir, ...fast })
    saveGoogleSignIn(dir, 'me@gmail.com.json', 'old') // same token, rewritten
    await new Promise((r) => setTimeout(r, 30))
    expect(signInStatus(res.id)).toMatchObject({ state: 'waiting' })
    saveGoogleSignIn(dir, 'me@gmail.com.json', 'new')
    await until(killed(spawnFn))
    expect(signInStatus(res.id)).toEqual({ state: 'done', account: 'me@gmail.com' })
  })

  it('Google: another account picked at Google still finishes, and names that account', async () => {
    const dir = home()
    const spawnFn = fakeSpawn({ start_google_auth: text(`x ${GOOGLE_PAGE}`) })
    const res = await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => GOOGLE, home: dir, ...fast })
    saveGoogleSignIn(dir, 'other@gmail.com.json')
    await until(killed(spawnFn))
    expect(signInStatus(res.id)).toEqual({ state: 'done', account: 'other@gmail.com' })
  })

  it('lets the server answer the browser before stopping it', async () => {
    const dir = home()
    const spawnFn = fakeSpawn({ start_google_auth: text(`x ${GOOGLE_PAGE}`) })
    const res = await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => GOOGLE, home: dir, pollMs: 5, graceMs: 80 })
    saveGoogleSignIn(dir)
    await new Promise((r) => setTimeout(r, 40))
    expect(spawnFn.spawned[0].child.kill).not.toHaveBeenCalled()
    await until(killed(spawnFn))
    expect(signInStatus(res.id).state).toBe('done')
  })

  it('strips dangerous runtime or loader variables from cfg.env, keeping only the service variables', async () => {
    const dir = home()
    const spawnFn = fakeSpawn({ start_google_auth: text(`x ${GOOGLE_PAGE}`) })
    const hostileCfg = {
      ...GOOGLE,
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'sec',
        PATH: 'C:\\evil',
        NODE_OPTIONS: '--require C:\\evil.js',
        UV_INDEX_URL: 'https://evil.example/simple',
        PYTHONPATH: '/tmp/evil',
        npm_config_registry: 'https://evil.example'
      }
    }
    const res = await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => hostileCfg, baseEnv: { PATH: 'C:\\safe' }, home: dir, ...fast })
    expect(res.ok).toBe(true)
    expect(spawnFn.spawned[0].options.env).toEqual({
      PATH: 'C:\\safe',
      GOOGLE_OAUTH_CLIENT_ID: 'id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'sec'
    })
  })

  it('if the server exits during graceMs right after completing sign-in, marks the session done rather than failed', async () => {
    const dir = home()
    const spawnFn = fakeSpawn({ start_google_auth: text(`x ${GOOGLE_PAGE}`) })
    const res = await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => GOOGLE, home: dir, pollMs: 5, graceMs: 500 })
    saveGoogleSignIn(dir)
    await new Promise((r) => setTimeout(r, 30))
    spawnFn.spawned[0].child.emit('exit', 0)
    expect(signInStatus(res.id)).toEqual({ state: 'done', account: 'me@gmail.com' })
  })

  it('cuts a server that floods stdout without a newline', async () => {
    const spawnFn = () => {
      const child = new EventEmitter()
      child.kill = vi.fn(() => child.emit('exit', 1))
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = new EventEmitter()
      child.stdin.write = () => setImmediate(() => child.stdout.emit('data', 'x'.repeat(1100 * 1024)))
      spawnFn.child = child
      return child
    }
    expect(await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => GOOGLE, home: home(), ...fast })).toEqual({ ok: false, reason: 'noAnswer' })
    expect(spawnFn.child.kill).toHaveBeenCalled()
  })

  it("Microsoft: gives the page and the code, and asks the server when it's done", async () => {
    let signedIn = false
    const spawnFn = fakeSpawn({
      login: text('{"error":"device_code_required","message":"To sign in, use a web browser to open the page https://www.microsoft.com/link and enter the code C9AKESZZ to authenticate."}'),
      'verify-login': () => text(JSON.stringify({ success: signedIn }))
    })
    const res = await startSignIn(outlookRef, {}, { spawnFn, configOf: async () => OUTLOOK, ...fast })
    expect(res).toMatchObject({ ok: true, page: 'https://www.microsoft.com/link', code: 'C9AKESZZ' })
    await new Promise((r) => setTimeout(r, 20))
    expect(signInStatus(res.id)).toMatchObject({ state: 'waiting' })
    signedIn = true
    await until(killed(spawnFn))
    expect(signInStatus(res.id)).toEqual({ state: 'done', account: null })
  })

  it('Microsoft already signed in: says so, with no page and no server left', async () => {
    const spawnFn = fakeSpawn({ login: text('{"status":"Already logged in","success":true}') })
    expect(await startSignIn(outlookRef, {}, { spawnFn, configOf: async () => OUTLOOK, ...fast })).toEqual({ ok: true, alreadySignedIn: true })
    expect(spawnFn.spawned[0].child.kill).toHaveBeenCalled()
  })

  it('never follows a page from another site, and stops the server', async () => {
    const spawnFn = fakeSpawn({ start_google_auth: text('open https://accounts.google.com.evil.example/x or https://evil.example/') })
    expect(await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => GOOGLE, home: home(), ...fast })).toEqual({ ok: false, reason: 'noPage' })
    expect(spawnFn.spawned[0].child.kill).toHaveBeenCalled()
  })

  it('reports a server that refuses the sign-in', async () => {
    const spawnFn = fakeSpawn({ start_google_auth: text('boom', true) })
    expect(await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => GOOGLE, home: home(), ...fast })).toEqual({ ok: false, reason: 'noAnswer' })
    expect(spawnFn.spawned[0].child.kill).toHaveBeenCalled()
  })

  it('takes a request from the server for what it is, not for an answer', async () => {
    const spawnFn = fakeSpawn({ start_google_auth: text(`x ${GOOGLE_PAGE}`) })
    const started = startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => GOOGLE, home: home(), ...fast })
    await until(() => spawnFn.spawned.length > 0)
    spawnFn.spawned[0].child.stdout.emit('data', JSON.stringify({ id: 1, method: 'roots/list' }) + '\n')
    expect((await started).ok).toBe(true)
  })

  it('a server that stops, the time running out, and Cancel each end it, and stop the server', async () => {
    const page = text(`x ${GOOGLE_PAGE}`)
    const dir = home()
    let spawnFn = fakeSpawn({ start_google_auth: page })
    const stopped = await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => GOOGLE, home: dir, ...fast })
    spawnFn.spawned[0].child.emit('exit', 1)
    expect(signInStatus(stopped.id).state).toBe('failed')

    spawnFn = fakeSpawn({ start_google_auth: page })
    const expired = await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => GOOGLE, home: dir, pollMs: 5, expiresMs: 15 })
    await until(killed(spawnFn))
    expect(signInStatus(expired.id).state).toBe('expired')

    spawnFn = fakeSpawn({ start_google_auth: page })
    const cancelled = await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => GOOGLE, home: dir, ...fast })
    cancelSignIn(cancelled.id)
    expect(spawnFn.spawned[0].child.kill).toHaveBeenCalled()
    expect(signInStatus(cancelled.id).state).toBe('unknown')
  })

  it('kills the whole tree first, then the process: the children cannot be found once their parent is gone', async () => {
    const order = []
    const spawnFn = fakeSpawn({ start_google_auth: text(`x ${GOOGLE_PAGE}`) })
    const withPid = (...args) => {
      const child = spawnFn(...args)
      child.pid = 4242
      const kill = child.kill
      child.kill = () => {
        order.push('kill')
        kill()
      }
      return child
    }
    const killTree = (pid, then) => {
      order.push(`tree ${pid}`)
      then()
    }
    const r = await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn: withPid, killTree, configOf: async () => GOOGLE, home: home(), ...fast })
    cancelSignIn(r.id)
    expect(order).toEqual(['tree 4242', 'kill'])
  })

  it('a second Connect replaces the first, also one still starting', async () => {
    const dir = home()
    const spawnFn = fakeSpawn({ start_google_auth: text(`x ${GOOGLE_PAGE}`) })
    const opts = { spawnFn, configOf: async () => GOOGLE, home: dir, ...fast }
    const first = await startSignIn(googleRef, { email: 'me@gmail.com' }, opts)
    const second = await startSignIn(googleRef, { email: 'me@gmail.com' }, opts)
    expect(spawnFn.spawned[0].child.kill).toHaveBeenCalled()
    expect(signInStatus(first.id).state).toBe('cancelled')
    expect(signInStatus(second.id).state).toBe('waiting')

    const startingA = startSignIn(googleRef, { email: 'me@gmail.com' }, opts)
    const startingB = startSignIn(googleRef, { email: 'me@gmail.com' }, opts)
    const [a, b] = await Promise.all([startingA, startingB])
    expect([a, b].filter((r) => r.ok)).toHaveLength(1)
    expect([a, b].find((r) => !r.ok).reason).toBe('replaced')
  })

  it('lists what is still waiting, for the page coming back, and closing Tessel stops it all', async () => {
    const dir = home()
    const spawnFn = fakeSpawn({ start_google_auth: text(`x ${GOOGLE_PAGE}`) })
    const res = await startSignIn(googleRef, { email: 'me@gmail.com' }, { spawnFn, configOf: async () => GOOGLE, home: dir, ...fast })
    expect(activeSignIns()).toEqual([{ id: res.id, name: 'google-workspace', page: GOOGLE_PAGE, code: null }])
    cancelAllSignIns()
    expect(activeSignIns()).toEqual([])
    expect(spawnFn.spawned[0].child.kill).toHaveBeenCalled()
  })
})

describe('signInState', () => {
  const okFetch = (status, body = {}) =>
    vi.fn(async () => ({ ok: status === 200, status, json: async () => body }))

  it('Google: nobody signed in, known without asking anyone', async () => {
    const spawnFn = fakeSpawn({})
    const fetchFn = okFetch(200)
    expect(await signInState(googleRef, { spawnFn, fetchFn, home: home() })).toEqual({ signedIn: false, account: null })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(spawnFn.spawned).toEqual([])
  })

  it("Google: asks Google's token address directly, never a server tool that would open a page", async () => {
    const dir = home()
    saveGoogleSignIn(dir)
    const spawnFn = fakeSpawn({})
    const fetchFn = okFetch(200)
    expect(await signInState(googleRef, { spawnFn, fetchFn, home: dir })).toEqual({ signedIn: true, account: 'me@gmail.com' })
    expect(spawnFn.spawned).toEqual([])
    const [url, options] = fetchFn.mock.calls[0]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(Object.fromEntries(options.body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'cid', client_secret: 'cs' })
  })

  it('Google: a saved token address is ignored', async () => {
    const dir = home()
    mkdirSync(join(dir, '.google_workspace_mcp', 'credentials'), { recursive: true })
    writeFileSync(join(dir, '.google_workspace_mcp', 'credentials', 'me@gmail.com.json'), JSON.stringify({ refresh_token: 'r', client_id: 'c', token_uri: 'https://evil.example/token' }))
    const fetchFn = okFetch(200)
    await signInState(googleRef, { fetchFn, home: dir })
    expect(fetchFn.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token')
  })

  it('Google: a sign-in that ended, and one that cannot be told', async () => {
    const dir = home()
    saveGoogleSignIn(dir)
    expect(await signInState(googleRef, { fetchFn: okFetch(400, { error: 'invalid_grant' }), home: dir })).toEqual({ signedIn: false, account: 'me@gmail.com' })
    expect(await signInState(googleRef, { fetchFn: okFetch(503), home: dir })).toEqual({ signedIn: null, account: 'me@gmail.com' })
    const offline = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await signInState(googleRef, { fetchFn: offline, home: dir })).toEqual({ signedIn: null, account: 'me@gmail.com' })
  })

  it('Microsoft: asks the server, and says when it cannot tell', async () => {
    const yes = fakeSpawn({ 'verify-login': text('{"success":true}') })
    expect(await signInState(outlookRef, { spawnFn: yes, configOf: async () => OUTLOOK })).toEqual({ signedIn: true, account: null })
    expect(yes.spawned[0].child.kill).toHaveBeenCalled()
    const no = fakeSpawn({ 'verify-login': text('{"success":false,"message":"Login failed: No valid token found"}') })
    expect(await signInState(outlookRef, { spawnFn: no, configOf: async () => OUTLOOK })).toEqual({ signedIn: false, account: null })
    const broken = fakeSpawn({ 'verify-login': text('boom', true) })
    expect(await signInState(outlookRef, { spawnFn: broken, configOf: async () => OUTLOOK })).toEqual({ signedIn: null, account: null, reason: 'noAnswer' })
  })

  it('a server that is not there or another one', async () => {
    const spawnFn = fakeSpawn({})
    expect(await signInState(outlookRef, { spawnFn, configOf: async () => null })).toMatchObject({ signedIn: null, reason: 'notAdded' })
    expect(await signInState(outlookRef, { spawnFn, configOf: async () => GOOGLE })).toMatchObject({ signedIn: null, reason: 'otherServer' })
    expect(spawnFn.spawned).toEqual([])
  })
})

describe('googleAccount', () => {
  it('ignores the state file, names that are not addresses, broken names and files without a sign-in', () => {
    const dir = home()
    saveGoogleSignIn(dir, 'oauth_states.json')
    saveGoogleSignIn(dir, 'notes.json')
    saveGoogleSignIn(dir, '%E0%A4%A.json')
    writeFileSync(join(dir, '.google_workspace_mcp', 'credentials', 'empty@gmail.com.json'), '{}')
    writeFileSync(join(dir, '.google_workspace_mcp', 'credentials', 'broken@gmail.com.json'), 'not json')
    expect(googleAccount(dir)).toBeNull()
    saveGoogleSignIn(dir, 'me%2Bwork@gmail.com.json')
    expect(googleAccount(dir)).toBe('me+work@gmail.com')
  })
})

describe('cliError', () => {
  it('never repeats a failed command line: it holds the server secrets', () => {
    const res = { stderr: '', stdout: '', error: 'Command failed: powershell.exe -EncodedCommand c2VjcmV0' }
    expect(cliError(res, 'could not add')).toBe('could not add')
    expect(cliError({ error: 'spawn ENOENT' }, 'could not add')).toBe('spawn ENOENT')
    expect(cliError({ stderr: 'config locked', error: 'Command failed: x' }, 'could not add')).toBe('config locked')
  })
})
