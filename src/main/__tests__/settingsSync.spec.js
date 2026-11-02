// @vitest-environment node
// Your settings everywhere: the real account module and the real sync module, against a server
// that keeps to the contract of tessel-server's /api/sync. What matters most here: nothing
// readable leaves the computer, and nothing local is lost whatever the server or the phrase does.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTesselAccount } from '../tesselAccount'
import { MAX_BLOB, MIN_PHRASE, cleanPhrase, createSettingsSync, deriveKey, deviceLabel, openCopy, sealCopy } from '../settingsSync'
import { PENDING_DIR, hasPendingImport, applyPendingImport, inspectBackup, localizeLayout, SENSITIVE_SETTINGS } from '../settingsBackup'
import { safeSessionId } from '../../renderer/src/agentResumeLine'

const API = 'https://api.test'
const PHRASE = 'correct horse battery staple'
const MARKER = 'MARKER-Z7Q-a-value-planted-in-the-settings'
const BOARD_MARKER = 'MARKER-BOARD-a-task-title'
const HOST_MARKER = 'MARKER-HOST-a-host-label'
const USER = { id: 'user-1', email: 'me@gmail.com', name: 'Me' }
const OTHER_USER = { id: 'user-2', email: 'other@gmail.com', name: 'Other' }

const sealing = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'dpapi',
  encryptString: (text) => Buffer.from(`sealed:${Buffer.from(text).toString('hex')}`),
  decryptString: (buf) => Buffer.from(buf.toString().replace(/^sealed:/, ''), 'hex').toString()
}
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

const dirs = []
const running = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tessel-sync-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  running.splice(0).forEach((c) => {
    c.sync.close()
    c.account.close()
  })
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  vi.useRealTimers()
})

// One account's copy, as tessel-server keeps it.
function fakeServer() {
  const server = {
    row: null,
    clock: 1_800_000_000_000,
    offline: false,
    requests: [],
    sessions: new Map(),
    answer: null,
    fetch: async (url, options = {}) => {
      const { pathname, searchParams } = new URL(url)
      const method = options.method || 'GET'
      server.requests.push({ url, method, headers: { ...options.headers }, body: options.body || '' })
      if (server.offline) throw new TypeError('fetch failed')
      if (pathname === '/auth/token') {
        const token = `session-token-${server.sessions.size}-abcdefghijklmnop`
        server.sessions.set(token, server.nextUser || USER)
        return response(200, { token, expires_at: Date.now() + 1e9, user: server.nextUser || USER })
      }
      if (pathname === '/auth/logout') return response(204, {})
      if (pathname === '/api/me' && method === 'DELETE') {
        server.row = null
        return response(204, {})
      }
      if (pathname !== '/api/sync') return response(404, {})
      if (server.answer) {
        const forced = server.answer(method)
        if (forced) return forced
      }
      const token = String(options.headers?.authorization || '').replace('Bearer ', '')
      if (!server.sessions.has(token)) return response(401, { error: 'unauthorized' })
      if (method === 'GET') {
        if (!server.row) return response(404, { error: 'no_copy' })
        const { blob, ...meta } = server.row
        return response(200, searchParams.get('meta') === '1' ? meta : { ...meta, blob })
      }
      if (method === 'DELETE') {
        server.row = null
        return response(204, {})
      }
      if (method === 'PUT') {
        const { expected_version: expected, salt, device, blob } = JSON.parse(options.body)
        if (blob.length > MAX_BLOB) return response(413, { error: 'too_large' })
        const current = server.row ? server.row.version : 0
        if (expected !== current) return response(409, { error: 'version_conflict', ...(server.row ? { version: server.row.version, salt: server.row.salt, device: server.row.device, updated_at: server.row.updated_at } : { version: 0 }) })
        server.clock += 1000
        server.row = { version: expected + 1, salt, device, updated_at: server.clock, blob }
        return response(200, { version: expected + 1, updated_at: server.clock })
      }
      return response(405, {})
    }
  }
  server.puts = () => server.requests.filter((r) => r.method === 'PUT')
  return server
}

const layout = (over = {}) => ({
  version: 2,
  selectedShell: 'powershell',
  settings: { theme: MARKER, fontSize: 14, agentPermissions: 'yolo', yoloFolders: ['C:/secret'], agentPrefs: { claude: { args: '--x', env: { ANTHROPIC_API_KEY: 'sk-ant-SECRET' } } }, workspaceDir: 'C:/work-here' },
  workspaces: [],
  ...over
})

function writeSetup(dataDir, { settings = layout(), board = { version: 1, tasks: [{ id: 't1', title: BOARD_MARKER }] }, hosts = { version: 1, targets: [{ id: 'ssh-1', label: HOST_MARKER, host: 'example.org', proxyCommand: 'evil-proxy' }] } } = {}) {
  writeFileSync(join(dataDir, 'workspace-layout.json'), JSON.stringify(settings))
  writeFileSync(join(dataDir, 'task-board.json'), JSON.stringify(board))
  writeFileSync(join(dataDir, 'remote-hosts.json'), JSON.stringify(hosts))
  // What must never travel.
  writeFileSync(join(dataDir, 'chat-trust.json'), '{"SECURITY-MARKER":true}')
  writeFileSync(join(dataDir, 'activity.json'), '[{"text":"ACTIVITY-MARKER"}]')
  writeFileSync(join(dataDir, 'ssh-host-keys.json'), '{"SECURITY-HOSTKEY":1}')
}

async function computer(server, { name = 'DESKTOP-1', safeStorage = sealing, user, setup, sync: options = {}, dataDir: existingData, signIn = true } = {}) {
  const dataDir = existingData || tempDir()
  if (!existingData) writeSetup(dataDir, setup)
  const dir = join(dataDir, 'tessel-account')
  mkdirSync(dir, { recursive: true })
  const opened = []
  const account = createTesselAccount({ dir, safeStorage, openExternal: async (url) => opened.push(url), scheme: 'tessel', fetchFn: server.fetch, apiUrl: API, accountUrl: 'https://account.test', onDeleted: () => me.sync.accountDeleted() })
  const clock = { now: 1_800_000_000_000 }
  const changed = []
  const newer = []
  const sync = createSettingsSync({
    dir,
    dataDir,
    safeStorage,
    account,
    deviceName: name,
    appVersion: '9.9.9',
    getBuild: async () => 'b1 (abc)',
    onChanged: (view) => changed.push(view),
    onNewer: (info) => newer.push(info),
    now: () => clock.now,
    scryptCost: 1024,
    ...options
  })
  const me = { dir, dataDir, account, sync, clock, changed, newer, opened, name }
  me.signIn = async (who = user || USER) => {
    server.nextUser = who
    await account.signIn()
    const state = new URL(opened.at(-1)).searchParams.get('state')
    await account.handleLink(`tessel://callback?code=one-time-code&state=${state}`)
  }
  if (signIn) await me.signIn()
  running.push(me)
  return me
}

