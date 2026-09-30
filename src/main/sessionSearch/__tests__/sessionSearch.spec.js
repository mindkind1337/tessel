// @vitest-environment node
// Synthetic session folders in a temp home only: never the real home, never an agent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createSessionSearch } from '../index'
import { createSessionSearchCore, maskSnippet } from '../core'
import { serve } from '../worker'
import { listSources, readSlice, rowsFromLines } from '../indexer'
import { openStore } from '../store'
import { identifierShadowTerms, indexTokens, planQuery } from '../query'

const C1 = '11111111-2222-4333-8444-555555555555'
const C2 = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const X1 = '01946a2b-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const iso = (ms) => new Date(ms).toISOString()

let home, dir, search
const NOW = Date.parse('2026-09-29T12:00:00Z')
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-ss-home-'))
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-ss-data-'))
  search = null
})
afterEach(() => {
  if (search) search.close()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

function put(rel, text, mtime = NOW - 60000) {
  const f = join(home, rel)
  fs.mkdirSync(join(f, '..'), { recursive: true })
  fs.writeFileSync(f, text)
  fs.utimesSync(f, new Date(mtime), new Date(mtime))
  return f
}
function claude(id, cwd, turns, mtime) {
  const rows = []
  turns.forEach(([prompt, answer], i) => {
    rows.push({ type: 'user', uuid: `u${i}`, cwd, timestamp: iso(NOW - 3600000 + i * 1000), message: { role: 'user', content: prompt } })
    rows.push({ type: 'assistant', uuid: `a${i}`, cwd, timestamp: iso(NOW - 3600000 + i * 1000 + 500), message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: answer }] } })
  })
  return put(`.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`, lines(rows), mtime)
}
function service(extra = {}) {
  search = createSessionSearchCore({ dir, home, now: () => NOW, timers: { setTimeout: () => null, clearTimeout: () => {} }, ...extra })
  return search
}
function drain(s) {
  for (let i = 0; i < 1000 && s.runOnce(); i++);
}

describe('the query planner', () => {
  it('tokens as the index draws them; identifiers split into their pieces', () => {
    expect(indexTokens('fix src/main/foo-bar.ts -- now')).toEqual(['fix', 'src/main/foo-bar.ts', 'now'])
    expect(identifierShadowTerms('resolveTerminalPath src/main/foo-bar.ts')).toEqual(['resolveterminalpath', 'resolve', 'terminal', 'path', 'src', 'main', 'foo', 'bar', 'ts'])
    const prose = planQuery('how to fix the relay')
    expect(prose.literal).toBe(false)
    expect(prose.body).toEqual(['fix', 'relay'])
    expect(prose.phrase).toEqual(['how', 'to', 'fix', 'the', 'relay'])
    expect(planQuery('resolveTerminalPath').literal).toBe(true)
    expect(planQuery('resolveTerminalPath').terms).toEqual(expect.arrayContaining(['resolveTerminalPath', 'terminal']))
  })
})

