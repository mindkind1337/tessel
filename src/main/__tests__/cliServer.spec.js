import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLI_PROTOCOL,
  METHODS,
  RUNTIME_FILE,
  TOKEN_FILE,
  CliError,
  createCliServer,
  handleRequestLine,
  parseRequestLine,
  readOrCreateToken,
  tokensMatch,
  validAbsolutePath,
  validateParams,
  newPipeName
} from '../cliServer'

const TOKEN = 'a'.repeat(64)
const line = (body) => `${CLI_PROTOCOL} ${Buffer.from(JSON.stringify(body), 'utf8').toString('base64')}\n`
const reply = async (text, handlers = {}) => JSON.parse(await handleRequestLine(text, { token: TOKEN, handlers }))

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-cli-srv-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('token', () => {
  it('is made once per install and kept', () => {
    const restrict = vi.fn()
    const a = readOrCreateToken(dir, { restrict })
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(restrict).toHaveBeenCalledWith(path.join(dir, TOKEN_FILE))
    expect(readOrCreateToken(dir, { restrict })).toBe(a)
    expect(restrict).toHaveBeenCalledTimes(1)
  })

  it('replaces a damaged token file', () => {
    fs.writeFileSync(path.join(dir, TOKEN_FILE), 'nope')
    expect(readOrCreateToken(dir)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('compares tokens of the right shape only', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true)
    expect(tokensMatch(TOKEN, 'b'.repeat(64))).toBe(false)
    expect(tokensMatch('', '')).toBe(false)
    expect(tokensMatch(undefined, TOKEN)).toBe(false)
    expect(tokensMatch('A'.repeat(64), 'A'.repeat(64))).toBe(false)
  })

  it('pipe names are random and match the helper', () => {
    const a = newPipeName()
    expect(a).toMatch(/^tessel-cli-[0-9a-f]{32}$/)
    expect(newPipeName()).not.toBe(a)
  })
})

describe('request lines', () => {
  it('parses a well-formed request', () => {
    expect(parseRequestLine(line({ token: TOKEN, method: 'ping' }))).toEqual({ token: TOKEN, method: 'ping', params: {} })
  })

  it('refuses other protocols, bad base64 and non-objects', () => {
    for (const bad of ['hello\n', `${CLI_PROTOCOL} ***\n`, `${CLI_PROTOCOL} ${Buffer.from('[1]').toString('base64')}\n`, `TESSEL-CLI 2 ${Buffer.from('{}').toString('base64')}`]) {
      expect(() => parseRequestLine(bad)).toThrow(CliError)
    }
    expect(() => parseRequestLine(line({ token: TOKEN, method: 'ping', params: [1] }))).toThrow(/parameters/)
  })

  it('refuses a request that is too large', () => {
    expect(() => parseRequestLine(`${CLI_PROTOCOL} ${'A'.repeat(70 * 1024)}`)).toThrow(/too large/)
  })
})

describe('validateParams', () => {
  it('knows exactly the offered methods', () => {
    expect(METHODS).toEqual(['ping', 'focus', 'open', 'new', 'status', 'task.add', 'usage'])
    expect(() => validateParams('write', {})).toThrow(/Unknown request/)
    expect(() => validateParams('worker.start', {})).toThrow(/Unknown request/)
  })

  it('open: a full local path, optional line and column', () => {
    expect(validateParams('open', { path: 'C:/work/app', line: 3, extra: 1 })).toEqual({ path: 'C:\\work\\app', line: 3, col: null })
    expect(() => validateParams('open', { path: 'relative\\x' })).toThrow(/full local path/)
    expect(() => validateParams('open', { path: '\\\\.\\pipe\\x' })).toThrow(/full local path/)
    expect(() => validateParams('open', { path: '\\\\?\\C:\\x' })).toThrow(/full local path/)
    expect(() => validateParams('open', { path: 'C:\\x', line: 0 })).toThrow(/positive/)
    expect(() => validateParams('open', { path: 'C:\\x', line: '4' })).toThrow(/positive/)
    expect(validAbsolutePath('\\\\server\\share\\dir')).toBe('\\\\server\\share\\dir')
  })

  it('new: ids and values are checked', () => {
    expect(validateParams('new', { cwd: 'C:\\p', agent: 'claude', model: 'opus[1m]', effort: 'high' })).toEqual({
      cwd: 'C:\\p',
      agent: 'claude',
      model: 'opus[1m]',
      effort: 'high',
      shell: null
    })
    expect(validateParams('new', {})).toEqual({ cwd: null, agent: null, model: null, effort: null, shell: null })
    expect(() => validateParams('new', { agent: 'claude; rm' })).toThrow(/valid agent/)
    expect(() => validateParams('new', { agent: 'claude', model: 'a b' })).toThrow(/valid model/)
    expect(() => validateParams('new', { agent: 'claude', model: '--dangerously skip' })).toThrow()
    expect(() => validateParams('new', { model: 'opus' })).toThrow(/--agent/)
    expect(() => validateParams('new', { agent: 'claude', effort: 'high' })).toThrow(/--model/)
    expect(() => validateParams('new', { agent: 'claude', shell: 'pwsh' })).toThrow(/not both/)
  })

  it('task.add: a one-line title, a bounded note', () => {
    const v = validateParams('task.add', { title: '  Fix\n\tthe\u0007 bug ', note: 'line 1\r\nline 2\u0000', cwd: 'D:\\x' })
    expect(v).toEqual({ title: 'Fix the bug', note: 'line 1\nline 2', cwd: 'D:\\x' })
    expect(validateParams('task.add', { title: 'x'.repeat(500) }).title).toHaveLength(200)
    expect(validateParams('task.add', { title: 'a', note: 'n'.repeat(9000) }).note).toHaveLength(4000)
    expect(() => validateParams('task.add', { title: ' \n ' })).toThrow(/title/)
    expect(() => validateParams('task.add', { title: 'a', note: 5 })).toThrow()
  })
})

describe('handleRequestLine', () => {
  it('runs the handler with the checked parameters', async () => {
    const open = vi.fn(async (p) => ({ kind: 'folder', project: 'x', got: p }))
    const r = await reply(line({ token: TOKEN, method: 'open', params: { path: 'C:\\x', junk: true } }), { open })
    expect(r).toEqual({ ok: true, result: { kind: 'folder', project: 'x', got: { path: 'C:\\x', line: null, col: null } } })
  })

  it('refuses a wrong or missing token before anything runs', async () => {
    const focus = vi.fn()
    for (const token of ['b'.repeat(64), undefined, '']) {
      const r = await reply(line({ token, method: 'focus' }), { focus })
      expect(r.ok).toBe(false)
      expect(r.error.code).toBe('unauthorized')
    }
    expect(focus).not.toHaveBeenCalled()
  })

  it('refuses unknown methods even with a handler', async () => {
    const r = await reply(line({ token: TOKEN, method: 'write' }), { write: vi.fn() })
    expect(r.error.code).toBe('unknown_method')
  })

  it('reports a handler error', async () => {
    const r = await reply(line({ token: TOKEN, method: 'status' }), {
      status: async () => {
        throw new CliError('no_window', 'gone')
      }
    })
    expect(r).toEqual({ ok: false, error: { code: 'no_window', message: 'gone' } })
    const r2 = await reply(line({ token: TOKEN, method: 'status' }), {
      status: async () => {
        throw new Error('boom')
      }
    })
    expect(r2.error).toEqual({ code: 'failed', message: 'boom' })
  })

  it('bounds the answer', async () => {
    const r = await reply(line({ token: TOKEN, method: 'usage' }), { usage: async () => ({ big: 'x'.repeat(2 * 1024 * 1024) }) })
    expect(r.error.code).toBe('too_large')
  })
})

// A pipe host double: createServer(onConnection) -> listen / close / 'error'.
function fakeNet() {
  const api = { servers: [] }
  api.createServer = (onConnection) => {
    const srv = new EventEmitter()
    srv.onConnection = onConnection
    srv.listen = vi.fn((opts, cb) => {
      srv.path = opts.path
      setImmediate(cb)
      return srv
    })
    srv.close = vi.fn()
    api.servers.push(srv)
    return srv
  }
  return api
}
function fakeSocket() {
  const sock = new EventEmitter()
  sock.end = vi.fn((text) => {
    sock.answer = text
    sock.emit('close')
  })
  return sock
}

describe('createCliServer', () => {
  it('writes the runtime file once listening, answers, and removes it on stop', async () => {
    const net = fakeNet()
    const restrict = vi.fn()
    const server = createCliServer({
      userData: dir,
      netApi: net,
      handlers: { ping: async () => ({ pong: true }) },
      restrict,
      pid: 4242,
      info: () => ({ appVersion: '9.9.9', locale: 'fr' }),
      pipeName: () => 'tessel-cli-' + '0'.repeat(32)
    })
    expect(await server.start()).toBe(true)
    const runtime = JSON.parse(fs.readFileSync(path.join(dir, RUNTIME_FILE), 'utf8'))
    expect(runtime).toMatchObject({ version: 1, pipe: '\\\\.\\pipe\\tessel-cli-' + '0'.repeat(32), pid: 4242, appVersion: '9.9.9', locale: 'fr' })
    expect(runtime).not.toHaveProperty('token')
    expect(restrict).toHaveBeenCalledWith(path.join(dir, RUNTIME_FILE))
    const token = fs.readFileSync(path.join(dir, TOKEN_FILE), 'utf8')

    const sock = fakeSocket()
    net.servers[0].onConnection(sock)
    const text = line({ token, method: 'ping' })
    sock.emit('data', Buffer.from(text.slice(0, 10)))
    sock.emit('data', Buffer.from(text.slice(10)))
    await vi.waitFor(() => expect(sock.end).toHaveBeenCalled())
    expect(JSON.parse(sock.answer)).toEqual({ ok: true, result: { pong: true } })

    server.stop()
    expect(fs.existsSync(path.join(dir, RUNTIME_FILE))).toBe(false)
    expect(net.servers[0].close).toHaveBeenCalled()
  })

  it('does not remove another Tessel’s runtime file', async () => {
    const server = createCliServer({ userData: dir, netApi: fakeNet(), handlers: {}, pid: 1 })
    await server.start()
    fs.writeFileSync(path.join(dir, RUNTIME_FILE), JSON.stringify({ pid: 2 }))
    server.stop()
    expect(fs.existsSync(path.join(dir, RUNTIME_FILE))).toBe(true)
  })

  it('cuts a connection that sends too much without a line', async () => {
    const net = fakeNet()
    const server = createCliServer({ userData: dir, netApi: net, handlers: {} })
    await server.start()
    const sock = fakeSocket()
    net.servers[0].onConnection(sock)
    sock.emit('data', Buffer.alloc(70 * 1024, 65))
    expect(JSON.parse(sock.answer).error.code).toBe('too_large')
    server.stop()
  })

  it('tells when the pipe went down after it was up', async () => {
    const net = fakeNet()
    const onDown = vi.fn()
    const server = createCliServer({ userData: dir, netApi: net, handlers: {}, onDown })
    await server.start()
    net.servers[0].emit('error', Object.assign(new Error('x'), { code: 'EEXITED' }))
    expect(onDown).toHaveBeenCalledTimes(1)
    expect(server.running()).toBe(false)
    expect(fs.existsSync(path.join(dir, RUNTIME_FILE))).toBe(false)
  })

  it('a pipe that never starts resolves false, without onDown', async () => {
    const onDown = vi.fn()
    const netApi = {
      createServer: () => {
        const srv = new EventEmitter()
        srv.listen = () => setImmediate(() => srv.emit('error', Object.assign(new Error('x'), { code: 'ENOHELPER' })))
        srv.close = () => {}
        return srv
      }
    }
    const server = createCliServer({ userData: dir, netApi, handlers: {}, onDown })
    expect(await server.start()).toBe(false)
    expect(onDown).not.toHaveBeenCalled()
  })
})