const on = async (c, phrase = PHRASE) => c.sync.turnOn(phrase)
const firstAndSecond = async (server, over = {}) => {
  const a = await computer(server, { name: 'DESKTOP-1' })
  expect((await on(a)).state).toBe('on')
  const b = await computer(server, { name: 'LAPTOP-2', setup: { settings: layout({ settings: { theme: 'b-theme', agentPermissions: 'manual', workspaceDir: 'D:/laptop' } }), board: { version: 1, tasks: [] }, hosts: { version: 1, targets: [] } }, ...over })
  return { a, b }
}
const edit = (c, change) => {
  const file = join(c.dataDir, 'workspace-layout.json')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  change(data)
  writeFileSync(file, JSON.stringify(data))
  // A file's time has a resolution: the signature must see this as a change.
  utimesSync(file, new Date(), new Date(Date.now() + Math.random() * 100000))
}
// What the server gets is exactly bytes it cannot read: all of it, for every request.
const everythingSent = (server) => server.requests.map((r) => `${r.url}\n${JSON.stringify(r.headers)}\n${r.body}`).join('\n')
const encodings = (text) => [text, Buffer.from(text).toString('base64'), Buffer.from(text).toString('base64url'), Buffer.from(text).toString('hex')]
const keyOf = (c) => Buffer.from(sealing.decryptString(Buffer.from(JSON.parse(readFileSync(join(c.dir, 'sync.json'), 'utf8')).sealedKey, 'base64')), 'base64')

describe('the phrase and the key', () => {
  it('a phrase is at least 12 characters; accents typed either way give the same one', () => {
    expect(MIN_PHRASE).toBe(12)
    expect(cleanPhrase('short')).toBeNull()
    expect(cleanPhrase('a'.repeat(11))).toBeNull()
    expect(cleanPhrase(`   ${'a'.repeat(11)}   `)).toBeNull()
    expect(cleanPhrase('a'.repeat(12))).toBe('a'.repeat(12))
    expect(cleanPhrase(12345678901234)).toBeNull()
    expect(cleanPhrase('caf\u00e9 du matin 12')).toBe(cleanPhrase('cafe\u0301 du matin 12'))
  })

  it('the real cost of the key: 2^17, with a limit on memory that lets it run', async () => {
    const key = await deriveKey(PHRASE, Buffer.alloc(16, 1).toString('base64url'))
    expect(key).toHaveLength(32)
  })

  it('a computer name is cleaned and kept short', () => {
    expect(deviceLabel('a\u0007b')).toBe('a b')
    expect(deviceLabel('x'.repeat(200))).toHaveLength(80)
    expect(deviceLabel('')).toBe('Computer')
  })
})

describe('the encryption', () => {
  const key = Buffer.alloc(32, 7)
  const bundle = { app: 'tessel', format: 1, files: { 'a.json': `{"v":"${MARKER}"}` } }
  const sealed = () => sealCopy({ bundle, key, userId: 'u', version: 3 })

  it('opens with the same key, account and version', async () => {
    expect(JSON.parse(await openCopy({ blob: await sealed(), key, userId: 'u', version: 3 }))).toEqual(bundle)
  })

  it('a fresh nonce each time: the same setup never looks the same', async () => {
    const [one, two] = [await sealed(), await sealed()]
    expect(one).not.toBe(two)
    expect(one.slice(0, 18)).not.toBe(two.slice(0, 18))
  })

  it.each([
    ['another key', { key: Buffer.alloc(32, 8) }],
    ['another account', { userId: 'someone-else' }],
    ['another version: an old copy under a newer number', { version: 4 }]
  ])('refuses %s', async (_what, over) => {
    await expect(openCopy({ blob: await sealed(), key, userId: 'u', version: 3, ...over })).rejects.toMatchObject({ code: 'unreadable' })
  })

  it('a change to any part is refused: nonce, tag or body', async () => {
    const bytes = Buffer.from(await sealed(), 'base64url')
    for (const at of [1, 13, 29, bytes.length - 1]) {
      const changed = Buffer.from(bytes)
      changed[at] ^= 1
      await expect(openCopy({ blob: changed.toString('base64url'), key, userId: 'u', version: 3 })).rejects.toMatchObject({ code: 'unreadable' })
    }
    await expect(openCopy({ blob: 'short', key, userId: 'u', version: 3 })).rejects.toMatchObject({ code: 'unreadable' })
  })

  it('a format from a newer Tessel says so', async () => {
    const bytes = Buffer.from(await sealed(), 'base64url')
    bytes[0] = 2
    await expect(openCopy({ blob: bytes.toString('base64url'), key, userId: 'u', version: 3 })).rejects.toMatchObject({ code: 'newer' })
  })

  it('compresses first: a large setup goes down to a fraction', async () => {
    const big = { app: 'tessel', format: 1, files: { 'b.json': JSON.stringify({ tasks: Array.from({ length: 5000 }, (_, i) => ({ id: i, title: 'the same kind of task as the others' })) }) } }
    const blob = await sealCopy({ bundle: big, key, userId: 'u', version: 1 })
    expect(blob.length).toBeLessThan(JSON.stringify(big).length / 4)
  })
})

