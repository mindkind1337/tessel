// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import { dirname, join, resolve, sep } from 'path'
import { createCodexUsageScanner } from '../codexUsageScan'

let fixture
let root
let cacheFile
beforeEach(() => {
  fixture = fs.mkdtempSync(join(os.tmpdir(), 'tessel-usage-scan-'))
  root = join(fixture, 'codex')
  cacheFile = join(fixture, 'cache', 'usage.json')
  fs.mkdirSync(root)
})
afterEach(() => {
  vi.restoreAllMocks()
  const target = resolve(fixture)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-usage-scan-'))
    throw new Error('Unexpected cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
})
function put(name, contents, base = root) {
  const file = join(base, name)
  fs.mkdirSync(dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
  return file
}
const line = (id) => JSON.stringify({ id }) + '\n'
const defaults = () => ({
  root,
  cacheFile,
  makeState: () => ({ events: [] }),
  consumeLine: (text, state) => {
    try {
      const value = JSON.parse(text)
      if (typeof value.id === 'string') state.events.push(value.id)
    } catch {}
  },
  validateState: (value) =>
    value && Array.isArray(value.events) && value.events.every((id) => typeof id === 'string')
})
const scanner = (extra = {}) => createCodexUsageScanner({ ...defaults(), ...extra })
const events = (result) => result.files.flatMap((file) => file.state.events)
const inaccessible = () => Object.assign(new Error('unavailable'), { code: 'EACCES' })

describe('incremental local Codex transcript scan', () => {
  it('reads sessions and archives in deterministic order, persisting parsed state only', async () => {
    put('sessions/2026/09/rollout-z.jsonl', line('second') + '{"conversation":"TOP SECRET"}\n')
    put('archived_sessions/rollout-a.jsonl', line('first'))
    put('sessions/ignored.jsonl', line('ignored'))
    const result = await scanner()()
    expect(events(result)).toEqual(['first', 'second'])
    expect(result.stats).toMatchObject({ files: 2, read: 2, reused: 0, appended: 0 })
    expect(result.warnings).toEqual([])
    const cached = fs.readFileSync(cacheFile, 'utf8')
    expect(cached).not.toContain('TOP SECRET')
    expect(cached).not.toContain('conversation')
  })

  it('does not reread unchanged transcripts, including after a persisted restart', async () => {
    put('sessions/rollout-a.jsonl', line('one'))
    const scan = scanner()
    await scan()
    const open = vi.spyOn(fsp, 'open')
    const write = vi.spyOn(fsp, 'writeFile')
    const second = await scan()
    const restarted = await scanner()()
    for (const result of [second, restarted]) {
      expect(events(result)).toEqual(['one'])
      expect(result.stats).toMatchObject({ files: 1, read: 0, reused: 1, bytesRead: 0 })
    }
    expect(open).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    // A caller cannot mutate the scanner's cached state through its result.
    second.files[0].state.events.push('not a transcript')
    expect(events(await scan())).toEqual(['one'])
  })

  it('rereads incomplete suffixes once, preserving UTF8 split across append and restart', async () => {
    const pending = Buffer.from(line('été 🌍'))
    const split = pending.indexOf(Buffer.from('🌍')) + 2
    const file = put(
      'sessions/rollout-a.jsonl',
      Buffer.concat([Buffer.from(line('one')), pending.subarray(0, split)])
    )
    const scan = scanner()
    expect(events(await scan())).toEqual(['one'])
    fs.appendFileSync(file, pending.subarray(split, pending.length - 1))
    const incomplete = await scan()
    expect(events(incomplete)).toEqual(['one'])
    expect(incomplete.stats.appended).toBe(1)
    fs.appendFileSync(file, '\n')
    const complete = await scanner()()
    expect(events(complete)).toEqual(['one', 'été 🌍'])
    expect(complete.stats.appended).toBe(1)
    expect(events(await scan())).toEqual(['one', 'été 🌍'])
  })

  it('only consumes appended lines instead of reprocessing the full file', async () => {
    const file = put(
      'sessions/rollout-a.jsonl',
      Array.from({ length: 10000 }, (_, i) => line(`event${i}`)).join('')
    )
    const consumeLine = vi.fn(defaults().consumeLine)
    const scan = scanner({ consumeLine })
    await scan()
    consumeLine.mockClear()
    fs.appendFileSync(file, line('last'))
    const result = await scan()
    expect(consumeLine).toHaveBeenCalledTimes(1)
    expect(events(result)).toHaveLength(10001)
    expect(result.stats.appended).toBe(1)
    expect(result.stats.bytesRead).toBeLessThan(40000)
  })

  it('reparses truncation, same-size rewrite and replacement instead of mixing states', async () => {
    const file = put('sessions/rollout-a.jsonl', line('old') + line('old2'))
    const scan = scanner()
    await scan()
    fs.writeFileSync(file, line('new'))
    expect(events(await scan())).toEqual(['new'])
    fs.writeFileSync(file, line('two'))
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(events(await scan())).toEqual(['two'])
    fs.renameSync(file, `${file}.old`)
    fs.writeFileSync(file, line('replaced'))
    expect(events(await scan())).toEqual(['replaced'])
  })

  it('rejects incremental reuse when an old boundary was overwritten before append', async () => {
    const file = put('sessions/rollout-a.jsonl', line('before'))
    const scan = scanner()
    await scan()
    fs.writeFileSync(file, line('after!') + line('appended'))
    const result = await scan()
    expect(events(result)).toEqual(['after!', 'appended'])
    expect(result.stats.appended).toBe(0)
  })

  it('keeps copied sessions independently and removes only successfully discovered deletions', async () => {
    const first = put('sessions/rollout-a.jsonl', line('same'))
    const second = put('archived_sessions/rollout-b.jsonl', line('same'))
    const scan = scanner()
    expect(events(await scan())).toEqual(['same', 'same'])
    fs.unlinkSync(first)
    const result = await scan()
    expect(result.files.map((file) => file.path)).toEqual([second])
    expect(events(result)).toEqual(['same'])
    fs.unlinkSync(second)
    fs.rmdirSync(dirname(second))
    expect((await scan()).files).toEqual([])
  })

  it('ignores malformed JSON, skips huge lines with a warning and counts subsequent lines', async () => {
    put(
      'sessions/rollout-a.jsonl',
      '{bad json}\n' + 'x'.repeat(2 * 1024 * 1024 + 1) + '\n' + line('after')
    )
    const scan = scanner()
    const result = await scan()
    expect(events(result)).toEqual(['after'])
    expect(result.warnings.join(' ')).toContain('Skipped transcript line larger')
    expect((await scan()).warnings).toEqual(result.warnings)
  })

  it('rebuilds corrupt, invalid-state, and version-incompatible caches', async () => {
    put('sessions/rollout-a.jsonl', line('one'))
    fs.mkdirSync(dirname(cacheFile))
    fs.writeFileSync(cacheFile, '{broken')
    let result = await scanner()()
    expect(events(result)).toEqual(['one'])
    expect(result.warnings.join(' ')).toContain('cache rebuilt')
    const saved = JSON.parse(fs.readFileSync(cacheFile))
    saved.files[0].state = { events: [123] }
    fs.writeFileSync(cacheFile, JSON.stringify(saved))
    result = await scanner()()
    expect(result.stats.read).toBe(1)
    expect(events(result)).toEqual(['one'])
    result = await scanner({ cacheVersion: 2 })()
    expect(result.stats.read).toBe(1)
    expect(events(result)).toEqual(['one'])
  })

  it('never carries cache state between different Codex roots', async () => {
    put('sessions/rollout-a.jsonl', line('home-one'))
    await scanner()()
    const other = join(fixture, 'other')
    put('sessions/rollout-a.jsonl', line('home-two'), other)
    const result = await scanner({ root: other })()
    expect(events(result)).toEqual(['home-two'])
    expect(result.stats.read).toBe(1)
  })

  it('skips directory junctions and symlink entries without following them', async () => {
    const outside = join(fixture, 'outside')
    put('rollout-secret.jsonl', line('must not read'), outside)
    const sessions = join(root, 'sessions')
    fs.mkdirSync(sessions)
    fs.symlinkSync(
      outside,
      join(sessions, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    // Mock only a file Dirent: Windows can require elevated privileges for file symlinks.
    const realOpendir = fsp.opendir.bind(fsp)
    vi.spyOn(fsp, 'opendir').mockImplementation(async (path, ...args) => {
      if (String(path) !== sessions) return realOpendir(path, ...args)
      const items = []
      for await (const entry of await realOpendir(path, ...args)) items.push(entry)
      items.push({ name: 'rollout-link.jsonl', isSymbolicLink: () => true })
      return (async function* () {
        yield* items
      })()
    })
    const result = await scanner()()
    expect(result.files).toEqual([])
    expect(
      result.warnings.filter((warning) => warning.includes('Skipped transcript link'))
    ).toHaveLength(2)
  })

  it('reports directories beyond the bounded scan depth', async () => {
    put(`sessions/${Array(9).fill('deep').join('/')}/rollout-a.jsonl`, line('too deep'))
    const result = await scanner()()
    expect(result.files).toEqual([])
    expect(result.warnings.join(' ')).toContain('exceeds scan depth')
  })

  it('retains parsed data when the atomic cache write fails, and retries later', async () => {
    put('sessions/rollout-a.jsonl', line('one'))
    const rename = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(inaccessible())
    const scan = scanner()
    const failed = await scan()
    expect(events(failed)).toEqual(['one'])
    expect(failed.warnings.join(' ')).toContain('cache could not be saved')
    expect(fs.readdirSync(dirname(cacheFile))).toEqual([])
    const retried = await scan()
    expect(events(retried)).toEqual(['one'])
    expect(retried.stats.reused).toBe(1)
    expect(retried.warnings).toEqual([])
    expect(rename).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(cacheFile)).toBe(true)
  })

  it('preserves the previous state on a file read failure, without partially mutating it', async () => {
    const file = put('sessions/rollout-a.jsonl', line('one'))
    const scan = scanner()
    await scan()
    fs.appendFileSync(file, line('two'))
    const open = vi.spyOn(fsp, 'open').mockRejectedValueOnce(inaccessible())
    const failed = await scan()
    expect(events(failed)).toEqual(['one'])
    expect(failed.warnings.join(' ')).toContain('usage stale (EACCES)')
    open.mockRestore()
    expect(events(await scan())).toEqual(['one', 'two'])
  })

  it('isolates mutable parser state if parsing throws after an incremental mutation', async () => {
    const file = put('sessions/rollout-a.jsonl', line('one'))
    let fail = false
    const consume = defaults().consumeLine
    const scan = scanner({
      consumeLine: (text, state) => {
        consume(text, state)
        if (fail) throw new Error('parser failure')
      }
    })
    await scan()
    fs.appendFileSync(file, line('two'))
    fail = true
    expect(events(await scan())).toEqual(['one'])
    fail = false
    expect(events(await scan())).toEqual(['one', 'two'])
  })

  it('preserves cached subtrees when a directory is inaccessible, then removes confirmed deletions', async () => {
    const file = put('sessions/2026/rollout-a.jsonl', line('one'))
    const scan = scanner()
    await scan()
    fs.unlinkSync(file)
    const realOpendir = fsp.opendir.bind(fsp)
    const opendir = vi.spyOn(fsp, 'opendir').mockImplementation((path, ...args) => {
      if (String(path) === dirname(file)) return Promise.reject(inaccessible())
      return realOpendir(path, ...args)
    })
    const failed = await scan()
    expect(events(failed)).toEqual(['one'])
    expect(failed.warnings.join(' ')).toContain('directory unavailable (EACCES)')
    opendir.mockRestore()
    expect((await scan()).files).toEqual([])
  })

  it('preserves all cached data when the root is temporarily missing or inaccessible', async () => {
    put('sessions/rollout-a.jsonl', line('one'))
    const scan = scanner()
    await scan()
    const original = fsp.lstat.bind(fsp)
    const lstat = vi.spyOn(fsp, 'lstat').mockImplementation((path, ...args) => {
      if (String(path) === root) return Promise.reject(inaccessible())
      return original(path, ...args)
    })
    expect(events(await scan())).toEqual(['one'])
    lstat.mockRestore()
    fs.renameSync(root, `${root}-offline`)
    const missing = await scanner()()
    expect(events(missing)).toEqual(['one'])
    expect(missing.warnings.join(' ')).toContain('Codex home unavailable')
    fs.renameSync(`${root}-offline`, root)
    expect(events(await scan())).toEqual(['one'])
  })

  it('only parses the captured file size when another writer appends during the scan', async () => {
    const file = put('sessions/rollout-a.jsonl', line('one'))
    let appended = false
    const consume = defaults().consumeLine
    const scan = scanner({
      consumeLine: (text, state) => {
        consume(text, state)
        if (!appended) {
          appended = true
          fs.appendFileSync(file, line('two'))
        }
      }
    })
    expect(events(await scan())).toEqual(['one'])
    const next = await scan()
    expect(events(next)).toEqual(['one', 'two'])
    expect(next.stats.appended).toBe(1)
  })

  it('rejects a changed prefix after parsing without committing the tentative state', async () => {
    const file = put('sessions/rollout-a.jsonl', line('one'))
    let rewrite = false
    const consume = defaults().consumeLine
    const scan = scanner({
      consumeLine: (text, state) => {
        consume(text, state)
        if (rewrite) {
          rewrite = false
          fs.writeFileSync(file, line('new'))
        }
      }
    })
    await scan()
    fs.appendFileSync(file, line('two'))
    rewrite = true
    const interrupted = await scan()
    expect(events(interrupted)).toEqual(['one'])
    expect(interrupted.warnings.join(' ')).toContain('usage stale')
    expect(events(await scan())).toEqual(['new'])
  })

  it('supports memory-only caches and coalesces concurrent calls', async () => {
    put('sessions/rollout-a.jsonl', line('one'))
    const consumeLine = vi.fn(defaults().consumeLine)
    const scan = scanner({ cacheFile: undefined, consumeLine })
    const first = scan()
    const second = scan()
    expect(second).toBe(first)
    const result = await first
    expect(events(result)).toEqual(['one'])
    expect(consumeLine).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(cacheFile)).toBe(false)
    expect((await scan()).stats.reused).toBe(1)
  })
})
