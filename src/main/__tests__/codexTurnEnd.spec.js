// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { createAgentStateStore } from '../agentStateStore'
import {
  allowedCodexHome,
  createCodexTurnEnd,
  createRolloutReader,
  lastTurnEvent
} from '../codexTurnEnd'
import { createAgentState, reduceAgentState, publicAgentState } from '../../shared/agentStateModel'

// A UUID v7 session id born 2026-09-24 (rollout day folder 2026/09/24).
const SID = '01a0d4f5-24e7-7951-865b-6a8e3cc8853f'
const OTHER = '01a0d4f5-24e7-7951-865b-6a8e3cc8aaaa'
const TURN = '01a0ec4f-1b03-7751-89f7-49472aa960c6'
const paneId = 'pane-6'
const token = 'execution-token-0123456789'

let temporary, home, dir, tick, stores, seq
beforeEach(() => {
  temporary = fs.mkdtempSync(join(os.tmpdir(), 'tessel-turnend-'))
  home = join(temporary, 'codex')
  dir = join(temporary, 'status')
  tick = Date.parse('2026-09-29T09:00:00Z')
  stores = []
  seq = 0
})
afterEach(async () => {
  for (const store of stores) await store.dispose()
  const target = resolve(temporary)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-turnend-'))
    throw new Error('Unexpected cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
})

const iso = (ms) => new Date(ms).toISOString()
const line = (type, payload, at) => JSON.stringify({ timestamp: iso(at), type, payload })
const started = (at, turn = TURN) => line('event_msg', { type: 'task_started', turn_id: turn }, at)
const complete = (at, extra = {}, turn = TURN) =>
  line('event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: 'done', ...extra }, at)
const aborted = (at, turn = TURN) => line('event_msg', { type: 'turn_aborted', turn_id: turn, reason: 'interrupted' }, at)
const tokens = (at) => line('event_msg', { type: 'token_count', info: null }, at)

function rollout(lines, { sid = SID, root = home, day = '2026/09/24' } = {}) {
  const d = join(root, 'sessions', ...day.split('/'))
  fs.mkdirSync(d, { recursive: true })
  const file = join(d, `rollout-2026-09-24T15-47-10-${sid}.jsonl`)
  const head = JSON.stringify({ timestamp: iso(tick - 5 * 86400000), type: 'session_meta', payload: { id: sid } })
  fs.writeFileSync(file, [head, ...lines].join('\n') + '\n')
  return file
}

function make() {
  const store = createAgentStateStore({ dir, now: () => tick })
  stores.push(store)
  return store
}
function hook(name, at, extra = {}) {
  return {
    v: 1,
    id: `event-${++seq}`,
    paneId,
    provider: 'codex',
    launchToken: token,
    sessionId: SID,
    event: name,
    at,
    source: 'hook',
    ...extra
  }
}
function put(value) {
  fs.mkdirSync(join(dir, 'events'), { recursive: true })
  fs.writeFileSync(join(dir, 'events', `e-${++seq}.json`), JSON.stringify(value))
}
// A pane working on TURN since `promptAt` (its last hook).
async function working(promptAt) {
  const now = tick
  tick = promptAt - 60000 // the store runs since before those hooks (live evidence)
  const store = make()
  await store.register({ paneId, provider: 'codex', launchToken: token, startedAt: promptAt - 60000 })
  tick = promptAt + 1
  put(hook('SessionStart', promptAt - 30000, { startSource: 'startup' }))
  put(hook('UserPromptSubmit', promptAt, { turnId: TURN }))
  const { states } = await store.scan()
  tick = now
  expect(states[paneId]).toMatchObject({ state: 'working', reason: 'processing' })
  return store
}
const check = (store, homeFor = () => home) => createCodexTurnEnd({ store, homeFor, reader: createRolloutReader({ now: () => tick }) })()

describe('lastTurnEvent', () => {
  it('reads the last turn event only', () => {
    const t = tick - 1000
    expect(lastTurnEvent([started(t - 10), complete(t), tokens(t + 5)])).toEqual({ kind: 'complete', at: t, turnId: TURN })
    expect(lastTurnEvent([started(t - 10), complete(t, { error: { message: 'flagged' } })]).kind).toBe('error')
    expect(lastTurnEvent([started(t - 10), aborted(t)]).kind).toBe('aborted')
    expect(lastTurnEvent([complete(t - 10), started(t)]).kind).toBe('started')
    expect(lastTurnEvent([tokens(t), '{"broken'])).toBeNull()
  })
})

describe('allowedCodexHome', () => {
  it('accepts the system home and managed account homes only', () => {
    const systemHome = join(temporary, '.codex')
    const accountsBase = join(temporary, 'userData', 'codex-accounts')
    expect(allowedCodexHome(systemHome, { systemHome, accountsBase })).toBe(true)
    expect(allowedCodexHome(join(accountsBase, 'acc-1'), { systemHome, accountsBase })).toBe(true)
    expect(allowedCodexHome(accountsBase, { systemHome, accountsBase })).toBe(false)
    expect(allowedCodexHome(join(temporary, 'elsewhere'), { systemHome, accountsBase })).toBe(false)
    expect(allowedCodexHome('relative/.codex', { systemHome, accountsBase })).toBe(false)
  })
})

describe('Codex turn end from its rollout', () => {
  it('ends a turn whose Stop hook never ran (task_complete)', async () => {
    const prompt = tick - 20 * 60000
    const store = await working(prompt)
    rollout([started(prompt - 300), tokens(prompt + 1000), complete(prompt + 18000), tokens(prompt + 18010)])
    expect(await check(store)).toBe(1)
    const state = store.snapshot()[paneId]
    expect(state).toMatchObject({ state: 'idle', reason: 'ready', source: 'rollout', turnCompletedAt: prompt + 18000 })
  })

  it('shows an errored turn like StopFailure and an aborted one like Interrupt', async () => {
    const prompt = tick - 5 * 60000
    let store = await working(prompt)
    rollout([started(prompt), complete(prompt + 18000, { error: { message: 'flagged' } })])
    await check(store)
    expect(store.snapshot()[paneId]).toMatchObject({ state: 'unknown', reason: 'error' })
    await store.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
    store = await working(prompt)
    rollout([started(prompt), aborted(prompt + 9000)])
    await check(store)
    expect(store.snapshot()[paneId]).toMatchObject({ state: 'unknown', reason: 'interrupted' })
  })

  it('does nothing mid-turn, before 60 s without a hook, or for another session', async () => {
    const prompt = tick - 5 * 60000
    const store = await working(prompt)
    rollout([complete(prompt - 60000, {}, 'older-turn'), started(prompt, TURN), tokens(prompt + 500)])
    expect(await check(store)).toBe(0)
    rollout([started(prompt), complete(prompt + 1000)], { sid: OTHER })
    expect(await check(store)).toBe(0)
    expect(store.snapshot()[paneId].state).toBe('working')

    const quiet = await (async () => {
      await store.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
      return working(tick - 30000)
    })()
    rollout([started(tick - 30000), complete(tick - 20000)])
    expect(await check(quiet)).toBe(0)
    expect(quiet.snapshot()[paneId].state).toBe('working')
  })

  it('never uses a turn end older than the last hook, and a later hook overrides', async () => {
    const prompt = tick - 5 * 60000
    const store = await working(prompt)
    rollout([started(prompt - 20000), complete(prompt - 1000)])
    expect(await check(store)).toBe(0)
    expect(store.snapshot()[paneId].state).toBe('working')

    rollout([started(prompt), complete(prompt + 18000)])
    expect(await check(store)).toBe(1)
    expect(store.snapshot()[paneId].state).toBe('idle')
    // A hook written before that turn end, delivered late, is ignored.
    put(hook('PostToolUse', prompt + 5000, { turnId: TURN }))
    expect((await store.scan()).states[paneId].state).toBe('idle')
    // A new prompt afterwards is work again.
    tick += 1000
    put(hook('UserPromptSubmit', tick - 10, { turnId: 'next-turn' }))
    expect((await store.scan()).states[paneId]).toMatchObject({ state: 'working', source: 'hook' })
  })

  it('ignores a turn end of another turn than the one the hooks started', async () => {
    const prompt = tick - 5 * 60000
    const store = await working(prompt)
    rollout([started(prompt, 'other-turn'), complete(prompt + 18000, {}, 'other-turn')])
    expect(await check(store)).toBe(0)
    expect(store.snapshot()[paneId].state).toBe('working')
  })

  it('reads the per-account CODEX_HOME the pane was given, not another home', async () => {
    const prompt = tick - 5 * 60000
    const account = join(temporary, 'userData', 'codex-accounts', 'acc-1')
    const store = await working(prompt)
    rollout([started(prompt), complete(prompt + 18000)], { root: account })
    // The system home has no rollout for that session.
    expect(await check(store, () => home)).toBe(0)
    expect(await check(store, () => null)).toBe(0)
    expect(await check(store, () => account)).toBe(1)
    expect(store.snapshot()[paneId].state).toBe('idle')
  })

  it('reads only a bounded tail and caches by size and mtime', () => {
    const t = tick - 60000
    const filler = line('response_item', { type: 'reasoning', text: 'x'.repeat(4000) }, t - 5000)
    // A turn end far from the end (beyond the 256 KB tail) is not seen.
    const file = rollout([started(t - 9000), complete(t - 8000), ...Array(100).fill(filler)])
    expect(fs.statSync(file).size).toBeGreaterThan(256 * 1024)
    const reader = createRolloutReader({ now: () => tick })
    expect(reader.read(home, SID)).toBeNull()
    fs.appendFileSync(file, started(t - 100) + '\n' + complete(t) + '\n')
    expect(reader.read(home, SID)).toEqual({ kind: 'complete', at: t, turnId: TURN })
    expect(reader.read(home, 'not-a-uuid')).toBeNull()
    expect(reader.read('relative', SID)).toBeNull()
  })

  it('refuses a sessions folder that is a link out of CODEX_HOME', () => {
    const outside = join(temporary, 'outside')
    rollout([started(tick - 9000), complete(tick - 8000)], { root: outside })
    const linked = join(temporary, 'linked')
    fs.mkdirSync(linked)
    try {
      fs.symlinkSync(join(outside, 'sessions'), join(linked, 'sessions'), 'junction')
    } catch {
      return // links unavailable here
    }
    expect(createRolloutReader({ now: () => tick }).read(linked, SID)).toBeNull()
  })
})

describe('reducer: RolloutTurnEnd', () => {
  const base = () => {
    let s = createAgentState({ paneId, provider: 'codex', launchToken: token, startedAt: 1000 })
    s = reduceAgentState(s, hook('UserPromptSubmit', 2000, { turnId: TURN }), 10000)
    return s
  }
  const end = (extra = {}) => ({
    v: 1,
    id: `r-${++seq}`,
    paneId,
    provider: 'codex',
    launchToken: token,
    sessionId: SID,
    event: 'RolloutTurnEnd',
    source: 'rollout',
    at: 3000,
    ended: 'complete',
    turnId: TURN,
    ...extra
  })
  it('accepts only the current session, newer events and a working state', () => {
    const s = base()
    expect(reduceAgentState(s, end({ sessionId: OTHER }), 10000)).toBe(s)
    expect(reduceAgentState(s, end({ at: 2000 }), 10000)).toBe(s)
    expect(reduceAgentState(s, end({ ended: 'maybe' }), 10000)).toBe(s)
    expect(reduceAgentState(s, end({ agentId: 'child' }), 10000)).toBe(s)
    expect(reduceAgentState(s, end({ launchToken: 'other-token-0123456789' }), 10000)).toBe(s)
    const done = reduceAgentState(s, end(), 10000)
    expect(publicAgentState(done, 10000)).toMatchObject({ state: 'idle', reason: 'ready', turnCompletedAt: 3000 })
    expect(reduceAgentState(done, end({ at: 4000 }), 10000)).toBe(done)
  })
})