describe('nothing readable reaches the server', () => {
  it('the bytes sent never hold a marker of the settings, the board or the hosts, the phrase or the key', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    edit(a, (d) => {
      d.settings.fontSize = 15
    })
    await a.sync.syncNow()
    expect(server.puts()).toHaveLength(2)
    const sent = everythingSent(server)
    for (const secret of [MARKER, BOARD_MARKER, HOST_MARKER, PHRASE, 'sk-ant-SECRET', 'SECURITY-MARKER', 'ACTIVITY-MARKER', keyOf(a).toString('base64'), keyOf(a).toString('base64url'), keyOf(a).toString('hex')]) {
      for (const form of encodings(secret).slice(0, secret.startsWith('MARKER') || secret === PHRASE ? 4 : 1)) expect(sent).not.toContain(form)
    }
    // What goes up is the blob, in the shape the server checks, and nothing else.
    const body = JSON.parse(server.puts()[0].body)
    expect(Object.keys(body).sort()).toEqual(['blob', 'device', 'expected_version', 'salt'])
    expect(body.device).toBe('DESKTOP-1')
    expect(body.blob).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(server.requests.every((r) => r.url.startsWith(API))).toBe(true)
  })

  it('what is inside holds settings, hosts and board, without security, secrets or activity', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    const text = await openCopy({ blob: server.row.blob, key: keyOf(a), userId: USER.id, version: 1 })
    const { files, summary } = inspectBackup(text)
    expect(Object.keys(files).sort()).toEqual(['remote-hosts.json', 'task-board.json', 'workspace-layout.json'])
    expect(summary.categories.map((c) => c.id).sort()).toEqual(['board', 'hosts', 'settings'])
    const settings = JSON.parse(files['workspace-layout.json']).settings
    expect(settings.theme).toBe(MARKER)
    for (const key of SENSITIVE_SETTINGS) expect(settings[key]).toBeUndefined()
    expect(settings.workspaceDir).toBeUndefined()
    for (const secret of ['sk-ant-SECRET', 'evil-proxy', 'SECURITY-MARKER', 'SECURITY-HOSTKEY', 'ACTIVITY-MARKER', 'C:/secret']) expect(text).not.toContain(secret)
    expect(text).toContain(BOARD_MARKER)
    expect(text).toContain(HOST_MARKER)
  })

  it('the window never gets a key, a salt or a token, and the key on disk is sealed', async () => {
    const server = fakeServer()
    const a = await computer(server)
    const view = await on(a)
    const key = keyOf(a)
    const seen = JSON.stringify([view, a.changed, await a.sync.status({ check: true }), await a.sync.peek()])
    expect(seen).not.toContain(server.row.salt)
    expect(seen).not.toContain(key.toString('base64'))
    expect(seen).not.toContain('session-token')
    const onDisk = readFileSync(join(a.dir, 'sync.json'), 'utf8')
    expect(onDisk).not.toContain(key.toString('base64'))
    expect(onDisk).not.toContain(PHRASE)
    expect(JSON.parse(onDisk).v).toBe(1)
    expect(readdirSync(a.dir).sort()).toEqual(['session.json', 'sync.json'])
  })

  it('no secure storage: it does not turn on, and nothing is sent', async () => {
    const server = fakeServer()
    const a = await computer(server, { safeStorage: { ...sealing, isEncryptionAvailable: () => false }, signIn: false })
    const res = await on(a)
    expect(res.error).toBe('noSecureStorage')
    expect(res.on).toBe(false)
    expect(server.puts()).toHaveLength(0)
  })
})

describe('the first computer', () => {
  it('turning on sends its setup at once, and says when, from which computer', async () => {
    const server = fakeServer()
    const a = await computer(server)
    const view = await on(a)
    expect(view).toMatchObject({ on: true, state: 'on', device: 'DESKTOP-1', problem: null, remote: null })
    expect(view.lastSyncAt).toBe(server.row.updated_at)
    expect(server.row).toMatchObject({ version: 1, device: 'DESKTOP-1' })
  })

  it('a short phrase is refused here, before anything else', async () => {
    const server = fakeServer()
    const a = await computer(server)
    server.requests.length = 0
    const view = await on(a, 'too short')
    expect(view.error).toBe('shortPhrase')
    expect(view.on).toBe(false)
    expect(server.requests).toHaveLength(0)
    expect(existsSync(join(a.dir, 'sync.json'))).toBe(false)
  })

  it('peek says whether a copy is there, and whose', async () => {
    const server = fakeServer()
    const a = await computer(server)
    expect((await a.sync.peek()).copy).toBeNull()
    await on(a)
    expect((await a.sync.peek()).copy).toEqual({ device: 'DESKTOP-1', at: server.row.updated_at })
  })

  it('two computers turning on at once: the second takes the first one\'s salt, and asks', async () => {
    const server = fakeServer()
    const { b } = await firstAndSecond(server)
    const saved = server.row
    server.row = null
    let once = true
    server.answer = (method) => {
      if (method === 'PUT' && once) {
        once = false
        server.row = saved
      }
      return null
    }
    const view = await on(b)
    expect(view).toMatchObject({ state: 'newer', remote: { device: 'DESKTOP-1', first: true } })
    expect(server.row.salt).toBe(saved.salt)
  })
})