describe('reading the agents files', () => {
  it('lists each agent file inside its own folder, newest first, within the retention', () => {
    claude(C1, 'C:\\proj', [['old', 'x']], NOW - 100 * 86400000)
    claude(C2, 'C:\\proj', [['new', 'y']], NOW - 1000)
    put(`.codex/sessions/2026/09/29/rollout-2026-09-29T10-00-00-${X1}.jsonl`, lines([{ timestamp: iso(NOW), type: 'session_meta', payload: { id: X1, cwd: 'C:\\other' } }]), NOW - 2000)
    put('.claude/projects/p/not-a-session.txt', 'x')
    const all = listSources({ home, titles: false })
    expect(all.map((s) => [s.agent, s.id])).toEqual([['claude', C2], ['codex', X1], ['claude', C1]])
    expect(listSources({ home, since: NOW - 90 * 86400000, titles: false }).map((s) => s.id)).toEqual([C2, X1])
  })

  it('a slice is whole lines only; a last line still being written waits; a giant line is passed over', () => {
    const f = put('x.jsonl', '{"a":1}\n{"b":2}\n{"c":')
    const first = readSlice(f, 0, 1024)
    expect(first.lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(first).toMatchObject({ next: 16, done: false })
    expect(readSlice(f, first.next, 1024)).toMatchObject({ lines: [], next: 16, done: true })
    const small = readSlice(f, 0, 9)
    expect(small.lines).toEqual(['{"a":1}'])
    expect(small.next).toBe(8)
    expect(rowsFromLines('claude', [JSON.stringify({ type: 'user', message: { content: 'hi' } })])).toEqual([{ role: 'user', text: 'hi', ts: null }])
  })
})

describe('session search', () => {
  it('is off until turned on: nothing is read, no index file, a search says disabled', () => {
    claude(C1, 'C:\\proj', [['find the needle', 'in the haystack']])
    const s = service()
    expect(s.status()).toMatchObject({ enabled: false, phase: 'idle', sessions: 0 })
    expect(s.search({ query: 'needle' })).toEqual({ ok: false, code: 'disabled' })
    expect(s.runOnce()).toBe(false)
    expect(fs.existsSync(join(dir, 'session-search', 'index.sqlite'))).toBe(false)
  })

  it('indexes what was said and finds it: a phrase, all the words, any word, an identifier piece; scopes and agents', () => {
    claude(C1, 'C:\\proj', [['Why does resolveTerminalPath fail on Windows?', 'The separator is wrong in src/main/paths.js.'], ['thanks', 'You are welcome.']])
    claude(C2, 'C:\\proj\\sub', [['Write the release notes', 'Here are the release notes for version 2.']])
    put(
      `.codex/sessions/2026/09/29/rollout-2026-09-29T10-00-00-${X1}.jsonl`,
      lines([
        { timestamp: iso(NOW - 5000), type: 'session_meta', payload: { id: X1, cwd: 'D:\\elsewhere' } },
        { timestamp: iso(NOW - 4000), type: 'event_msg', payload: { type: 'user_message', message: 'release the hounds' } },
        { timestamp: iso(NOW - 3000), type: 'event_msg', payload: { type: 'agent_message', message: 'The hounds are released.' } }
      ])
    )
    const s = service()
    expect(s.enable()).toEqual({ ok: true })
    drain(s)
    expect(s.status()).toMatchObject({ enabled: true, phase: 'current', filesIndexed: 3, filesDue: 0, sessions: 3 })

    const ids = (q) => s.search(q).hits.map((h) => h.sessionId)
    const phrase = s.search({ query: 'release notes' })
    expect(phrase.route).toBe('phrase')
    expect(phrase.hits[0]).toMatchObject({ agent: 'claude', sessionId: C2, title: 'Write the release notes', cwd: 'C:\\proj\\sub', messageCount: 2 })
    expect(phrase.hits[0].evidence.snippet).toContain('[[release notes]]')
    // All the words, not adjacent; then any of them.
    expect(s.search({ query: 'notes version' }).route).toBe('and')
    expect(ids({ query: 'hounds notes' }).sort()).toEqual([X1, C2].sort())
    // An identifier by one of its pieces; a path.
    expect(ids({ query: 'terminal' })).toEqual([C1])
    expect(ids({ query: 'src/main/paths.js' })).toEqual([C1])
    // Scopes: this folder, the project (the folder and below), everything.
    expect(ids({ query: 'release', scope: { kind: 'folder', path: 'c:/proj' } })).toEqual([])
    expect(ids({ query: 'release', scope: { kind: 'project', path: 'C:\\proj\\' } })).toEqual([C2])
    expect(ids({ query: 'release', scope: { kind: 'all' } }).sort()).toEqual([X1, C2].sort())
    expect(ids({ query: 'release', agents: ['codex'] })).toEqual([X1])
    // No query: the newest sessions of the scope.
    expect(s.search({ scope: { kind: 'project', path: 'C:\\proj' } }).hits.map((h) => h.sessionId).sort()).toEqual([C1, C2].sort())
    // Words FTS5 would choke on are just words.
    expect(s.search({ query: '"unbalanced AND (' }).ok).toBe(true)
  })

  it('reads only what was added since; a rewritten file is read again; a deleted one leaves the index', () => {
    const f = claude(C1, 'C:\\proj', [['first question', 'first answer']])
    const s = service({ scanEveryMs: 0 })
    s.enable()
    drain(s)
    const read = vi.spyOn(fs, 'readSync')
    fs.appendFileSync(f, lines([{ type: 'user', uuid: 'u9', timestamp: iso(NOW), message: { content: 'second question about zebras' } }]))
    fs.utimesSync(f, new Date(NOW), new Date(NOW))
    s.runOnce()
    drain(s)
    const bytes = read.mock.calls.reduce((n, c) => n + c[3], 0)
    read.mockRestore()
    expect(bytes).toBeLessThan(400)
    expect(s.search({ query: 'zebras' }).hits.map((h) => h.messageCount)).toEqual([3])
    // Rewritten shorter: its old rows go.
    fs.writeFileSync(f, lines([{ type: 'user', uuid: 'n', timestamp: iso(NOW), message: { content: 'only giraffes now' } }]))
    fs.utimesSync(f, new Date(NOW + 1000), new Date(NOW + 1000))
    s.runOnce()
    drain(s)
    expect(s.search({ query: 'zebras' }).hits).toEqual([])
    expect(s.search({ query: 'giraffes' }).hits).toHaveLength(1)
    fs.rmSync(f)
    s.runOnce()
    drain(s)
    expect(s.status().sessions).toBe(0)
  })

  it('paused while the window is hidden; turned off, it keeps the index; cleared, the index file goes (never the agent files)', () => {
    const f = claude(C1, 'C:\\proj', [['keep me', 'kept']])
    let paused = true
    const pending = []
    const s = service({ isPaused: () => paused, timers: { setTimeout: (fn) => (pending.push(fn), pending.length), clearTimeout: () => {} } })
    s.enable()
    pending.splice(0).forEach((fn) => fn())
    expect(s.status()).toMatchObject({ sessions: 0 })
    paused = false
    for (let i = 0; i < 50 && pending.length; i++) pending.splice(0).forEach((fn) => fn())
    expect(s.search({ query: 'keep' }).hits).toHaveLength(1)
    const db = join(dir, 'session-search', 'index.sqlite')
    expect(s.disable()).toEqual({ ok: true })
    expect(s.search({ query: 'keep' })).toEqual({ ok: false, code: 'disabled' })
    expect(fs.existsSync(db)).toBe(true)
    // The choice is remembered by the next start.
    s.close()
    search = createSessionSearchCore({ dir, home, now: () => NOW, timers: { setTimeout: () => null, clearTimeout: () => {} } })
    expect(search.status().enabled).toBe(false)
    search.enable()
    expect(search.search({ query: 'keep' }).hits).toHaveLength(1)
    search.disable()
    expect(search.clear()).toEqual({ ok: true })
    expect(fs.existsSync(db)).toBe(false)
    expect(fs.existsSync(f)).toBe(true)
  })

  it('a database it cannot use is built again', () => {
    fs.mkdirSync(join(dir, 'session-search'), { recursive: true })
    fs.writeFileSync(join(dir, 'session-search', 'index.sqlite'), 'this is not a database, not at all, just text'.repeat(200))
    claude(C1, 'C:\\proj', [['after the rebuild', 'ok']])
    const s = service()
    expect(s.enable()).toEqual({ ok: true })
    drain(s)
    expect(s.search({ query: 'rebuild' }).hits).toHaveLength(1)
  })

  it('tool output is indexed up to its cut; the store escapes LIKE wildcards in a folder', () => {
    const store = openStore(':memory:')
    store.noteFile({ path: 'f1', agent: 'claude', mtimeMs: 1, size: 1 })
    store.addSlice({ file: 'f1', agent: 'claude', rows: [{ role: 'tool', text: `${'pad '.repeat(1000)} beyondthecut`, ts: 1 }, { role: 'tool', text: 'withinthecut', ts: 2 }], offset: 1, done: true, session: { id: 's1', title: 't', cwd: 'C:\\100%_done\\x' } })
    expect(store.search({ query: 'withinthecut' }).hits).toHaveLength(1)
    expect(store.search({ query: 'beyondthecut' }).hits).toHaveLength(0)
    expect(store.search({ query: 'withinthecut', scope: { kind: 'project', path: 'C:\\100%_done' } }).hits).toHaveLength(1)
    expect(store.search({ query: 'withinthecut', scope: { kind: 'project', path: 'C:\\100X_done' } }).hits).toHaveLength(0)
    expect(store.search({ query: 'withinthecut' }).hits[0].messageCount).toBe(0)
    store.close()
  })
})

describe('session search from the main process (its own process does the work)', () => {
  // The utility process, in this one: the worker's own serve() on a fake port.
  function fakeFork() {
    const forks = []
    const fork = vi.fn((dataDir) => {
      const toChild = []
      const toParent = []
      const port = { on: (name, fn) => name === 'message' && toChild.push(fn), postMessage: (msg) => queueMicrotask(() => toParent.forEach((fn) => fn(msg))) }
      const core = serve(port, { dir: dataDir, home, createCore: (o) => createSessionSearchCore({ ...o, now: () => NOW, timers: { setTimeout: () => null, clearTimeout: () => {} } }) })
      const child = {
        core,
        paused: [],
        killed: false,
        exit: [],
        postMessage: (msg) => {
          if (typeof msg.paused === 'boolean') child.paused.push(msg.paused)
          toChild.forEach((fn) => fn({ data: msg }))
        },
        on: (name, fn) => (name === 'message' ? toParent.push(fn) : name === 'exit' ? child.exit.push(fn) : null),
        kill: () => {
          child.killed = true
          core.close()
        }
      }
      forks.push(child)
      return child
    })
    return { fork, forks }
  }
  const noTimers = { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} }

  it('off: no process is started, a status and a search are answered here', async () => {
    const { fork } = fakeFork()
    const s = createSessionSearch({ dir, fork, timers: noTimers })
    s.start()
    expect(await s.status()).toMatchObject({ available: true, enabled: false, phase: 'idle', historyDays: 90 })
    expect(await s.search({ query: 'x' })).toEqual({ ok: false, code: 'disabled' })
    expect(fork).not.toHaveBeenCalled()
    s.close()
  })

  it('on: its process starts, is told when the window hides, answers; turned off, it ends at once; turned on before, it starts with the app', async () => {
    claude(C1, 'C:\\proj', [['the api key is token=abcdef0123456789abcdef0123456789 here', 'noted']])
    const { fork, forks } = fakeFork()
    let hidden = false
    const s = createSessionSearch({ dir, fork, isPaused: () => hidden, timers: noTimers })
    expect(await s.enable()).toEqual({ ok: true })
    expect(fork).toHaveBeenCalledWith(dir)
    expect(forks[0].paused).toEqual([false])
    for (let i = 0; i < 200 && forks[0].core.runOnce(); i++);
    const res = await s.search({ query: 'api key' })
    expect(res.ok).toBe(true)
    // Masked before it leaves the main side: neither the passage nor the title carries the secret.
    expect(JSON.stringify(res.hits)).not.toContain('abcdef0123456789')
    expect(res.hits[0].evidence.snippet).toContain('[[')
    expect((await s.status()).enabled).toBe(true)
    expect(await s.disable()).toEqual({ ok: true })
    expect(forks[0].killed).toBe(true)
    expect(await s.search({ query: 'api' })).toEqual({ ok: false, code: 'disabled' })
    await s.enable()
    s.close()
    expect(forks[1].killed).toBe(true)
    // The next launch: on already, so its process starts with the app.
    const again = fakeFork()
    const next = createSessionSearch({ dir, fork: again.fork, timers: noTimers })
    expect(again.fork).not.toHaveBeenCalled()
    next.start()
    expect(again.fork).toHaveBeenCalledTimes(1)
    next.close()
  })

  it('a process that ended answers "closed" and starts again on the next request; its channels are registered', async () => {
    const { fork, forks } = fakeFork()
    const s = createSessionSearch({ dir, fork, timers: noTimers })
    await s.enable()
    forks[0].core.close() // the process is gone, its database handle with it
    forks[0].exit.forEach((fn) => fn())
    expect((await s.status()).enabled).toBe(true)
    expect(fork).toHaveBeenCalledTimes(2)
    const handlers = {}
    s.register({ handle: (name, fn) => (handlers[name] = fn) })
    expect(Object.keys(handlers).sort()).toEqual(['sessionSearch:clear', 'sessionSearch:disable', 'sessionSearch:enable', 'sessionSearch:search', 'sessionSearch:setHistoryDays', 'sessionSearch:status'])
    expect(await handlers['sessionSearch:setHistoryDays']({}, 7)).toEqual({ ok: false, code: 'invalid' })
    expect(await handlers['sessionSearch:setHistoryDays']({}, 30)).toEqual({ ok: true })
    expect(await handlers['sessionSearch:clear']({})).toEqual({ ok: true })
    s.close()
  })

  it('a passage keeps its marks and loses its secrets', () => {
    expect(maskSnippet('use [[Bearer]] abcdef0123456789abcdef0123456789abcd now')).toBe('use [[Bearer]] *** now')
  })
})
