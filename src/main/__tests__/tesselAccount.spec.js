// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTesselAccount, findAppLink } from '../tesselAccount'

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
  const onSignedIn = vi.fn()
  const answers = { '/auth/token': () => jsonResponse(200, { token: TOKEN, expires_at: Date.now() + 1000000, user: USER }), '/api/me': () => jsonResponse(200, { user: USER }), '/auth/logout': () => jsonResponse(204, {}), ...over.answers }
  const fetchFn = vi.fn(async (url, options = {}) => {
    calls.push({ url, ...options })
    const answer = answers[new URL(url).pathname]
    return typeof answer === 'function' ? answer(options) : answer
  })
  const account = createTesselAccount({ dir, safeStorage: over.safeStorage || sealing, openExternal: over.openExternal || (async (url) => opened.push(url)), onSignedIn, onDeleted: over.onDeleted, scheme: 'tessel', fetchFn, apiUrl: API, accountUrl: ACCOUNT, signInMs: over.signInMs })
  accounts.push(account)
  return { dir, account, opened, calls, answers, onSignedIn }
}
const back = (params) => `tessel://callback?${new URLSearchParams(params)}`
async function startedSignIn(env) {
  const view = await env.account.signIn()
  expect(view.signingIn).toBe(true)
  const url = new URL(env.opened.at(-1))
  return { url, state: url.searchParams.get('state'), challenge: url.searchParams.get('challenge') }
}
async function signedIn(env) {
  const { state } = await startedSignIn(env)
  await env.account.handleLink(back({ code: 'one-time-code', state }))
}