describe('a second computer', () => {
  it('the wrong phrase is refused with a clear code, and changes nothing', async () => {
    const server = fakeServer()
    const { b } = await firstAndSecond(server)
    const before = readFileSync(join(b.dataDir, 'workspace-layout.json'), 'utf8')
    const row = { ...server.row }
    const view = await on(b, 'not the right phrase at all')
    expect(view).toMatchObject({ error: 'wrongPhrase', on: false, state: 'off' })
    expect(existsSync(join(b.dir, 'sync.json'))).toBe(false)
    expect(readFileSync(join(b.dataDir, 'workspace-layout.json'), 'utf8')).toBe(before)
    expect(hasPendingImport(b.dataDir)).toBe(false)
    expect(server.row).toEqual(row)
    expect(server.puts().filter((p) => JSON.parse(p.body).device === 'LAPTOP-2')).toHaveLength(0)
  })

  it('the right phrase shows the copy with its computer and time, applies nothing and sends nothing', async () => {
    const server = fakeServer()
    const { b } = await firstAndSecond(server)
    const before = readFileSync(join(b.dataDir, 'workspace-layout.json'), 'utf8')
    const puts = server.puts().length
    const view = await on(b)
    expect(view).toMatchObject({ on: true, state: 'newer', remote: { device: 'DESKTOP-1', at: server.row.updated_at, first: true } })
    expect(readFileSync(join(b.dataDir, 'workspace-layout.json'), 'utf8')).toBe(before)
    expect(hasPendingImport(b.dataDir)).toBe(false)
    expect(server.puts()).toHaveLength(puts)
  })

  it('applying stages it for the next start: only the three files, its own security stays', async () => {
    const server = fakeServer()
    const { b } = await firstAndSecond(server)
    await on(b)
    const before = readFileSync(join(b.dataDir, 'workspace-layout.json'), 'utf8')
    const view = await b.sync.apply()
    expect(view).toMatchObject({ state: 'staged', staged: { device: 'DESKTOP-1' } })
    // Nothing in use is written.
    expect(readFileSync(join(b.dataDir, 'workspace-layout.json'), 'utf8')).toBe(before)
    const staged = readdirSync(join(b.dataDir, PENDING_DIR)).sort()
    expect(staged).toEqual(['manifest.json', 'remote-hosts.json', 'task-board.json', 'workspace-layout.json'])
    const after = JSON.parse(readFileSync(join(b.dataDir, PENDING_DIR, 'workspace-layout.json'), 'utf8'))
    expect(after.settings.theme).toBe(MARKER)
    expect(after.settings.agentPermissions).toBe('manual')
    expect(after.settings.yoloFolders).toBeUndefined()
    expect(after.settings.workspaceDir).toBe('D:/laptop')
    // At the next start it is put in place, what it replaces kept.
    const result = applyPendingImport({ dir: b.dataDir })
    expect(result.applied.sort()).toEqual(['remote-hosts.json', 'task-board.json', 'workspace-layout.json'])
    expect(JSON.parse(readFileSync(join(b.dataDir, 'workspace-layout.json'), 'utf8')).settings.theme).toBe(MARKER)
  })

  it('nothing goes up while something is staged, and it can be taken back', async () => {
    const server = fakeServer()
    const { b } = await firstAndSecond(server)
    await on(b)
    await b.sync.apply()
    const puts = server.puts().length
    edit(b, (d) => {
      d.settings.fontSize = 20
    })
    b.clock.now += 3600 * 1000
    b.sync.tick()
    b.clock.now += 3600 * 1000
    b.sync.tick()
    await b.sync.status()
    await new Promise((r) => setTimeout(r, 20))
    expect(server.puts()).toHaveLength(puts)
    const view = await b.sync.cancelApply()
    expect(view.state).toBe('newer')
    expect(hasPendingImport(b.dataDir)).toBe(false)
  })

  it('once it started on the copy, that is what this computer has: what the window writes at first is not sent', async () => {
    const server = fakeServer()
    const { b } = await firstAndSecond(server)
    await on(b)
    await b.sync.apply()
    const version = server.row.version
    applyPendingImport({ dir: b.dataDir })
    const puts = server.puts().length
    // The next start: a new process, the same files.
    b.sync.close()
    const next = await computer(server, { name: 'LAPTOP-2', dataDir: b.dataDir, sync: { settleMs: 1000, minIntervalMs: 0, debounceMs: 0 } })
    next.sync.start({ applied: true })
    expect((await next.sync.status()).state).toBe('on')
    edit(next, (d) => {
      d.selectedShell = 'written-back-by-the-window'
    })
    next.sync.tick()
    next.clock.now += 2000
    next.sync.tick()
    await next.sync.status({ check: true })
    await new Promise((r) => setTimeout(r, 30))
    next.clock.now += 2000
    next.sync.tick()
    await next.sync.status({ check: true })
    await new Promise((r) => setTimeout(r, 30))
    expect(server.puts()).toHaveLength(puts)
    expect(server.row.version).toBe(version)
    // A real change, afterwards, is.
    edit(next, (d) => {
      d.settings.fontSize = 22
    })
    next.clock.now += 2000
    next.sync.tick()
    await next.sync.status({ check: true })
    await new Promise((r) => setTimeout(r, 30))
    expect(server.row.version).toBe(version + 1)
    expect(server.row.device).toBe('LAPTOP-2')
  })

  it('a staged copy that never got applied comes back as a question', async () => {
    const server = fakeServer()
    const { b } = await firstAndSecond(server)
    await on(b)
    await b.sync.apply()
    rmSync(join(b.dataDir, PENDING_DIR), { recursive: true, force: true })
    b.sync.close()
    const next = await computer(server, { name: 'LAPTOP-2', dataDir: b.dataDir })
    next.sync.start({ applied: false })
    const view = await next.sync.status({ check: true })
    expect(view.state).toBe('newer')
    next.sync.close()
  })

  it('the same setup on both: nobody is asked', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    const same = readFileSync(join(a.dataDir, 'workspace-layout.json'), 'utf8')
    const b = await computer(server, { name: 'LAPTOP-2', setup: { settings: JSON.parse(same) } })
    const view = await on(b)
    expect(view).toMatchObject({ state: 'on', remote: null })
    expect(view.lastSyncAt).toBe(server.row.updated_at)
  })

  it('the copy changed again since the person looked: they are told, and choose again', async () => {
    const server = fakeServer()
    const { a, b } = await firstAndSecond(server)
    await on(b)
    edit(a, (d) => {
      d.settings.fontSize = 33
    })
    await a.sync.syncNow()
    const view = await b.sync.apply()
    expect(view.error).toBe('changedAgain')
    expect(view.state).toBe('newer')
    expect(hasPendingImport(b.dataDir)).toBe(false)
  })
})

