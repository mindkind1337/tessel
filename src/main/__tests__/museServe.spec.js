// @vitest-environment node
// Muse Code's own server (`muse serve`, its session protocol) as Tessel asks
// it: the handshake, then queries that open no session (model/list). A fake `muse serve` answers with frames shaped
// like the protocol's (newline-delimited JSON-RPC 2.0); no real Muse runs.
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { win32, posix } from 'path'
import { findMuse, museBinaryIn, museServe } from '../museServe'
import { createModelLister } from '../agentModelList'
import { parseMuseModelList, listedToCatalogModels } from '../../shared/agentModelProbe'
import { getAgentSessionOptionCatalog } from '../../shared/agentSessionOptions'
import fs from 'fs'
import os from 'os'
import { join } from 'path'

// A fake `muse serve`: answers each request with handlers[method](params),
// records every frame it got. exitCode: it exits at once with that code.
function fakeServe(handlers = {}, { exitCode = null, silent = false } = {}) {
  const frames = []
  const spawn = vi.fn((file, args) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn(() => child.emit('exit', null))
    child.file = file
    child.args = args
    let buf = ''
    child.stdin.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        frames.push(msg)
        if (silent || msg.id === undefined) continue
        const answer = msg.method === 'initialize' ? { result: { schema: { fingerprint: 'f' }, serverInfo: { name: 'muse' }, museHome: '/h', experimentalApi: true, grantedCapabilities: [], platformFamily: 'windows', platformOs: 'windows', userAgent: 'muse' } } : handlers[msg.method] ? handlers[msg.method](msg.params) : { error: { code: -32601, message: 'method not found' } }
        // A notification first: never mistaken for an answer.
        child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/listChanged', params: {}, emittedAtMs: 1 }) + '\n')
        child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...answer }) + '\n')
      }
    })
    child.stdin.on('finish', () => setImmediate(() => child.emit('exit', 0)))
    if (exitCode !== null) setImmediate(() => child.emit('exit', exitCode))
    return child
  })
  return { spawn, frames }
}
const USAGE = {
  observedAtMs: 1760536800000,
  tier: 'power',
  window: { resetsAtMs: 1760540400000, usedPercent: 42, windowDurationMins: 300 },
  weekly: { resetsAtMs: 1761000000000, usedPercent: 7 }
}

