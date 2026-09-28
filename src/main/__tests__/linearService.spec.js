// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { createLinearService } from '../linearService'

const KEY = 'lin_api_FAKE_SECRET_0001'
const OTHER = 'lin_api_FAKE_SECRET_0002'
const viewer = { id: 'user-1', name: 'User', displayName: 'User', email: 'test@example.invalid' }
const organization = { id: 'org-1', name: 'Workspace', urlKey: 'workspace' }
const connectData = (id = 'user-1') => ({ viewer: { ...viewer, id }, organization })
const team = { id: 'team-1', name: 'Backend', key: 'BE' }
const state = { id: 'state-1', name: 'In Progress', type: 'started', position: 1, color: '#123456' }
const row = (id = 'issue-1') => ({
  id,
  identifier: 'BE-123',
  title: 'Fix it',
  description: 'Details',
  url: 'https://linear.app/workspace/issue/BE-123/fix-it',
  priority: 1,
  state,
  team,
  assignee: viewer,
  creator: viewer,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z'
})
const connection = (nodes = [row()], hasNextPage = false) => ({
  nodes,
  pageInfo: { hasNextPage, endCursor: hasNextPage ? 'next-cursor' : null }
})
const response = (data, options = {}) =>
  new Response(JSON.stringify({ data }), { status: 200, ...options })
const defer = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let root, dir, fetcher, safeStorage, service, tick
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-linear-service-'))
  dir = join(root, 'linear')
  tick = 1000000
  fetcher = vi.fn(async () => response(connectData()))
  const crypt = (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 91))
  safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'test-secure-store'),
    encryptString: vi.fn((value) => crypt(value)),
    decryptString: vi.fn((value) => crypt(value).toString('utf8'))
  }
  service = createLinearService({
    dir,
    fetch: fetcher,
    safeStorage,
    now: () => tick,
    timeoutMs: 1000
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  const target = resolve(root)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-linear-service-'))
    throw new Error('Unexpected fixture path')
  fs.rmSync(target, { recursive: true, force: true })
})
const file = () => join(dir, 'credentials.json')
async function connect() {
  expect((await service.connect({ key: KEY })).ok).toBe(true)
  fetcher.mockClear()
}