describe('someone else wrote first', () => {
  it('a 409 overwrites nothing: the person is told once, and asked', async () => {
    const server = fakeServer()
    const { a, b } = await firstAndSecond(server)
    await on(b)
    await b.sync.keepMine()
    const row = { ...server.row }
    edit(a, (d) => {
      d.settings.fontSize = 44
    })
    a.newer.length = 0
    const view = await a.sync.syncNow()
    expect(view).toMatchObject({ state: 'newer', remote: { device: 'LAPTOP-2' } })
    expect(server.row).toEqual(row)
    expect(a.newer).toEqual([{ device: 'LAPTOP-2', at: row.updated_at }])
    await a.sync.status({ check: true })
    await a.sync.syncNow()
    expect(a.newer).toHaveLength(1)
  })

  it('a 409 on the upload itself, between the look and the write', async () => {
    const server = fakeServer()
    const { a } = await firstAndSecond(server)
    edit(a, (d) => {
      d.settings.fontSize = 45
    })
    server.answer = (method) => (method === 'PUT' ? response(409, { error: 'version_conflict', version: 7, salt: server.row.salt, device: 'THIRD', updated_at: 5 }) : null)
    const blobBefore = server.row.blob
    await a.sync.syncNow()
    server.answer = null
    expect(server.row.blob).toBe(blobBefore)
    expect((await a.sync.status()).state).not.toBe('off')
  })

  it('keeping this computer\'s replaces it, on the version it saw', async () => {
    const server = fakeServer()
    const { a, b } = await firstAndSecond(server)
    await on(b)
    const view = await b.sync.keepMine()
    expect(view).toMatchObject({ state: 'on', remote: null })
    expect(server.row).toMatchObject({ version: 2, device: 'LAPTOP-2' })
    expect(JSON.parse(server.puts().at(-1).body).expected_version).toBe(1)
    const opened = await a.sync.status({ check: true })
    expect(opened).toMatchObject({ state: 'newer', remote: { device: 'LAPTOP-2' } })
  })

  it('keeping when someone wrote again meanwhile asks again', async () => {
    const server = fakeServer()
    const { a, b } = await firstAndSecond(server)
    await on(b)
    edit(a, (d) => {
      d.settings.fontSize = 46
    })
    await a.sync.syncNow()
    const row = { ...server.row }
    const view = await b.sync.keepMine()
    expect(view.state).toBe('newer')
    expect(server.row).toEqual(row)
  })
})

describe('tampering', () => {
  const flipped = (blob) => {
    const bytes = Buffer.from(blob, 'base64url')
    bytes[bytes.length - 1] ^= 1
    return bytes.toString('base64url')
  }

  it('a changed copy is refused at the second computer\'s phrase, and changes nothing', async () => {
    const server = fakeServer()
    const { b } = await firstAndSecond(server)
    server.row = { ...server.row, blob: flipped(server.row.blob) }
    const view = await on(b)
    expect(view).toMatchObject({ error: 'wrongPhrase', on: false })
    expect(existsSync(join(b.dir, 'sync.json'))).toBe(false)
  })

  it('a changed copy on a computer with its key is said, is not offered, and nothing is staged', async () => {
    const server = fakeServer()
    const { a, b } = await firstAndSecond(server)
    await on(b)
    await b.sync.keepMine()
    server.row = { ...server.row, version: server.row.version + 1, blob: flipped(server.row.blob) }
    const before = readFileSync(join(a.dataDir, 'workspace-layout.json'), 'utf8')
    const view = await a.sync.status({ check: true })
    expect(view).toMatchObject({ state: 'newer', problem: 'tampered', remote: { unreadable: true } })
    expect(hasPendingImport(a.dataDir)).toBe(false)
    expect(readFileSync(join(a.dataDir, 'workspace-layout.json'), 'utf8')).toBe(before)
    const apply = await a.sync.apply()
    expect(apply.error).toBe('tampered')
    expect(hasPendingImport(a.dataDir)).toBe(false)
  })

  it('an old copy handed back under a newer number cannot be opened', async () => {
    const server = fakeServer()
    const { a } = await firstAndSecond(server)
    edit(a, (d) => {
      d.settings.fontSize = 47
    })
    const old = server.row.blob
    await a.sync.syncNow()
    server.row = { ...server.row, version: 3, blob: old }
    const view = await a.sync.status({ check: true })
    expect(view.remote.unreadable).toBe(true)
  })

  it('an old copy under its own old number is said to be older, and not applied by itself', async () => {
    const server = fakeServer()
    const { a } = await firstAndSecond(server)
    const old = { ...server.row }
    edit(a, (d) => {
      d.settings.fontSize = 48
    })
    await a.sync.syncNow()
    server.row = old
    edit(a, (d) => {
      d.settings.fontSize = 49
    })
    const view = await a.sync.status({ check: true })
    expect(view).toMatchObject({ state: 'newer', remote: { older: true, unreadable: false } })
    expect(hasPendingImport(a.dataDir)).toBe(false)
  })

  it('a copy from a newer Tessel says so', async () => {
    const server = fakeServer()
    const { b } = await firstAndSecond(server)
    const bytes = Buffer.from(server.row.blob, 'base64url')
    bytes[0] = 9
    server.row = { ...server.row, blob: bytes.toString('base64url') }
    expect((await on(b)).error).toBe('newerApp')
  })
})

describe('too big', () => {
  it('over the limit: not sent, said once, and not tried again until it changes', async () => {
    const server = fakeServer()
    const a = await computer(server, { sync: { maxBlob: 10 } })
    const view = await on(a)
    expect(view).toMatchObject({ on: true, problem: 'tooBig' })
    expect(server.puts()).toHaveLength(0)
    await a.sync.syncNow()
    expect(server.puts()).toHaveLength(0)
    expect((await a.sync.status()).problem).toBe('tooBig')
  })

  it('the server\'s 413 says the same, and nothing local changes', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    edit(a, (d) => {
      d.settings.fontSize = 50
    })
    const row = { ...server.row }
    server.answer = (method) => (method === 'PUT' ? response(413, { error: 'too_large' }) : null)
    const view = await a.sync.syncNow()
    expect(view.problem).toBe('tooBig')
    expect(server.row).toEqual(row)
  })

  it('files far beyond what fits are not even read', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    writeFileSync(join(a.dataDir, 'task-board.json'), Buffer.alloc(65 * 1024 * 1024, 32))
    const view = await a.sync.syncNow()
    expect(view.problem).toBe('tooBig')
  })
})