afterEach(() => {
  accounts.splice(0).forEach((a) => a.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

describe('for the rest of the main process', () => {
  it('a request with the session, signed out by a 401 like the others, and no request without one', async () => {
    const env = setup({ answers: { '/api/sync': () => jsonResponse(200, { version: 1 }) } })
    expect(env.account.userId()).toBeNull()
    expect(await env.account.authed('/api/sync')).toBeNull()
    expect(env.calls).toHaveLength(0)
    await signedIn(env)
    expect(env.account.userId()).toBe('u1')
    const res = await env.account.authed('/api/sync', { method: 'PUT', body: 'x', headers: { 'content-type': 'application/json' }, timeoutMs: 1000 })
    expect(res.status).toBe(200)
    const sent = env.calls.at(-1)
    expect(sent.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` })
    expect(sent.signal).toBeInstanceOf(AbortSignal)
    expect(sent.timeoutMs).toBeUndefined()
    env.answers['/api/sync'] = () => jsonResponse(401, {})
    expect(await env.account.authed('/api/sync')).toBeNull()
    expect((await env.account.status()).signedIn).toBe(false)
    expect(env.account.userId()).toBeNull()
  })

  it('offline, it throws for the caller to decide, and stays signed in', async () => {
    const env = setup({ answers: { '/api/sync': () => { throw new TypeError('fetch failed') } } })
    await signedIn(env)
    await expect(env.account.authed('/api/sync')).rejects.toThrow('fetch failed')
    expect((await env.account.status()).signedIn).toBe(true)
  })

  it('what is deleted is said once it is confirmed', async () => {
    const onDeleted = vi.fn()
    const env = setup({ onDeleted, answers: { '/api/me': () => jsonResponse(500, {}) } })
    await signedIn(env)
    expect((await env.account.deleteAccount()).deleted).toBe(false)
    expect(onDeleted).not.toHaveBeenCalled()
    env.answers['/api/me'] = () => jsonResponse(204, {})
    expect((await env.account.deleteAccount()).deleted).toBe(true)
    expect(onDeleted).toHaveBeenCalledTimes(1)
  })
})

describe('signing in', () => {
  it('opens the web page with a PKCE challenge, naming this app so the browser can come back to it', async () => {
    const env = setup()
    const { url, state, challenge } = await startedSignIn(env)
    expect(url.origin + url.pathname).toBe(`${ACCOUNT}/login`)
    expect(url.searchParams.get('app')).toBe('tessel')
    expect(url.searchParams.get('port')).toBeNull()
    expect(state.length).toBeGreaterThanOrEqual(16)
    expect(challenge).toHaveLength(43)
    expect((await env.account.status()).signingIn).toBe(true)
  })

  it('swaps the code with the verifier that matches the challenge, keeps the session sealed, and says so once', async () => {
    const env = setup()
    const { state, challenge } = await startedSignIn(env)
    await env.account.handleLink(back({ code: 'one-time-code', state }))

    const swap = env.calls.find((c) => c.url === `${API}/auth/token`)
    const sent = JSON.parse(swap.body)
    expect(sent.code).toBe('one-time-code')
    expect(createHash('sha256').update(sent.verifier).digest('base64url')).toBe(challenge)
    expect(swap.signal).toBeInstanceOf(AbortSignal)
    expect(env.onSignedIn).toHaveBeenCalledTimes(1)

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
    ['a wrong state', (state) => back({ code: 'x', state: `${state}x` })],
    ['no state', () => 'tessel://callback?code=x'],
    ['another path', (state) => `tessel://other?${new URLSearchParams({ code: 'x', state })}`],
    ['another app', (state) => `tessel-dev://callback?${new URLSearchParams({ code: 'x', state })}`],
    ['a web address', (state) => `https://callback/?${new URLSearchParams({ code: 'x', state })}`],
    ['something that is no address', () => 'not a link']
  ])('a link with %s does nothing at all: any page can try one', async (_what, link) => {
    const env = setup()
    const { state } = await startedSignIn(env)
    await env.account.handleLink(link(state))
    expect(env.calls).toEqual([])
    expect(env.onSignedIn).not.toHaveBeenCalled()
    expect((await env.account.status()).signingIn).toBe(true)
  })

  it('with no sign-in waiting, a link does nothing', async () => {
    const env = setup()
    await env.account.handleLink(back({ code: 'x', state: 's'.repeat(24) }))
    expect(env.calls).toEqual([])
    expect((await env.account.status()).signedIn).toBe(false)
  })

  it('the same link twice, even at once, swaps the code once', async () => {
    const env = setup()
    const { state } = await startedSignIn(env)
    const link = back({ code: 'c', state })
    await Promise.all([env.account.handleLink(link), env.account.handleLink(link)])
    await env.account.handleLink(link)
    expect(env.calls.filter((c) => c.url === `${API}/auth/token`)).toHaveLength(1)
    expect(env.onSignedIn).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a refusal at the provider', 'access_denied', 'denied'],
    ['a failure on the server', 'sign_in_failed', 'failed'],
    ['an account already on that address', 'account_exists', 'accountExists']
  ])('reports %s, and stops waiting', async (_what, error, code) => {
    const env = setup()
    const { state } = await startedSignIn(env)
    await env.account.handleLink(back({ error, state }))
    expect(await env.account.status()).toMatchObject({ signedIn: false, signingIn: false, error: code })
    expect(env.onSignedIn).not.toHaveBeenCalled()
  })

  it.each([
    ['refused by the server', () => jsonResponse(400, { error: 'invalid_grant' }), 'refused'],
    [
      'with no way to reach the server',
      () => {
        throw new Error('offline')
      },
      'offline'
    ],
    [
      'answered with something that is not JSON, by a proxy for example',
      () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json')
        }
      }),
      'refused'
    ],
    ['answered with the JSON word null', () => ({ ok: true, status: 200, json: async () => null }), 'refused']
  ])('a code %s ends the sign-in and keeps nothing', async (_what, answer, error) => {
    const env = setup({ answers: { '/auth/token': answer } })
    const { state } = await startedSignIn(env)
    await env.account.handleLink(back({ code: 'c', state }))
    expect(await env.account.status()).toMatchObject({ signedIn: false, signingIn: false, error })
    expect(existsSync(join(env.dir, 'session.json'))).toBe(false)
    expect(env.onSignedIn).not.toHaveBeenCalled()
  })

  it('ends by itself when the time runs out', async () => {
    const env = setup({ signInMs: 20 })
    await startedSignIn(env)
    await new Promise((r) => setTimeout(r, 60))
    expect(await env.account.status()).toMatchObject({ signingIn: false, error: 'expired' })
  })

  it('Cancel stops it, and a second sign-in replaces the first', async () => {
    const env = setup()
    const first = await startedSignIn(env)
    const second = await startedSignIn(env)
    expect(second.state).not.toBe(first.state)
    await env.account.handleLink(back({ code: 'old', state: first.state }))
    expect(env.calls).toEqual([])
    expect((await env.account.cancelSignIn()).signingIn).toBe(false)
    await env.account.handleLink(back({ code: 'late', state: second.state }))
    expect(env.calls).toEqual([])
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

describe('what happens while a code is being swapped', () => {
  // A server that answers only when told to.
  function held() {
    let release
    const gate = new Promise((resolve) => (release = resolve))
    const env = setup({
      answers: {
        '/auth/token': async () => {
          await gate
          return jsonResponse(200, { token: TOKEN, expires_at: Date.now() + 1000000, user: USER })
        }
      }
    })
    return { env, release }
  }
  const logoutCalled = (env) => env.calls.some((c) => c.url === `${API}/auth/logout` && c.headers.authorization === `Bearer ${TOKEN}`)

  it.each([
    ['Cancel', (account) => account.cancelSignIn()],
    ['signing out', (account) => account.signOut()]
  ])('%s wins: no session comes back, and the one the server just opened ends', async (_what, act) => {
    const { env, release } = held()
    const { state } = await startedSignIn(env)
    const swapping = env.account.handleLink(back({ code: 'c', state }))
    await act(env.account)
    release()
    await swapping
    expect(await env.account.status()).toMatchObject({ signedIn: false, signingIn: false })
    expect(existsSync(join(env.dir, 'session.json'))).toBe(false)
    expect(env.onSignedIn).not.toHaveBeenCalled()
    expect(logoutCalled(env)).toBe(true)
  })

  it('a new sign-in started meanwhile is not ended by the old one', async () => {
    const { env, release } = held()
    const { state } = await startedSignIn(env)
    const swapping = env.account.handleLink(back({ code: 'c', state }))
    await env.account.signIn()
    release()
    await swapping
    expect(await env.account.status()).toMatchObject({ signedIn: false, signingIn: true })
    expect(env.onSignedIn).not.toHaveBeenCalled()
  })

  it('an odd error in a link shows nothing odd', async () => {
    const env = setup()
    const { state } = await startedSignIn(env)
    await env.account.handleLink(back({ error: 'constructor', state }))
    expect((await env.account.status()).error).toBe('failed')
  })
})

describe('finding the link in a command line', () => {
  it('finds this app\'s link, and no other', () => {
    const link = 'tessel://callback?code=c&state=s'
    expect(findAppLink(['electron.exe', 'C:\\Tessel', link], 'tessel')).toBe(link)
    expect(findAppLink(['electron.exe', 'tessel-dev://callback?code=c'], 'tessel')).toBeUndefined()
    expect(findAppLink(['electron.exe', '--flag'], 'tessel')).toBeUndefined()
    expect(findAppLink(undefined, 'tessel')).toBeUndefined()
  })
})

describe('who is signed in, for what was connected for them', () => {
  it('is known in the main process, and not told to the window', async () => {
    const env = setup()
    expect(env.account.userId()).toBeNull()
    await signedIn(env)
    expect(env.account.userId()).toBe('u1')
    expect(JSON.stringify(await env.account.status())).not.toContain('u1')
    await env.account.signOut()
    expect(env.account.userId()).toBeNull()
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

describe("Tessel's Google app", () => {
  it('comes from the server with the session, and is the same shape for the page', async () => {
    const env = setup({ answers: { '/api/google-client': () => jsonResponse(200, { client_id: 'id', client_secret: 'secret' }) } })
    await signedIn(env)
    expect(await env.account.googleClient()).toEqual({ clientId: 'id', clientSecret: 'secret' })
    expect(env.calls.at(-1).headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('without a session it asks nothing', async () => {
    const env = setup()
    expect(await env.account.googleClient()).toEqual({ error: 'signedOut' })
    expect(env.calls).toEqual([])
  })

  it.each([
    ['a session that ended', () => jsonResponse(401, {}), 'signedOut'],
    ['not set up on the server', () => jsonResponse(503, {}), 'failed'],
    ['an odd answer', () => jsonResponse(200, null), 'failed'],
    [
      'being offline',
      () => {
        throw new Error('offline')
      },
      'offline'
    ]
  ])('%s says so', async (_what, answer, error) => {
    const env = setup({ answers: { '/api/google-client': answer } })
    await signedIn(env)
    expect(await env.account.googleClient()).toEqual({ error })
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
