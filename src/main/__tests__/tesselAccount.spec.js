// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTesselAccount } from '../tesselAccount'

const API = 'https://api.test'
const ACCOUNT = 'https://account.test'
const USER = { id: 'u1', email: 'me@gmail.com', name: 'Me' }
const TOKEN = 'the-session-token-abcdefghijklmnop'

const sealing = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'dpapi',
  encryptString: (text) => Buffer.from(`sealed:${text}`),
  decryptString: (buf) => buf.toString().replace(/^sealed:/, '')
}
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

const dirs = []
const accounts = []
function setup(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tessel-account-'))
  dirs.push(dir)
  const opened = []
  const calls = []
  const answers = { '/auth/token': () => jsonResponse(200, { token: TOKEN, expires_at: Date.now() + 1000000, user: USER }), '/api/me': () => jsonResponse(200, { user: USER }), '/auth/logout': () => jsonResponse(204, {}), ...over.answers }
  const fetchFn = vi.fn(async (url, options = {}) => {
    calls.push({ url, ...options })
    const answer = answers[new URL(url).pathname]
    return typeof answer === 'function' ? answer(options) : answer
  })
  const account = createTesselAccount({ dir, safeStorage: over.safeStorage || sealing, openExternal: over.openExternal || (async (url) => opened.push(url)), fetchFn, apiUrl: API, accountUrl: ACCOUNT, signInMs: over.signInMs })
  accounts.push(account)
  return { dir, account, opened, calls, answers }
}
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject)
  })
}
async function startedSignIn(env) {
  const view = await env.account.signIn()
  expect(view.signingIn).toBe(true)
  const url = new URL(env.opened.at(-1))
  return { url, port: Number(url.searchParams.get('port')), state: url.searchParams.get('state'), challenge: url.searchParams.get('challenge') }
}
async function signedIn(env) {
  const { port, state } = await startedSignIn(env)
  await get(port, `/callback?${new URLSearchParams({ code: 'one-time-code', state })}`)
}