describe('offline', () => {
  it('turning on needs the server: it says so and changes nothing', async () => {
    const server = fakeServer()
    const a = await computer(server)
    server.offline = true
    const view = await on(a)
    expect(view).toMatchObject({ error: 'offline', on: false })
    expect(existsSync(join(a.dir, 'sync.json'))).toBe(false)
  })

  it('stays on, signed in and intact; nothing throws; the next round sends it', async () => {
    const server = fakeServer()
    const a = await computer(server, { sync: { minIntervalMs: 0, debounceMs: 0 } })
    await on(a)
    server.offline = true
    edit(a, (d) => {
      d.settings.fontSize = 51
    })
    const before = readFileSync(join(a.dataDir, 'workspace-layout.json'), 'utf8')
    expect(await a.sync.status({ check: true })).toMatchObject({ on: true, signedIn: true, state: 'on', problem: 'offline' })
    expect((await a.sync.syncNow()).error).toBe('offline')
    a.clock.now += 60000
    a.sync.tick()
    await a.sync.status()
    expect(a.newer).toHaveLength(0)
    expect(readFileSync(join(a.dataDir, 'workspace-layout.json'), 'utf8')).toBe(before)
    server.offline = false
    a.clock.now += 60000
    a.sync.tick()
    await a.sync.status()
    await new Promise((r) => setTimeout(r, 30))
    expect(server.row.version).toBe(2)
    expect((await a.sync.status()).problem).toBeNull()
  })

  it('applying or keeping offline changes nothing', async () => {
    const server = fakeServer()
    const { b } = await firstAndSecond(server)
    await on(b)
    server.offline = true
    expect((await b.sync.apply()).error).toBe('offline')
    expect(hasPendingImport(b.dataDir)).toBe(false)
    const kept = await b.sync.keepMine()
    expect(kept.error).toBe('offline')
    expect(kept.state).toBe('newer')
  })
})

describe('signed out, or a session that ended', () => {
  it('a 401 signs out as everywhere, keeps every local thing, and sends nothing more', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    const before = readFileSync(join(a.dataDir, 'workspace-layout.json'), 'utf8')
    server.sessions.clear()
    const view = await a.sync.status({ check: true })
    expect(view).toMatchObject({ signedIn: false, on: false, state: 'off' })
    expect(readFileSync(join(a.dataDir, 'workspace-layout.json'), 'utf8')).toBe(before)
    expect(existsSync(join(a.dir, 'sync.json'))).toBe(true)
    expect((await a.account.status()).signedIn).toBe(false)
    const requests = server.requests.length
    edit(a, (d) => {
      d.settings.fontSize = 52
    })
    a.clock.now += 3600 * 1000
    a.sync.tick()
    await a.sync.status({ check: true })
    await a.sync.syncNow()
    expect(server.requests).toHaveLength(requests)
    expect(a.newer).toHaveLength(0)
  })

  it('signing back in brings it back without the phrase', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    await a.account.signOut()
    expect((await a.sync.status()).state).toBe('off')
    await a.signIn()
    const view = await a.sync.status({ check: true })
    expect(view).toMatchObject({ on: true, state: 'on' })
  })

  it('signing in with another account never uses this one\'s key or state', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    const row = { ...server.row }
    await a.account.signOut()
    await a.signIn(OTHER_USER)
    const puts = server.puts().length
    expect(await a.sync.status({ check: true })).toMatchObject({ on: false, state: 'off', signedIn: true })
    await a.sync.syncNow()
    expect(server.puts()).toHaveLength(puts)
    expect(server.row).toEqual(row)
  })

  it('a copy made for another account cannot be opened with the same phrase', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    const b = await computer(server, { user: OTHER_USER, name: 'OTHER' })
    expect((await on(b)).error).toBe('wrongPhrase')
  })

  it('a key sealed elsewhere (a copied data folder) asks for the phrase, and sends nothing', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    const elsewhere = { ...sealing, decryptString: () => { throw new Error('Error while decrypting the ciphertext') } }
    const copyAccount = createTesselAccount({ dir: a.dir, safeStorage: sealing, openExternal: async () => {}, scheme: 'tessel', fetchFn: server.fetch, apiUrl: API })
    const b = createSettingsSync({ dir: a.dir, dataDir: a.dataDir, safeStorage: elsewhere, account: copyAccount, deviceName: 'COPY', scryptCost: 1024 })
    const puts = server.puts().length
    expect(await b.status()).toMatchObject({ on: true, state: 'needsPhrase' })
    await b.syncNow()
    expect(server.puts()).toHaveLength(puts)
    // A newer copy meanwhile is not called damaged: it cannot be opened yet, that is all.
    server.row = { ...server.row, version: server.row.version + 1 }
    expect(await b.status({ check: true })).toMatchObject({ state: 'needsPhrase', problem: null })
    b.close()
    copyAccount.close()
  })
})

describe('turned off', () => {
  it('off means nothing at all: no request, no timer, whatever is asked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const server = fakeServer()
    const a = await computer(server)
    server.requests.length = 0
    a.sync.start()
    expect(vi.getTimerCount()).toBe(0)
    a.sync.tick()
    expect(await a.sync.status({ check: true })).toMatchObject({ on: false, state: 'off' })
    await a.sync.syncNow()
    a.sync.wake()
    await a.sync.flushAtQuit()
    vi.advanceTimersByTime(24 * 3600 * 1000)
    expect(server.requests).toHaveLength(0)
    expect(existsSync(join(a.dir, 'sync.json'))).toBe(false)
  })

  it('turning off leaves the copy there, forgets the key, and touches no setting', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    const before = readFileSync(join(a.dataDir, 'workspace-layout.json'), 'utf8')
    const view = await a.sync.turnOff()
    expect(view).toMatchObject({ on: false, state: 'off' })
    expect(server.row).not.toBeNull()
    expect(existsSync(join(a.dir, 'sync.json'))).toBe(false)
    expect(readFileSync(join(a.dataDir, 'workspace-layout.json'), 'utf8')).toBe(before)
    expect((await on(a)).state).not.toBe('off')
  })

  it('turning off with erasing erases on the server first; offline it changes nothing', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    server.offline = true
    const failed = await a.sync.turnOff({ erase: true })
    expect(failed).toMatchObject({ error: 'offline', on: true })
    expect(server.row).not.toBeNull()
    server.offline = false
    const view = await a.sync.turnOff({ erase: true })
    expect(view).toMatchObject({ on: false })
    expect(server.row).toBeNull()
    expect(server.requests.at(-1)).toMatchObject({ method: 'DELETE' })
  })

  it('erased from another computer: this one stops and says so, and never brings it back', async () => {
    const server = fakeServer()
    const { a, b } = await firstAndSecond(server)
    await on(b)
    await b.sync.keepMine()
    await b.sync.turnOff({ erase: true })
    const puts = server.puts().length
    edit(a, (d) => {
      d.settings.fontSize = 53
    })
    const view = await a.sync.status({ check: true })
    expect(view).toMatchObject({ on: false, state: 'off', notice: 'erased' })
    await a.sync.syncNow()
    expect(server.puts()).toHaveLength(puts)
    expect(server.row).toBeNull()
    expect(JSON.parse(readFileSync(join(a.dataDir, 'workspace-layout.json'), 'utf8')).settings.fontSize).toBe(53)
  })

  it('deleting the account forgets it here too', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    expect((await a.account.deleteAccount()).deleted).toBe(true)
    expect(existsSync(join(a.dir, 'sync.json'))).toBe(false)
    expect(await a.sync.status()).toMatchObject({ signedIn: false, on: false })
  })
})