describe('Linear service with isolated credentials and mocked GraphQL', () => {
  it('keeps status local, validates only an explicit connect, encrypts the entire record and restores locally', async () => {
    expect(await service.status()).toEqual({ ok: true, configured: false })
    expect(fetcher).not.toHaveBeenCalled()
    const open = vi.spyOn(fs, 'openSync')
    const result = await service.connect({ key: KEY })
    expect(result).toEqual({ ok: true, configured: true, viewer, organization })
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe('https://api.linear.app/graphql')
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: KEY }
    })
    expect(JSON.parse(options.body)).toMatchObject({ variables: {} })
    expect(options.body).not.toContain(KEY)
    const saved = fs.readFileSync(file(), 'utf8')
    expect(saved).not.toContain(KEY)
    expect(saved).not.toContain(viewer.email)
    expect(open.mock.calls.some((args) => args[1] === 'wx' && args[2] === 0o600)).toBe(true)
    const restarted = createLinearService({ dir, fetch: fetcher, safeStorage })
    expect(await restarted.status()).toEqual(result)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(dir)).toEqual(['credentials.json'])
  })

  it.each(['unavailable', 'basic_text'])(
    'refuses %s storage without transmitting or persisting a key',
    async (kind) => {
      if (kind === 'unavailable') safeStorage.isEncryptionAvailable.mockReturnValue(false)
      else safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text')
      expect(await service.connect({ key: KEY })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/Secure credential storage/)
      })
      expect(fetcher).not.toHaveBeenCalled()
      expect(fs.existsSync(file())).toBe(false)
    }
  )

  it('preserves a good connection after an invalid key or a partial GraphQL error, without exposing remote errors', async () => {
    await connect()
    const saved = fs.readFileSync(file(), 'utf8')
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: connectData(), errors: [{ message: `secret ${OTHER}` }] })
      )
    )
    const result = await service.connect({ key: OTHER })
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain(OTHER)
    expect(fs.readFileSync(file(), 'utf8')).toBe(saved)
    expect(await service.status()).toMatchObject({ configured: true, viewer })
    fetcher.mockResolvedValueOnce(new Response(OTHER, { status: 401 }))
    expect(await service.connect({ key: OTHER })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/refused/)
    })
    expect(fs.readFileSync(file(), 'utf8')).toBe(saved)
  })

  it('preserves existing bytes on failed encryption/rename and cleans temporary files', async () => {
    await connect()
    const saved = fs.readFileSync(file(), 'utf8')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error(KEY)
    })
    expect(await service.connect({ key: OTHER })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/previous connection/)
    })
    rename.mockRestore()
    expect(fs.readFileSync(file(), 'utf8')).toBe(saved)
    expect(fs.readdirSync(dir)).toEqual(['credentials.json'])
    safeStorage.encryptString.mockImplementationOnce(() => {
      throw new Error(OTHER)
    })
    expect(JSON.stringify(await service.connect({ key: OTHER }))).not.toContain(OTHER)
    expect(fs.readFileSync(file(), 'utf8')).toBe(saved)
  })

  it('reports unreadable/corrupt credentials without deleting or returning ciphertext', async () => {
    fs.mkdirSync(dir)
    fs.writeFileSync(file(), '{malformed-private-data')
    const result = await service.status()
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private-data')
    expect(fs.readFileSync(file(), 'utf8')).toBe('{malformed-private-data')
    expect(fetcher).not.toHaveBeenCalled()
    expect(await service.disconnect()).toEqual({ ok: true, configured: false })
  })

  it('does not follow a junction into credential storage', async () => {
    const other = join(root, 'other')
    fs.mkdirSync(other)
    fs.symlinkSync(other, dir, process.platform === 'win32' ? 'junction' : 'dir')
    expect((await service.connect({ key: KEY })).ok).toBe(false)
    expect(fs.readdirSync(other)).toEqual([])
    expect((await service.disconnect()).ok).toBe(false)
    fs.unlinkSync(dir)
  })

  it.each(['assigned', 'created', 'all', 'completed', 'open'])(
    'uses fixed query and variables for the %s filter plus team/state/priority',
    async (filter) => {
      await connect()
      fetcher.mockResolvedValueOnce(response({ issues: connection() }))
      const result = await service.issues({
        filter,
        teamId: 'team-1',
        stateId: 'state-1',
        priority: 0
      })
      expect(result).toMatchObject({
        ok: true,
        items: [{ id: 'issue-1', description: 'Details', team, state: { id: 'state-1' } }],
        hasNextPage: false
      })
      const body = JSON.parse(fetcher.mock.calls[0][1].body)
      expect(body.query).not.toContain('team-1')
      expect(body.variables.filter).toMatchObject({
        team: { id: { eq: 'team-1' } },
        state: { id: { eq: 'state-1' } },
        priority: { eq: 0 }
      })
      if (filter === 'assigned')
        expect(body.variables.filter.assignee).toEqual({ id: { eq: viewer.id } })
      if (filter === 'created')
        expect(body.variables.filter.creator).toEqual({ id: { eq: viewer.id } })
      if (filter === 'completed')
        expect(body.variables.filter.state.type).toEqual({ eq: 'completed' })
      if (filter === 'open')
        expect(body.variables.filter.state.type).toEqual({ nin: ['completed', 'canceled'] })
    }
  )

  it('bounds lists visibly and rejects malformed filters before network', async () => {
    await connect()
    for (const args of [
      { filter: 'evil' },
      { teamId: 'team") { viewer' },
      { stateId: '../x' },
      { priority: 5 }
    ])
      expect((await service.issues(args)).ok).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
    fetcher.mockResolvedValueOnce(response({ issues: connection([row()], true) }))
    expect(await service.issues()).toMatchObject({
      ok: true,
      hasNextPage: true,
      endCursor: 'next-cursor'
    })
    fetcher.mockResolvedValueOnce(
      response({ issues: connection(Array.from({ length: 101 }, () => row())) })
    )
    expect((await service.issues({ refresh: true })).ok).toBe(false)
  })

  it('caches issues for 60 seconds, keys filters, clones results and coalesces requests', async () => {
    await connect()
    const network = defer()
    fetcher.mockReturnValueOnce(network.promise)
    const a = service.issues()
    const b = service.issues()
    network.resolve(response({ issues: connection() }))
    const results = await Promise.all([a, b])
    expect(fetcher).toHaveBeenCalledTimes(1)
    results[0].items[0].title = 'changed'
    expect((await service.issues()).items[0].title).toBe('Fix it')
    expect(fetcher).toHaveBeenCalledTimes(1)
    tick += 60001
    fetcher.mockResolvedValue(response({ issues: connection() }))
    await service.issues()
    await service.issues({ filter: 'all' })
    await service.issues({ refresh: true })
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('caches teams/states for ten minutes with independent team ids and sorted positions', async () => {
    await connect()
    fetcher.mockResolvedValueOnce(response({ teams: connection([team]) }))
    expect(await service.teams()).toMatchObject({ ok: true, teams: [team] })
    tick += 60001
    await service.teams()
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockResolvedValueOnce(
      response({ team: { states: connection([{ ...state, id: 'second', position: 2 }, state]) } })
    )
    expect((await service.states({ teamId: 'team-1' })).states.map((s) => s.id)).toEqual([
      'state-1',
      'second'
    ])
    await service.states({ teamId: 'team-1' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    tick += 600001
    fetcher.mockResolvedValueOnce(response({ teams: connection([team]) }))
    await service.teams()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('sets state only through the explicit mutation and invalidates earlier issue results', async () => {
    await connect()
    const earlier = defer()
    fetcher.mockReturnValueOnce(earlier.promise)
    const stale = service.issues()
    fetcher.mockResolvedValueOnce(
      response({
        issueUpdate: {
          success: true,
          issue: { ...row(), state: { ...state, id: 'done', type: 'completed' } }
        }
      })
    )
    expect(await service.setState({ issueId: 'issue-1', stateId: 'done' })).toMatchObject({
      ok: true,
      issue: { state: { id: 'done' } }
    })
    const body = JSON.parse(fetcher.mock.calls[1][1].body)
    expect(body.variables).toEqual({ issueId: 'issue-1', input: { stateId: 'done' } })
    expect(body.query).not.toContain('issue-1')
    earlier.resolve(response({ issues: connection() }))
    expect((await stale).ok).toBe(false)
    fetcher.mockResolvedValueOnce(response({ issues: connection([row('updated')]) }))
    expect((await service.issues()).items[0].id).toBe('updated')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('does not persist a connect response arriving after disconnect', async () => {
    const network = defer()
    fetcher.mockReturnValueOnce(network.promise)
    const pending = service.connect({ key: KEY })
    expect(await service.disconnect()).toEqual({ ok: true, configured: false })
    network.resolve(response(connectData()))
    expect((await pending).ok).toBe(false)
    expect(fs.existsSync(file())).toBe(false)
    expect(await service.status()).toEqual({ ok: true, configured: false })
  })

  it('lets the latest connect win and prevents old-account reads during validation populating its cache', async () => {
    await connect()
    const validation = defer()
    fetcher.mockReturnValueOnce(validation.promise)
    const reconnect = service.connect({ key: OTHER })
    const oldRead = defer()
    fetcher.mockReturnValueOnce(oldRead.promise)
    const reading = service.issues()
    validation.resolve(response(connectData('user-2')))
    expect(await reconnect).toMatchObject({ ok: true, viewer: { id: 'user-2' } })
    oldRead.resolve(response({ issues: connection([row('old-account')]) }))
    expect((await reading).ok).toBe(false)
    fetcher.mockResolvedValueOnce(response({ issues: connection([row('new-account')]) }))
    expect((await service.issues()).items[0].id).toBe('new-account')
    expect(fetcher.mock.calls.at(-1)[1].headers.Authorization).toBe(OTHER)
  })

  it('ignores an older connection completing after a newer accepted one', async () => {
    const old = defer()
    fetcher.mockReturnValueOnce(old.promise)
    const first = service.connect({ key: KEY })
    fetcher.mockResolvedValueOnce(response(connectData('user-2')))
    expect((await service.connect({ key: OTHER })).ok).toBe(true)
    old.resolve(response(connectData()))
    expect((await first).ok).toBe(false)
    expect(await service.status()).toMatchObject({ viewer: { id: 'user-2' } })
  })

  it('bounds network timeout even if a fetch implementation ignores its abort signal', async () => {
    service = createLinearService({
      dir,
      safeStorage,
      fetch: () => new Promise(() => {}),
      timeoutMs: 15
    })
    expect(await service.connect({ key: KEY })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/time/)
    })
    expect(fs.existsSync(file())).toBe(false)
  })

  it('bounds response headers and streamed bytes, strips transport errors, and handles rate limits', async () => {
    fetcher.mockResolvedValueOnce(
      new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } })
    )
    expect((await service.connect({ key: KEY })).error).toMatch(/too much/)
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)))
    expect((await service.connect({ key: KEY })).error).toMatch(/too much/)
    fetcher.mockRejectedValueOnce(new Error(`https://secret.invalid/${KEY}`))
    const failed = await service.connect({ key: KEY })
    expect(failed.ok).toBe(false)
    expect(JSON.stringify(failed)).not.toContain(KEY)
    fetcher.mockResolvedValueOnce(new Response(KEY, { status: 429 }))
    expect((await service.connect({ key: KEY })).error).toMatch(/rate limit/)
    expect(fs.existsSync(file())).toBe(false)
  })

  it('rejects missing identity, unsafe links and failed mutations without leaking extra fields', async () => {
    fetcher.mockResolvedValueOnce(response({ viewer: { name: 'missing id' }, organization }))
    expect((await service.connect({ key: KEY })).ok).toBe(false)
    await connect()
    fetcher.mockResolvedValueOnce(
      response({ issues: connection([{ ...row(), url: 'https://evil.invalid/x' }]) })
    )
    expect((await service.issues()).ok).toBe(false)
    fetcher.mockResolvedValueOnce(
      response({ issueUpdate: { success: false, issue: row(), token: KEY } })
    )
    expect((await service.setState({ issueId: 'issue-1', stateId: 'state-1' })).ok).toBe(false)
    fetcher.mockResolvedValueOnce(
      response({ issues: connection([{ ...row(), token: KEY, headers: { authorization: KEY } }]) })
    )
    expect(JSON.stringify(await service.issues())).not.toContain(KEY)
  })

  it('preserves credentials when explicit disconnect fails, then removes only its file on retry', async () => {
    await connect()
    fs.writeFileSync(join(dir, 'unrelated.txt'), 'keep')
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw new Error(KEY)
    })
    expect(await service.disconnect()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/kept/)
    })
    unlink.mockRestore()
    expect(await service.status()).toMatchObject({ configured: true })
    expect(await service.disconnect()).toEqual({ ok: true, configured: false })
    expect(fs.readdirSync(dir)).toEqual(['unrelated.txt'])
    expect((await service.issues()).ok).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