afterEach(() => {
  accounts.splice(0).forEach((a) => a.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

describe('signing in', () => {
  it('opens the server page with a PKCE challenge, on an IPv4 listener', async () => {
    const env = setup()
    const { url, port, state, challenge } = await startedSignIn(env)
    expect(url.origin + url.pathname).toBe(`${ACCOUNT}/login`)
    expect(port).toBeGreaterThan(1023)
    expect(state.length).toBeGreaterThanOrEqual(16)
    expect(challenge).toHaveLength(43)
    expect((await env.account.status()).signingIn).toBe(true)
  })

  it('swaps the code with the verifier that matches the challenge, then keeps the session sealed', async () => {
    const env = setup()
    const { port, state, challenge } = await startedSignIn(env)
    const res = await get(port, `/callback?${new URLSearchParams({ code: 'one-time-code', state })}`)
    expect(res.status).toBe(200)
    expect(res.body).toContain('You are signed in')

    const swap = env.calls.find((c) => c.url === `${API}/auth/token`)
    const sent = JSON.parse(swap.body)
    expect(sent.code).toBe('one-time-code')
    expect(createHash('sha256').update(sent.verifier).digest('base64url')).toBe(challenge)
    expect(swap.signal).toBeInstanceOf(AbortSignal)

    expect(await env.account.status()).toMatchObject({ signedIn: true, signingIn: false, user: { email: 'me@gmail.com', name: 'Me' }, error: null })
    const onDisk = readFileSync(join(env.dir, 'session.json'), 'utf8')
    expect(onDisk).not.toContain(TOKEN)
    expect(onDisk).not.toContain('me@gmail.com')
    expect(JSON.parse(onDisk).v).toBe(1)
    expect(readdirSync(env.dir)).toEqual(['session.json'])
  })

  it('what reaches the page never holds the token', async () => {
    const env = setup()
    await signedIn(env)
    expect(JSON.stringify(await env.account.status({ check: true }))).not.toContain(TOKEN)
  })

  it.each([
    ['a wrong state', (state) => `/callback?${new URLSearchParams({ code: 'x', state: `${state}x` })}`, {}],
    ['no state', () => '/callback?code=x', {}],
    ['another path', (state) => `/other?${new URLSearchParams({ code: 'x', state })}`, {}],
    ['another host name', (state) => `/callback?${new URLSearchParams({ code: 'x', state })}`, { host: 'evil.example' }]
  ])('%s neither ends the sign-in nor reaches the server', async (_what, path, headers) => {
    const env = setup()
    const { port, state } = await startedSignIn(env)
    const res = await get(port, path(state), headers)
    expect(res.status).toBe(404)
    expect(res.body).toBe('')
    expect(env.calls).toEqual([])
    expect((await env.account.status()).signingIn).toBe(true)
  })

  it.each([
    ['a refusal at the provider', 'access_denied', 'denied'],
    ['a failure on the server', 'sign_in_failed', 'failed'],
    ['an account already on that address', 'account_exists', 'accountExists']
  ])('reports %s, and stops listening', async (_what, error, code) => {
    const env = setup()
    const { port, state } = await startedSignIn(env)
    const res = await get(port, `/callback?${new URLSearchParams({ error, state })}`)
    expect(res.body).toContain('did not finish')
    expect(await env.account.status()).toMatchObject({ signedIn: false, signingIn: false, error: code })
    await expect(get(port, '/callback')).rejects.toThrow()
  })

  it('reports a code the server refuses, and being offline, without keeping anything', async () => {
    let env = setup({ answers: { '/auth/token': () => jsonResponse(400, { error: 'invalid_grant' }) } })
    let started = await startedSignIn(env)
    await get(started.port, `/callback?${new URLSearchParams({ code: 'c', state: started.state })}`)
    expect(await env.account.status()).toMatchObject({ signedIn: false, error: 'refused' })
    expect(existsSync(join(env.dir, 'session.json'))).toBe(false)

    env = setup({
      answers: {
        '/auth/token': () => {
          throw new Error('offline')
        }
      }
    })
    started = await startedSignIn(env)
    const res = await get(started.port, `/callback?${new URLSearchParams({ code: 'c', state: started.state })}`)
    expect(res.body).toContain('did not finish')
    expect(await env.account.status()).toMatchObject({ signedIn: false, error: 'offline' })
  })

  it('ends by itself when the time runs out', async () => {
    const env = setup({ signInMs: 20 })
    await startedSignIn(env)
    await new Promise((r) => setTimeout(r, 60))
    expect(await env.account.status()).toMatchObject({ signingIn: false, error: 'expired' })
  })

  it('Cancel stops listening, and a second sign-in replaces the first', async () => {
    const env = setup()
    const first = await startedSignIn(env)
    const second = await startedSignIn(env)
    expect(second.state).not.toBe(first.state)
    await expect(get(first.port, '/callback')).rejects.toThrow()
    expect((await env.account.cancelSignIn()).signingIn).toBe(false)
    await expect(get(second.port, '/callback')).rejects.toThrow()
  })

  it('a browser that cannot be opened ends it', async () => {
    const env = setup({
      openExternal: async () => {
        throw new Error('no browser')
      }
    })
    expect(await env.account.signIn()).toMatchObject({ signingIn: false, error: 'failed' })
  })

  it('without secure storage it refuses to start, and never writes a token in clear', async () => {
    const env = setup({ safeStorage: { ...sealing, isEncryptionAvailable: () => false } })
    expect(await env.account.signIn()).toMatchObject({ signingIn: false, error: 'noSecureStorage' })
    expect(env.opened).toEqual([])
    expect(readdirSync(env.dir)).toEqual([])
  })
})

describe('staying signed in', () => {
  it('comes back after a restart', async () => {
    const env = setup()
    await signedIn(env)
    const again = createTesselAccount({ dir: env.dir, safeStorage: sealing, openExternal: async () => {}, fetchFn: async () => jsonResponse(200, {}), apiUrl: API })
    expect(await again.status()).toMatchObject({ signedIn: true, user: { email: 'me@gmail.com' } })
  })

  it('an expired or unreadable file reads as signed out', async () => {
    const env = setup()
    const open = () => createTesselAccount({ dir: env.dir, safeStorage: sealing, openExternal: async () => {}, apiUrl: API })
    writeFileSync(join(env.dir, 'session.json'), JSON.stringify({ v: 1, ciphertext: Buffer.from(`sealed:${JSON.stringify({ token: 't', expires_at: 1, user: USER })}`).toString('base64') }))
    expect((await open().status()).signedIn).toBe(false)
    writeFileSync(join(env.dir, 'session.json'), 'not json')
    expect((await open().status()).signedIn).toBe(false)
  })

  it('checking asks with the session, follows a new address, and signs out a session the server ended', async () => {
    const env = setup()
    await signedIn(env)
    env.answers['/api/me'] = () => jsonResponse(200, { user: { ...USER, email: 'new@gmail.com' } })
    expect((await env.account.status({ check: true })).user.email).toBe('new@gmail.com')
    env.answers['/api/me'] = () => jsonResponse(200, { user: { ...USER, email: 'new@gmail.com', has_password: true, has_github: true } })
    expect((await env.account.status({ check: true })).user).toMatchObject({ hasPassword: true, hasGitHub: true, hasGoogle: false })
    expect(env.calls.at(-1).headers.authorization).toBe(`Bearer ${TOKEN}`)
    env.answers['/api/me'] = () => jsonResponse(401, {})
    expect((await env.account.status({ check: true })).signedIn).toBe(false)
    expect(existsSync(join(env.dir, 'session.json'))).toBe(false)
  })

  it('offline or a server error keeps the sign-in, and says so', async () => {
    const env = setup()
    await signedIn(env)
    env.answers['/api/me'] = () => {
      throw new Error('offline')
    }
    expect(await env.account.status({ check: true })).toMatchObject({ signedIn: true, offline: true })
    env.answers['/api/me'] = () => jsonResponse(503, {})
    expect(await env.account.status({ check: true })).toMatchObject({ signedIn: true, offline: true })
    env.answers['/api/me'] = () => jsonResponse(200, { user: USER })
    expect(await env.account.status({ check: true })).toMatchObject({ signedIn: true, offline: false })
  })
})

describe('the listener and odd answers', () => {
  it('a request whose address cannot be read gets a 404 and leaves the sign-in waiting', async () => {
    const env = setup()
    const { port } = await startedSignIn(env)
    const answer = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write('GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'))
      let text = ''
      socket.on('data', (d) => (text += d))
      socket.on('end', () => resolve(text))
      socket.on('error', reject)
    })
    expect(answer).toContain('404')
    expect((await env.account.status()).signingIn).toBe(true)
  })

  it.each([
    ['not JSON, from a proxy for example', async () => { throw new Error('not json') }],
    ['the JSON word null', async () => null]
  ])('an answer that is %s ends the sign-in instead of hanging', async (_what, json) => {
    const env = setup({ answers: { '/auth/token': () => ({ ok: true, status: 200, json }) } })
    const { port, state } = await startedSignIn(env)
    const res = await get(port, `/callback?${new URLSearchParams({ code: 'c', state })}`)
    expect(res.body).toContain('did not finish')
    expect(await env.account.status()).toMatchObject({ signedIn: false, signingIn: false, error: 'refused' })
  })
})