describe('a lost phrase', () => {
  it('starting over erases the copy and makes a new one with a new salt; the old phrase opens nothing', async () => {
    const server = fakeServer()
    const { a, b } = await firstAndSecond(server)
    const oldSalt = server.row.salt
    const view = await b.sync.startOver('a brand new phrase for all')
    expect(view).toMatchObject({ on: true, state: 'on' })
    expect(server.row).toMatchObject({ version: 1, device: 'LAPTOP-2' })
    expect(server.row.salt).not.toBe(oldSalt)
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(true)
    // The other computer now needs the new phrase, and sends nothing until then.
    const puts = server.puts().length
    edit(a, (d) => {
      d.settings.fontSize = 54
    })
    a.newer.length = 0
    expect(await a.sync.status({ check: true })).toMatchObject({ on: true, state: 'needsPhrase', problem: null })
    expect(a.newer).toEqual([{ device: 'LAPTOP-2', at: server.row.updated_at }])
    await a.sync.status({ check: true })
    expect(a.newer).toHaveLength(1)
    await a.sync.syncNow()
    expect(server.puts()).toHaveLength(puts)
    expect((await on(a)).error).toBe('wrongPhrase')
    expect(await on(a, 'a brand new phrase for all')).toMatchObject({ state: 'newer', remote: { device: 'LAPTOP-2' } })
  })

  it('offline, starting over changes nothing', async () => {
    const server = fakeServer()
    const { b } = await firstAndSecond(server)
    const row = { ...server.row }
    server.offline = true
    expect((await b.sync.startOver('a brand new phrase for all')).error).toBe('offline')
    expect(server.row).toEqual(row)
    expect(existsSync(join(b.dir, 'sync.json'))).toBe(false)
  })
})

describe('when it runs', () => {
  const settled = () => new Promise((r) => setTimeout(r, 30))
  const timed = async (server, over = {}) => {
    const a = await computer(server, { sync: { debounceMs: 60000, minIntervalMs: 300000, maxWaitMs: 900000, ...over } })
    await on(a)
    a.sync.tick() // what the files look like now
    await settled()
    return a
  }

  it('nothing goes up while nothing changed', async () => {
    const server = fakeServer()
    const a = await timed(server)
    for (let i = 0; i < 5; i++) {
      a.clock.now += 3600 * 1000
      a.sync.tick()
      await settled()
    }
    expect(server.puts()).toHaveLength(1)
  })

  it('after a change: waits for it to settle and for the minimum interval', async () => {
    const server = fakeServer()
    const a = await timed(server)
    a.clock.now += 400000
    edit(a, (d) => {
      d.settings.fontSize = 60
    })
    a.sync.tick()
    await settled()
    expect(server.puts()).toHaveLength(1)
    a.clock.now += 30000
    a.sync.tick()
    await settled()
    expect(server.puts()).toHaveLength(1)
    a.clock.now += 40000
    a.sync.tick()
    await settled()
    expect(server.puts()).toHaveLength(2)
  })

  it('not more often than the interval, even if it changes all the time', async () => {
    const server = fakeServer()
    const a = await timed(server)
    const times = []
    let last = server.puts().length
    for (let i = 0; i < 40; i++) {
      a.clock.now += 60000
      edit(a, (d) => {
        d.settings.fontSize = 100 + i
      })
      a.sync.tick()
      await settled()
      if (server.puts().length > last) {
        times.push(a.clock.now)
        last = server.puts().length
      }
    }
    // It never settles, so the longest wait decides; and it does go up.
    expect(times.length).toBeGreaterThan(1)
    expect(times.length).toBeLessThan(10)
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(300000)
  })

  it('a save that did not change the setup sends nothing', async () => {
    const server = fakeServer()
    const a = await timed(server, { debounceMs: 0, minIntervalMs: 0 })
    edit(a, () => {})
    a.clock.now += 60000
    a.sync.tick()
    await settled()
    expect(server.puts()).toHaveLength(1)
  })

  it('a file being written is left for the next round: no copy goes up without it', async () => {
    const server = fakeServer()
    const a = await timed(server, { debounceMs: 0, minIntervalMs: 0 })
    writeFileSync(join(a.dataDir, 'workspace-layout.json'), '{ half written')
    a.clock.now += 60000
    a.sync.tick()
    await settled()
    expect(server.puts()).toHaveLength(1)
    writeFileSync(join(a.dataDir, 'workspace-layout.json'), JSON.stringify(layout({ selectedShell: 'whole-again' })))
    a.clock.now += 60000
    a.sync.tick()
    await settled()
    expect(server.puts()).toHaveLength(2)
  })

  it('a copy a backup import staged: nothing goes up until it is in place', async () => {
    const server = fakeServer()
    const a = await timed(server, { debounceMs: 0, minIntervalMs: 0 })
    mkdirSync(join(a.dataDir, PENDING_DIR))
    writeFileSync(join(a.dataDir, PENDING_DIR, 'manifest.json'), '{}')
    edit(a, (d) => {
      d.settings.fontSize = 61
    })
    a.clock.now += 60000
    a.sync.tick()
    await settled()
    expect(server.puts()).toHaveLength(1)
  })

  it('the server\'s daily limit: it says so and waits, without asking again each minute', async () => {
    const server = fakeServer()
    const a = await timed(server, { debounceMs: 0, minIntervalMs: 0 })
    server.answer = (method) => (method === 'PUT' ? response(429, { error: 'rate_limited' }) : null)
    edit(a, (d) => {
      d.settings.fontSize = 62
    })
    a.clock.now += 60000
    a.sync.tick()
    await settled()
    const tried = server.puts().length
    expect((await a.sync.status()).problem).toBe('rateLimited')
    for (let i = 0; i < 5; i++) {
      a.clock.now += 60000
      a.sync.tick()
      await settled()
    }
    expect(server.puts()).toHaveLength(tried)
    server.answer = null
    a.clock.now += 3600 * 1000
    a.sync.tick()
    await settled()
    expect(server.row.version).toBe(2)
  })

  it('at start: looks for a newer copy once the window is there, tells it once', async () => {
    const server = fakeServer()
    const { a, b } = await firstAndSecond(server)
    await on(b)
    await b.sync.keepMine()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    a.sync.close()
    const next = await computer(server, { name: 'DESKTOP-1', dataDir: a.dataDir, sync: { firstLookMs: 1 } })
    next.sync.start()
    await new Promise((r) => setTimeout(r, 40))
    await next.sync.status()
    expect(next.newer).toEqual([{ device: 'LAPTOP-2', at: server.row.updated_at }])
    expect((await next.sync.status()).state).toBe('newer')
    next.sync.close()
    const again = await computer(server, { name: 'DESKTOP-1', dataDir: a.dataDir, sync: { firstLookMs: 1 } })
    again.sync.start()
    await new Promise((r) => setTimeout(r, 40))
    await again.sync.status()
    expect(again.newer).toHaveLength(0)
    expect((await again.sync.status()).state).toBe('newer')
    again.sync.close()
  })
})