describe('`muse serve`: the exchange', () => {
  it('initialize, initialized, then each query; its stdin closed at the end', async () => {
    const { spawn, frames } = fakeServe({ 'usage/read': () => ({ result: { usage: USAGE } }), 'account/read': () => ({ result: { state: 'accountLogin', credentialRequired: true, label: 'me@example.com' } }) })
    const res = await museServe('C:\\m\\muse-bin-1.4.9-R1.exe', [{ method: 'usage/read' }, { method: 'account/read' }], { spawn, env: {}, experimental: true, version: '1.15.0' })
    expect(spawn).toHaveBeenCalledWith('C:\\m\\muse-bin-1.4.9-R1.exe', ['serve'], expect.objectContaining({ windowsHide: true }))
    expect(frames.map((f) => f.method)).toEqual(['initialize', 'initialized', 'usage/read', 'account/read'])
    expect(frames[0]).toMatchObject({ jsonrpc: '2.0', id: 1, params: { clientInfo: { name: 'tessel', version: '1.15.0' }, capabilities: { userInputDialogs: false, experimentalApi: true } } })
    // A query that takes nothing is sent without params.
    expect('params' in frames[2]).toBe(false)
    expect(res).toEqual({ ok: true, results: { 'usage/read': { result: { usage: USAGE } }, 'account/read': { result: { state: 'accountLogin', credentialRequired: true, label: 'me@example.com' } } } })
  })

  it('a query it refuses is its error; one that never answers times out; code 3 before answering is its settings or sign-in', async () => {
    const refused = await museServe('muse', [{ method: 'account/read' }], { spawn: fakeServe().spawn })
    expect(refused).toEqual({ ok: true, results: { 'account/read': { error: { code: -32601, message: 'method not found' } } } })
    expect(await museServe('muse', [{ method: 'usage/read' }], { spawn: fakeServe({}, { silent: true }).spawn, timeoutMs: 50 })).toEqual({ ok: false, reason: 'timeout' })
    expect(await museServe('muse', [{ method: 'usage/read' }], { spawn: fakeServe({}, { exitCode: 3, silent: true }).spawn })).toEqual({ ok: false, reason: 'config' })
    const missing = vi.fn(() => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    })
    expect(await museServe('muse', [], { spawn: missing })).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('finding muse', () => {
  const files = (list) => (f) => list.includes(f)
  it("Windows: the binary its launcher runs (named by .muse-version), never muse.cmd; the installer's folder when not on PATH", () => {
    const dir = 'C:\\Users\\me\\AppData\\Local\\Programs\\muse'
    const exe = win32.join(dir, 'muse-bin-1.4.9-R20261015.exe')
    const exists = files([win32.join(dir, 'muse.cmd'), exe])
    const read = (f) => (f === win32.join(dir, '.muse-version') ? '1.4.9-R20261015\n' : '')
    expect(museBinaryIn(dir, { exists, read })).toBe(exe)
    expect(findMuse({ platform: 'win32', env: { Path: 'C:\\Windows' }, home: 'C:\\Users\\me', exists, read })).toBe(exe)
    expect(findMuse({ platform: 'win32', env: { Path: `C:\\Windows;${dir}`, LOCALAPPDATA: 'C:\\Elsewhere' }, home: 'C:\\Users\\me', exists, read })).toBe(exe)
    // A version that is not one of its own: nothing run.
    expect(museBinaryIn(dir, { exists, read: () => '..\\..\\evil' })).toBe(null)
    expect(findMuse({ platform: 'win32', env: { Path: '.;relative' }, home: 'C:\\Nobody', exists, read })).toBe(null)
  })
  it('elsewhere: its launcher in ~/.local/bin (or on PATH)', () => {
    expect(findMuse({ platform: 'linux', env: { PATH: '/usr/bin' }, home: '/home/me', exists: files(['/home/me/.local/bin/muse']) })).toBe(posix.join('/home/me', '.local', 'bin', 'muse'))
    expect(findMuse({ platform: 'linux', env: { PATH: '/opt/muse/bin:/usr/bin' }, home: '/home/me', exists: files(['/opt/muse/bin/muse']) })).toBe('/opt/muse/bin/muse')
  })
})

describe('Muse Code models (model/list)', () => {
  const LIST = {
    providerId: 'meta',
    profileId: null,
    source: 'providerCatalog',
    models: [
      { modelId: 'muse-spark-1.3', displayLabel: 'Muse Spark 1.3', description: null, isDefault: true, isActive: false, variants: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high', contextLimit: 1000000, outputLimit: null, cost: null, profileId: null, providerId: 'meta', releaseDate: null },
      { modelId: 'muse-spark-1.3-contributor', displayLabel: 'Muse Spark 1.3 (Contributor)', description: 'Used to improve products', isDefault: false, isActive: false, variants: 'unknown', contextLimit: null, outputLimit: null, cost: null, profileId: null, providerId: 'meta', releaseDate: null },
      { modelId: 'bad id; rm -rf', displayLabel: 'x', isDefault: false }
    ]
  }
  it('each model with its efforts and default; an id a shell could read as more is dropped', () => {
    const rows = parseMuseModelList(JSON.stringify(LIST))
    expect(rows).toEqual([
      { id: 'muse-spark-1.3', label: 'Muse Spark 1.3', effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', isDefault: true },
      { id: 'muse-spark-1.3-contributor', label: 'Muse Spark 1.3 (Contributor)', description: 'Used to improve products' }
    ])
    const [spark, contributor] = listedToCatalogModels('muse', rows)
    expect(spark.options[0].kind).toMatchObject({ type: 'select', defaultValue: 'high' })
    expect(spark.options[0].kind.choices.map((c) => c.value)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(spark.options[0].apply.launchArgs('xhigh')).toEqual(['--reasoning-effort', 'xhigh'])
    expect(contributor.options).toEqual([])
    // The pane picker: --model, /model <id> in a running session, its effort by /effort.
    const catalog = getAgentSessionOptionCatalog('muse')
    expect(catalog.modelApply.launchArgs('muse-spark-1.3')).toEqual(['--model', 'muse-spark-1.3'])
    expect(catalog.modelApply.midSession.build('muse-spark-1.3')).toBe('/model muse-spark-1.3')
    expect(catalog.unknownModelOptions[0].apply.midSession.build('max')).toBe('/effort max')
    expect(catalog.unknownModelOptions[0].kind.choices.map((c) => c.value)).not.toContain('none')
  })
  it('Settings > Agents > Refresh models asks `muse serve`, and keeps the list', async () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-muse-models-'))
    try {
      const { spawn, frames } = fakeServe({ 'model/list': () => ({ result: LIST }) })
      const lister = createModelLister(dir, { spawn, findMsp: () => 'C:\\m\\muse.exe', env: {}, now: () => 7, museCatalog: async () => null })
      const res = await lister.probe('muse')
      expect(res).toMatchObject({ ok: true, fetchedAt: 7 })
      expect(res.models.map((m) => m.id)).toEqual(['muse-spark-1.3', 'muse-spark-1.3-contributor'])
      expect(frames.map((f) => f.method)).toEqual(['initialize', 'initialized', 'model/list'])
      expect(lister.list().muse.models).toHaveLength(2)
      expect(await createModelLister(dir, { spawn, findMsp: () => null, env: {}, museCatalog: async () => null }).probe('muse')).toMatchObject({ ok: false, reason: 'not-found' })
      // Its catalog on this computer: read instead, `muse serve` never started.
      const spawned = spawn.mock.calls.length
      const catalog = async () => ({ models: [{ modelId: 'muse-wonder-1.0', displayLabel: 'muse-wonder-1.0', isDefault: true, variants: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }] })
      const got = await createModelLister(dir, { spawn, findMsp: () => 'C:\\m\\muse.exe', env: {}, now: () => 8, museCatalog: catalog }).probe('muse')
      expect(got).toMatchObject({ ok: true })
      expect(got.models.map((m) => m.id)).toEqual(['muse-wonder-1.0'])
      expect(spawn.mock.calls.length).toBe(spawned)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