describe('signing out and deleting', () => {
  it('a session that already ended does not report the account as deleted', async () => {
    const env = setup()
    await signedIn(env)
    env.answers['/api/me'] = () => jsonResponse(401, {})
    expect(await env.account.deleteAccount()).toMatchObject({ deleted: false, signedIn: false, error: 'signedOut' })
    expect(existsSync(join(env.dir, 'session.json'))).toBe(false)
  })

  it('signs out on the server and here', async () => {
    const env = setup()
    await signedIn(env)
    expect((await env.account.signOut()).signedIn).toBe(false)
    const out = env.calls.find((c) => c.url === `${API}/auth/logout`)
    expect(out.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(existsSync(join(env.dir, 'session.json'))).toBe(false)
  })

  it('offline still signs out here', async () => {
    const env = setup({
      answers: {
        '/auth/logout': () => {
          throw new Error('offline')
        }
      }
    })
    await signedIn(env)
    expect((await env.account.signOut()).signedIn).toBe(false)
    expect(existsSync(join(env.dir, 'session.json'))).toBe(false)
  })

  it('deleting asks the server first, and forgets the session once it agrees', async () => {
    const env = setup()
    await signedIn(env)
    env.answers['/api/me'] = () => jsonResponse(204, {})
    const res = await env.account.deleteAccount()
    expect(res).toMatchObject({ deleted: true, signedIn: false })
    const call = env.calls.at(-1)
    expect(call.method).toBe('DELETE')
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(existsSync(join(env.dir, 'session.json'))).toBe(false)
  })

  it('a failed delete changes nothing, and says so', async () => {
    const env = setup()
    await signedIn(env)
    env.answers['/api/me'] = () => jsonResponse(500, {})
    expect(await env.account.deleteAccount()).toMatchObject({ deleted: false, signedIn: true, error: 'failed' })
    env.answers['/api/me'] = () => {
      throw new Error('offline')
    }
    expect(await env.account.deleteAccount()).toMatchObject({ deleted: false, signedIn: true, error: 'offline' })
    expect(existsSync(join(env.dir, 'session.json'))).toBe(true)
  })
})

describe('a link to choose a password', () => {
  const sent = () => jsonResponse(202, { ok: true })

  it('asks the server with the session, and sends no password', async () => {
    const env = setup({ answers: { '/api/password-link': sent } })
    await signedIn(env)
    expect(await env.account.passwordLink()).toMatchObject({ done: 'linkSent', signedIn: true, error: null })
    const call = env.calls.at(-1)
    expect(call.url).toBe(`${API}/api/password-link`)
    expect(call.method).toBe('POST')
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(call.body).toBeUndefined()
  })

  it('a session the server ended signs out here', async () => {
    const env = setup({ answers: { '/api/password-link': () => jsonResponse(401, {}) } })
    await signedIn(env)
    expect(await env.account.passwordLink()).toMatchObject({ signedIn: false, error: 'signedOut' })
    expect(existsSync(join(env.dir, 'session.json'))).toBe(false)
  })

  it.each([
    ['too many tries', () => jsonResponse(429, {}), 'rateLimited'],
    ['a server error', () => jsonResponse(500, {}), 'failed'],
    [
      'being offline',
      () => {
        throw new Error('offline')
      },
      'offline'
    ]
  ])('%s says so, and stays signed in', async (_what, answer, error) => {
    const env = setup({ answers: { '/api/password-link': answer } })
    await signedIn(env)
    const view = await env.account.passwordLink()
    expect(view).toMatchObject({ signedIn: true, error })
    expect(view.done).toBeUndefined()
  })

  it('without a session it sends nothing', async () => {
    const env = setup()
    expect(await env.account.passwordLink()).toMatchObject({ error: 'signedOut' })
    expect(env.calls).toEqual([])
  })
})