describe('at quit', () => {
  it('sends what changed, if it can be done quickly', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    edit(a, (d) => {
      d.settings.fontSize = 70
    })
    expect(await a.sync.flushAtQuit()).toBe('sent')
    expect(server.row.version).toBe(2)
  })

  it('nothing changed, nothing goes up', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    expect(await a.sync.flushAtQuit()).toBe('same')
    expect(server.puts()).toHaveLength(1)
  })

  it('a server that does not answer never holds the quit back', async () => {
    const server = fakeServer()
    const a = await computer(server, { sync: { quitMs: 30 } })
    await on(a)
    edit(a, (d) => {
      d.settings.fontSize = 71
    })
    server.answer = () => new Promise(() => {})
    const at = Date.now()
    expect(await a.sync.flushAtQuit()).toBe(false)
    expect(Date.now() - at).toBeLessThan(1000)
  })

  it('offline, or with a question open, it does nothing and never throws', async () => {
    const server = fakeServer()
    const { a, b } = await firstAndSecond(server)
    await on(b)
    expect(await b.sync.flushAtQuit()).toBe(false)
    server.offline = true
    edit(a, (d) => {
      d.settings.fontSize = 72
    })
    expect(await a.sync.flushAtQuit()).toBe('failed')
  })

  it('an upload whose answer never came is recognized at the next start: nobody is asked', async () => {
    const server = fakeServer()
    const a = await computer(server)
    await on(a)
    edit(a, (d) => {
      d.settings.fontSize = 73
    })
    // It reaches the server, but this computer never hears back.
    const account = a.account
    const authed = account.authed
    account.authed = async (path, options) => {
      const res = await authed(path, options)
      if (options && options.method === 'PUT') throw new TypeError('connection lost')
      return res
    }
    await a.sync.flushAtQuit()
    account.authed = authed
    expect(server.row.version).toBe(2)
    a.newer.length = 0
    const view = await a.sync.status({ check: true })
    expect(view).toMatchObject({ state: 'on', remote: null })
    expect(a.newer).toHaveLength(0)
  })
})

// The window restores what localizeLayout writes: its rule for a pane that comes back asleep is
// read from App.vue itself, so the two cannot drift apart unseen.
describe('what the window does with a copy made ready for this computer', () => {
  const app = readFileSync(join(__dirname, '../../renderer/src/App.vue'), 'utf8')
  const start = app.indexOf('function restoresAsleep(snap)')
  const body = app.slice(start, app.indexOf('// A saved leaf whose terminal may still run', start))
  const restoresAsleep = new Function('safeSessionId', `${body}; return restoresAsleep`)(safeSessionId)
  const pane = (over = {}) => ({ type: 'leaf', kind: 'agent', id: 'pane-1', shellId: 'powershell', agentId: 'claude', agentCommand: 'claude', sessionId: '0f3c2a10-1111-4222-8333-abcdefabcdef', ...over })
  const made = (tree, cwd = 'C:/here', options = {}) => JSON.parse(localizeLayout(JSON.stringify({ workspaces: [{ cwd, tree }] }), { folderExists: () => true, now: () => 5, ...options }).body).workspaces[0].tree

  it('an agent made ready comes back asleep: no terminal, nothing started, until it is opened', () => {
    expect(restoresAsleep(made(pane()))).toBe(true)
    expect(restoresAsleep(made(pane({ sessionId: 'ses_01234567890123456789' })))).toBe(true)
  })

  it('every conversation id the window accepts is one the copy keeps asleep, and the reverse', () => {
    for (const id of ['abcdef', 'a'.repeat(80), 'a'.repeat(81), 'abc', '-abcdef', 'ab cdef', '../../x', '']) {
      expect(made(pane({ sessionId: id })).agentCommand === 'claude').toBe(safeSessionId(id))
    }
  })

  it('an agent whose folder is gone has no command left: the window makes it a plain terminal', () => {
    const tree = made(pane(), 'C:/gone', { folderExists: () => false })
    expect(tree.agentCommand).toBeNull()
    expect(restoresAsleep(tree)).toBe(false)
    expect(app).toContain("snap.kind === 'agent' && snap.agentCommand")
  })

  it('a terminal with no folder of its own starts in the home folder (main\'s pty:create)', () => {
    const main = readFileSync(join(__dirname, '../index.js'), 'utf8')
    expect(main).toContain('const startDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir()')
  })
})
