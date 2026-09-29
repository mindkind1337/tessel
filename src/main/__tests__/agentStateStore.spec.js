// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import { join, resolve, sep } from 'path'
import { createAgentStateStore } from '../agentStateStore'

let temporary, dir, tick, sequence, stores
const paneId = 'pane-1'
const token = 'execution-token-0123456789'
const registered = (extra = {}) => ({
  paneId,
  provider: 'codex',
  launchToken: token,
  startedAt: tick - 1000,
  ...extra
})
beforeEach(() => {
  temporary = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agent-state-'))
  dir = join(temporary, 'status')
  tick = Date.now()
  sequence = 0
  stores = []
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores) await store.dispose()
  const target = resolve(temporary)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-agent-state-'))
    throw new Error('Unexpected cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
})
function make(options = {}) {
  const store = createAgentStateStore({ dir, now: () => tick, ...options })
  stores.push(store)
  return store
}
function event(name = 'UserPromptSubmit', extra = {}) {
  return {
    v: 1,
    id: `event-${++sequence}`,
    paneId,
    provider: 'codex',
    launchToken: token,
    sessionId: 'session-1',
    event: name,
    at: tick,
    source: 'hook',
    ...extra
  }
}
function put(value, name = undefined) {
  const file = join(dir, 'events', name || `file-${++sequence}.json`)
  fs.mkdirSync(join(dir, 'events'), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  fs.utimesSync(file, new Date(tick), new Date(tick))
  return file
}
const stateFile = () => join(dir, 'state.json')
const denied = () => Object.assign(new Error('fixture unavailable'), { code: 'EACCES' })

describe('local agent status spool and snapshots', () => {
  it('reduces real hook evidence, persists before deleting and publishes a public map', async () => {
    const changed = vi.fn()
    const store = make({ onChange: changed })
    expect(await store.register(registered())).toMatchObject({
      [paneId]: { state: 'unknown', confirmed: false, launchToken: token }
    })
    const file = put(event())
    const result = await store.scan()
    expect(result.stats).toMatchObject({ accepted: 1, removed: 1 })
    expect(result.states[paneId]).toMatchObject({
      state: 'working',
      confirmed: true,
      hookSeen: true
    })
    expect(fs.existsSync(file)).toBe(false)
    expect(JSON.parse(fs.readFileSync(stateFile())).states[0].state.seenIds).toContain('event-1')
    expect(changed).toHaveBeenLastCalledWith(result.states)
    result.states[paneId].state = 'idle'
    expect(store.snapshot()[paneId].state).toBe('working')
  })

  it('deduplicates event ids and ignores old timestamps despite later receipt', async () => {
    const store = make()
    await store.register(registered())
    const first = event()
    put(first)
    await store.scan()
    tick += 10
    put(event('Stop'))
    await store.scan()
    const settled = store.snapshot()[paneId]
    put(first)
    put(event('PermissionRequest', { at: tick - 20 }))
    const result = await store.scan()
    expect(result.stats.accepted).toBe(0)
    expect(result.states[paneId]).toEqual(settled)
  })

  it('retains unmatched events for late attachment, but removes a known old process token', async () => {
    const store = make()
    const waiting = put(event())
    expect((await store.scan()).stats.deferred).toBe(1)
    expect(fs.existsSync(waiting)).toBe(true)
    await store.register(registered())
    expect((await store.scan()).states[paneId].state).toBe('working')
    const stale = put(event('PermissionRequest', { launchToken: 'old-execution-token' }))
    expect((await store.scan()).stats.rejected).toBe(1)
    expect(fs.existsSync(stale)).toBe(false)
    expect(store.snapshot()[paneId].state).toBe('working')
  })

  it('restores timestamps but never treats persisted or replayed evidence as a live observation', async () => {
    const first = make()
    await first.register(registered())
    put(event())
    await first.scan()
    const since = first.snapshot()[paneId].since
    await first.dispose()
    tick += 10000
    const second = make()
    await second.register(registered())
    expect(second.snapshot()[paneId]).toMatchObject({ state: 'unknown', confirmed: false, since })
    put(event('Stop', { at: tick - 1000 }))
    await second.scan()
    expect(second.snapshot()[paneId]).toMatchObject({ state: 'unknown', confirmed: false })
    await second.observe(paneId, token, 'ScreenReady')
    expect(second.snapshot()[paneId]).toMatchObject({ state: 'idle', confirmed: true })
  })

  it('does not restore a different execution token or another provider', async () => {
    const first = make()
    await first.register(registered())
    put(event())
    await first.scan()
    await first.dispose()
    tick += 1000
    const second = make()
    await second.register(registered({ launchToken: 'new-token', provider: 'claude' }))
    expect(second.snapshot()[paneId]).toMatchObject({
      provider: 'claude',
      launchToken: 'new-token',
      state: 'unknown',
      sessionId: null,
      hookSeen: false
    })
  })

  it('does not let a fresh ready screen confirm a subsequently recovered historical hook', async () => {
    const first = make()
    await first.register(registered())
    put(event())
    await first.scan()
    tick += 10
    put(event('Stop'))
    await first.scan()
    const historicalAt = tick + 10
    await first.dispose()
    tick += 10000
    const second = make()
    await second.register(registered())
    await second.observe(paneId, token, 'ScreenReady')
    expect(second.snapshot()[paneId]).toMatchObject({ state: 'idle', confirmed: true })
    put(event('UserPromptSubmit', { at: historicalAt }))
    const result = await second.scan()
    expect(result.stats.accepted).toBe(1)
    expect(result.states[paneId]).toMatchObject({ state: 'unknown', confirmed: false })
    expect(JSON.parse(fs.readFileSync(stateFile())).states[0].state.state).toBe('working')
  })

  it('accepts a live hook delayed behind a newer screen observation', async () => {
    const store = make()
    await store.register(registered())
    const hookAt = tick + 10
    tick += 20
    await store.observe(paneId, token, 'ScreenReady')
    expect(store.snapshot()[paneId].state).toBe('idle')
    put(event('UserPromptSubmit', { at: hookAt }))
    expect((await store.scan()).states[paneId]).toMatchObject({
      state: 'working',
      confirmed: true,
      hookSeen: true
    })
  })

  it('keeps recovered child evidence unconfirmed across restarts and historical replays', async () => {
    const first = make()
    await first.register(registered())
    put(event())
    put(event('SubagentStart', { agentId: 'child-1' }))
    await first.scan()
    expect(first.snapshot()[paneId].children[0].confirmed).toBe(true)
    await first.dispose()
    tick += 10000
    const second = make()
    await second.register(registered())
    expect(second.snapshot()[paneId].children[0]).toMatchObject({
      state: 'unknown',
      confirmed: false
    })
    put(event('PreToolUse', { agentId: 'child-1', at: tick - 5000 }))
    await second.scan()
    expect(second.snapshot()[paneId].children[0]).toMatchObject({
      state: 'unknown',
      confirmed: false
    })
  })

  it('does not revoke unrelated fresh confirmation when replaying historical child evidence', async () => {
    const first = make()
    await first.register(registered())
    put(event())
    put(event('SubagentStart', { agentId: 'child-1' }))
    await first.scan()
    const historicalAt = tick + 10
    await first.dispose()
    tick += 10000
    const second = make()
    await second.register(registered())
    await second.observe(paneId, token, 'ScreenApproval')
    put(event('SubagentStart', { agentId: 'child-2' }))
    await second.scan()
    tick += 1
    put(event('PreToolUse', { agentId: 'child-2' }))
    await second.scan()
    put(event('PreToolUse', { agentId: 'child-1', at: historicalAt }))
    const result = await second.scan()
    expect(result.states[paneId]).toMatchObject({ state: 'approval', confirmed: true })
    expect(
      result.states[paneId].children.find((child) => child.agentId === 'child-1')
    ).toMatchObject({ state: 'unknown', confirmed: false })
    expect(
      result.states[paneId].children.find((child) => child.agentId === 'child-2')
    ).toMatchObject({ state: 'working', confirmed: true })
  })

  it('constructs whitelisted screen observations and cannot forge a hook or other session', async () => {
    const store = make()
    await store.register(registered())
    await store.observe(paneId, 'wrong-token', 'ScreenApproval')
    expect(store.snapshot()[paneId].state).toBe('unknown')
    await store.observe(paneId, token, { event: 'UserPromptSubmit', source: 'hook' })
    expect(store.snapshot()[paneId].hookSeen).toBe(false)
    await store.observe(paneId, token, {
      event: 'ScreenApproval',
      source: 'hook',
      at: 0,
      sessionId: 'foreign',
      id: 'forged',
      agentId: 'child',
      prompt: 'SECRET'
    })
    expect(store.snapshot()[paneId]).toMatchObject({
      state: 'approval',
      source: 'screen',
      sessionId: null,
      hookSeen: false
    })
    expect(fs.readFileSync(stateFile(), 'utf8')).not.toContain('SECRET')
    expect(fs.readFileSync(stateFile(), 'utf8')).not.toContain('forged')
  })

  it('accepts question tool names but rejects content and forged screen sources from the spool', async () => {
    const store = make()
    await store.register(registered())
    const secret = put(event('PreToolUse', { toolName: 'request_user_input', prompt: 'SECRET' }))
    const forged = put(event('ScreenApproval', { source: 'screen' }))
    const accepted = put(event('PreToolUse', { toolName: 'request_user_input' }))
    const result = await store.scan()
    expect(result.stats.rejected).toBe(2)
    expect(result.stats.accepted).toBe(1)
    expect(result.states[paneId].state).toBe('approval')
    expect([secret, forged, accepted].some(fs.existsSync)).toBe(false)
    expect(fs.readFileSync(stateFile(), 'utf8')).not.toContain('SECRET')
  })

  it('isolates malformed, oversized, future and invalid-id files from other events', async () => {
    const store = make()
    await store.register(registered())
    put('{bad')
    put('x'.repeat(8193))
    put(event('Stop', { id: '../escape' }))
    put(event('Stop', { at: tick + 10000 }))
    put(event())
    const result = await store.scan()
    expect(result.stats).toMatchObject({ accepted: 1, rejected: 4, removed: 5 })
    expect(result.states[paneId].state).toBe('working')
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('retains source events after snapshot failure and retries without duplicating transitions', async () => {
    const store = make()
    await store.register(registered())
    const file = put(event())
    const rename = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(denied())
    const failed = await store.scan()
    expect(failed.states[paneId].state).toBe('working')
    expect(fs.existsSync(file)).toBe(true)
    expect(failed.warnings.join(' ')).toContain('could not be saved')
    rename.mockRestore()
    const retried = await store.scan()
    expect(retried.stats).toMatchObject({ accepted: 0, removed: 1 })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('preserves locked snapshot bytes and events until a successful recovery read', async () => {
    const first = make()
    await first.register(registered())
    put(event())
    await first.scan()
    await first.dispose()
    const saved = fs.readFileSync(stateFile(), 'utf8')
    tick += 10000
    const original = fsp.open.bind(fsp)
    const open = vi.spyOn(fsp, 'open').mockImplementation((file, ...args) => {
      if (String(file) === stateFile()) return Promise.reject(denied())
      return original(file, ...args)
    })
    const second = make()
    await second.register(registered())
    const pending = put(event())
    await second.scan()
    expect(fs.readFileSync(stateFile(), 'utf8')).toBe(saved)
    expect(fs.existsSync(pending)).toBe(true)
    open.mockRestore()
    await second.scan()
    expect(fs.existsSync(pending)).toBe(false)
    expect(second.snapshot()[paneId].state).toBe('working')
  })

  it('does not let one unreadable event hide another and retries it next cycle', async () => {
    const store = make()
    await store.register(registered())
    const file = put(event())
    put(event('UserPromptSubmit', { id: 'second' }))
    const original = fsp.open.bind(fsp)
    const open = vi.spyOn(fsp, 'open').mockImplementation((path, ...args) => {
      if (String(path) === file) return Promise.reject(denied())
      return original(path, ...args)
    })
    expect((await store.scan()).states[paneId].state).toBe('working')
    expect(fs.existsSync(file)).toBe(true)
    open.mockRestore()
    await store.scan()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('bounds work per scan without starving events beyond unregistered entries', async () => {
    const store = make()
    await store.register(registered())
    for (let i = 0; i < 160; i++)
      put(
        event('UserPromptSubmit', { paneId: `future-${i}` }),
        `a-${String(i).padStart(3, '0')}.json`
      )
    put(event(), 'z-live.json')
    const first = await store.scan()
    expect(first.stats.examined).toBe(128)
    const second = await store.scan()
    expect(second.stats.examined).toBe(33)
    expect(second.states[paneId].state).toBe('working')
  })

  it('cleans expired unmatched events without recursive deletion', async () => {
    const store = make()
    const file = put(event())
    const unfinished = put('partial', 'stale-write.tmp')
    tick += 25 * 60 * 60 * 1000
    const liveWrite = put('partial', 'current-write.tmp')
    expect((await store.scan()).stats.removed).toBe(2)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(unfinished)).toBe(false)
    expect(fs.existsSync(liveWrite)).toBe(true)
  })

  it('skips directory junctions and refuses a linked events directory', async () => {
    const outside = join(temporary, 'outside')
    fs.mkdirSync(outside)
    const secret = join(outside, 'event.json')
    fs.writeFileSync(secret, JSON.stringify(event()))
    fs.mkdirSync(dir)
    fs.symlinkSync(outside, join(dir, 'events'), process.platform === 'win32' ? 'junction' : 'dir')
    const store = make()
    await store.register(registered())
    expect((await store.scan()).stats.accepted).toBe(0)
    expect(fs.existsSync(secret)).toBe(true)
    fs.unlinkSync(join(dir, 'events'))
  })

  it('ignores corrupt/private persisted states and only resumes from live evidence', async () => {
    fs.mkdirSync(dir)
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ v: 1, states: [{ state: { prompt: 'SECRET' }, savedAt: tick }] })
    )
    const store = make()
    await store.register(registered())
    expect(store.snapshot()[paneId].state).toBe('unknown')
    expect(store.warnings().join(' ')).toContain('Invalid')
    expect(fs.readFileSync(stateFile(), 'utf8')).not.toContain('SECRET')
    put(event())
    expect((await store.scan()).states[paneId].state).toBe('working')
  })

  it('coalesces scans, publishes a close before dropping and ignores a stale exit token', async () => {
    const changes = []
    const store = make({ onChange: (snapshot) => changes.push(snapshot) })
    await store.register(registered())
    put(event())
    const first = store.scan()
    expect(store.scan()).toBe(first)
    await first
    await store.unregister(paneId, 'old-token')
    expect(store.snapshot()[paneId].state).toBe('working')
    await store.unregister(paneId, token)
    expect(changes.at(-2)[paneId].state).toBe('closed')
    expect(changes.at(-1)).toEqual({})
    expect(JSON.parse(fs.readFileSync(stateFile())).states).toEqual([])
    await store.dispose()
    await expect(store.scan()).rejects.toThrow(/disposed/)
  })

  it('retains another recovered pane until its later reattachment', async () => {
    const first = make()
    await first.register(registered())
    await first.register(registered({ paneId: 'pane-2' }))
    put(event())
    put(event('UserPromptSubmit', { paneId: 'pane-2' }))
    await first.scan()
    await first.dispose()
    tick += 1000
    const second = make()
    await second.register(registered())
    const persisted = JSON.parse(fs.readFileSync(stateFile()))
    expect(persisted.states.map((entry) => entry.state.paneId).sort()).toEqual(['pane-1', 'pane-2'])
    await second.register(registered({ paneId: 'pane-2' }))
    expect(second.snapshot()['pane-2']).toMatchObject({
      state: 'unknown',
      confirmed: false,
      hookSeen: true
    })
  })

  it('finishes previously queued work and refuses new observations while disposing', async () => {
    const store = make()
    const registration = store.register(registered())
    const closing = store.dispose()
    await expect(store.observe(paneId, token, 'ScreenReady')).rejects.toThrow(/disposed/)
    await registration
    await closing
    expect(JSON.parse(fs.readFileSync(stateFile())).states[0].state.paneId).toBe(paneId)
  })
})

describe('chat pane events (recordChatEvent)', () => {
  const chat = (extra = {}) => registered({ provider: 'claude', ...extra })
  const session = { sessionId: 'chat-session-1' }

  it('a submitted prompt shows the pane working, from hook evidence', async () => {
    const store = make()
    await store.register(chat())
    const states = await store.recordChatEvent(paneId, token, 'UserPromptSubmit', session)
    expect(states[paneId]).toMatchObject({
      state: 'working',
      confirmed: true,
      hookSeen: true,
      sessionId: 'chat-session-1',
      provider: 'claude'
    })
  })

  it('a permission request and its prompt show approval, its answer leaves it', async () => {
    const store = make()
    await store.register(chat())
    await store.recordChatEvent(paneId, token, 'UserPromptSubmit', session)
    await store.recordChatEvent(paneId, token, 'PermissionRequest', { ...session, toolId: 'toolu_1' })
    const states = await store.recordChatEvent(paneId, token, 'Notification', {
      ...session,
      toolId: 'toolu_1',
      notificationType: 'permission_prompt'
    })
    expect(states[paneId]).toMatchObject({ state: 'approval', reason: 'permission' })
    const after = await store.recordChatEvent(paneId, token, 'PostToolUse', { ...session, toolId: 'toolu_1' })
    expect(after[paneId]).toMatchObject({ state: 'working' })
  })

  it('Stop then a ready observation is idle at once (no settling wait)', async () => {
    const store = make()
    await store.register(chat())
    await store.recordChatEvent(paneId, token, 'UserPromptSubmit', session)
    await store.recordChatEvent(paneId, token, 'Stop', session)
    const states = await store.observe(paneId, token, 'ScreenReady')
    expect(states[paneId]).toMatchObject({ state: 'idle', reason: 'ready' })
    expect(states[paneId].turnCompletedAt).toBe(tick)
  })

  it('refuses a wrong launch, an unknown pane, an event outside the list and a bad id', async () => {
    const store = make()
    await store.register(chat())
    await store.recordChatEvent(paneId, 'other-token-000000', 'UserPromptSubmit', session)
    await store.recordChatEvent('pane-9', token, 'UserPromptSubmit', session)
    await store.recordChatEvent(paneId, token, 'SessionEnd', session)
    await store.recordChatEvent(paneId, token, 'UserPromptSubmit', { sessionId: '../x' })
    await store.recordChatEvent(paneId, token, 'UserPromptSubmit', { sessionId: 'a b' })
    expect(store.snapshot()[paneId]).toMatchObject({ state: 'unknown', hookSeen: false })
    expect(store.snapshot()['pane-9']).toBeUndefined()
  })

  it('keeps the session it started with', async () => {
    const store = make()
    await store.register(chat())
    await store.recordChatEvent(paneId, token, 'UserPromptSubmit', session)
    await store.recordChatEvent(paneId, token, 'Stop', { sessionId: 'another-session' })
    expect(store.snapshot()[paneId]).toMatchObject({ state: 'working', sessionId: 'chat-session-1' })
    await store.recordChatEvent(paneId, token, 'Interrupt')
    expect(store.snapshot()[paneId]).toMatchObject({ state: 'unknown', reason: 'interrupted' })
  })
})

describe('a finished turn with no later event', () => {
  it('publishes idle once the Stop has settled, on a scan with nothing new', async () => {
    const changed = vi.fn()
    const store = make({ onChange: changed })
    await store.register(registered({ provider: 'claude' }))
    put(event('UserPromptSubmit', { provider: 'claude' }))
    await store.scan()
    tick += 1000
    put(event('Stop', { provider: 'claude', at: tick }))
    await store.scan()
    expect(changed.mock.lastCall[0][paneId]).toMatchObject({ state: 'working', reason: 'settling' })
    const stopAt = tick
    tick += 21000
    await store.scan()
    expect(changed.mock.lastCall[0][paneId]).toMatchObject({ state: 'idle', reason: 'ready', since: stopAt })
    // Nothing changes after: no repeated publish.
    const calls = changed.mock.calls.length
    tick += 25 * 60 * 1000
    await store.scan()
    expect(changed.mock.calls.length).toBe(calls)
    expect(store.snapshot()[paneId]).toMatchObject({ state: 'idle' })
  })
  it('accepts the screen interruption observation', async () => {
    const store = make()
    await store.register(registered({ provider: 'claude' }))
    put(event('UserPromptSubmit', { provider: 'claude' }))
    await store.scan()
    tick += 1000
    await store.observe(paneId, token, 'ScreenInterrupted')
    expect(store.snapshot()[paneId]).toMatchObject({ state: 'idle', reason: 'interrupted' })
  })
})
