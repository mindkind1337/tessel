// App.vue's message queue (flushPending) when a delivery is not confirmed:
// Claude Code 2.1.286 answering in 1-2 s left the pane "not confirmed" and
// every later message (chat view, team) silently held until the user
// answered a dialog. Runs App.vue's own functions, as
// notesDeliveryPaste.spec.js does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

describe("App.vue's queue after an unconfirmed delivery", () => {
  let ctx, pasted, results, took, leaf, panes
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1000000)
    pasted = []
    results = []
    took = false
    leaf = { id: 'a1', title: 'Claude', agentLaunchToken: 'L1' }
    panes = { a1: {} }
    ctx = {
      pendingMessages: {},
      unsent: {},
      delivering: new Set(),
      agentStatus: {},
      teamPointer: { inFlight: () => false },
      getPane: (id) => panes[id],
      findLeaf: (id) => (id === 'a1' ? leaf : null),
      awaitingApproval: () => false,
      userIsTyping: () => false,
      unsafeMultilinePaste: () => false,
      agentTookMessage: vi.fn(() => took),
      pasteAndConfirm: vi.fn(async (id, text, deps) => {
        pasted.push(text)
        ctx.lastDeps = deps
        deps.submitted({ at: Date.now(), wasBusy: false })
        return results.shift() || 'confirmed'
      }),
      logMessage: vi.fn(),
      showToast: vi.fn(),
      t: (key, text, vars) => String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars || {})[k]),
      resolveUnsent: vi.fn(),
      pendingTimer: null,
      setTimeout,
      clearTimeout,
      Promise,
      Date,
      Object
    }
    vm.runInNewContext(
      slice('function deliverToAgent(leafId, text, meta = {}) {', '\n// A pane joined (teamId)') +
        slice('function flushPending() {', '\n// --- Tasks'),
      ctx
    )
  })
  afterEach(() => vi.useRealTimers())
  const settle = () => vi.advanceTimersByTimeAsync(0)

  it('asks the hooks about the message, by pane and launch, from its Enter', async () => {
    ctx.deliverToAgent('a1', 'hello', {})
    await settle()
    ctx.lastDeps.taken('a1', 1234)
    expect(ctx.agentTookMessage).toHaveBeenCalledWith('a1', 'L1', 1234)
  })

  it('hooks that tell later the message was taken: sent after all, and the held ones go on', async () => {
    const delivered = vi.fn()
    results.push('unconfirmed')
    ctx.deliverToAgent('a1', 'fast question', { source: 'you', onDelivered: delivered })
    await settle()
    expect(ctx.unsent.a1).toBeTruthy()
    // A later message from the chat view: held, and said so.
    ctx.deliverToAgent('a1', 'next one', { source: 'you' })
    await settle()
    expect(pasted).toEqual(['fast question'])
    expect(ctx.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Waiting to send to Claude'),
      expect.objectContaining({ action: expect.any(Object) })
    )
    took = true
    await vi.advanceTimersByTimeAsync(1000)
    await settle()
    expect(ctx.unsent.a1).toBeUndefined()
    expect(delivered).toHaveBeenCalledTimes(1)
    expect(pasted).toEqual(['fast question', 'next one'])
  })

  it('no evidence at all: the pane stays held, nothing pasted twice, nothing dropped', async () => {
    const failed = vi.fn()
    results.push('unconfirmed')
    ctx.deliverToAgent('a1', 'first', { onFailed: failed })
    await settle()
    ctx.deliverToAgent('a1', 'second', { onFailed: failed })
    await vi.advanceTimersByTimeAsync(10000)
    expect(pasted).toEqual(['first'])
    expect(ctx.pendingMessages.a1.map((i) => i.text)).toEqual(['second'])
    expect(failed).not.toHaveBeenCalled()
  })

  it('a terminal remounting for a moment: its messages wait for it, not dropped', async () => {
    const failed = vi.fn()
    delete panes.a1
    ctx.deliverToAgent('a1', 'from the chat view', { onFailed: failed })
    await vi.advanceTimersByTimeAsync(4000)
    expect(failed).not.toHaveBeenCalled()
    panes.a1 = {}
    await vi.advanceTimersByTimeAsync(2000)
    expect(pasted).toEqual(['from the chat view'])
    // Gone for good: failed (told) after a while.
    delete panes.a1
    ctx.deliverToAgent('a1', 'later', { onFailed: failed })
    await vi.advanceTimersByTimeAsync(32000)
    expect(failed).toHaveBeenCalledTimes(1)
  })
})

// A terminal agent's chat view: its messages wait for the end of the turn as
// cards whose controls (heldDelivery) edit, delete or send them now; a
// deleted one is never typed, even caught between the queue and the paste.
describe("App.vue's held chat-view messages (sendFromChatView, heldDelivery)", () => {
  let ctx, pasted, gate
  beforeEach(() => {
    vi.useFakeTimers()
    pasted = []
    gate = null
    ctx = {
      pendingMessages: {},
      unsent: {},
      delivering: new Set(),
      agentStatus: { a1: 'busy' },
      teamPointer: { inFlight: () => false },
      getPane: () => ({}),
      findLeaf: (id) => (id === 'a1' ? { id: 'a1', kind: 'agent', chatView: true, title: 'Claude' } : null),
      isPastedImageCopy: () => true,
      awaitingApproval: () => false,
      userIsTyping: () => false,
      unsafeMultilinePaste: () => false,
      agentTookMessage: () => false,
      // As deliver.js: waits for a quiet agent, then the guard, then the paste.
      pasteAndConfirm: vi.fn(async (id, text, deps) => {
        if (gate) await gate
        if (deps.waitIdle && ctx.agentStatus[id] === 'busy') return 'requeue'
        if (deps.guard && !deps.guard(id)) return 'requeue'
        pasted.push(text)
        return 'confirmed'
      }),
      logMessage: vi.fn(),
      showToast: vi.fn(),
      t: (key, text) => text,
      resolveUnsent: vi.fn(),
      pendingTimer: null,
      setTimeout,
      clearTimeout,
      Promise,
      Date,
      Object
    }
    vm.runInNewContext(
      slice('function deliverToAgent(leafId, text, meta = {}) {', '\n// A pane joined (teamId)') +
        slice('function flushPending() {', '\n// --- Tasks') +
        slice('function sendFromChatView(', '\n// Its agent really ended'),
      ctx
    )
  })
  afterEach(() => vi.useRealTimers())
  const settle = () => vi.advanceTimersByTimeAsync(0)
  function sendHeld(text) {
    const cb = { onQueued: vi.fn(), onTyped: vi.fn(), onFailed: vi.fn(), onDelivered: vi.fn() }
    expect(ctx.sendFromChatView('a1', text, cb)).toBe(true)
    return { cb, controls: cb.onQueued.mock.calls[0][0] }
  }

  it('waits while the agent works; edited, it goes out with the new words once it is idle', async () => {
    const { cb, controls } = sendHeld('draft')
    await vi.advanceTimersByTimeAsync(4000)
    expect(pasted).toEqual([])
    expect(controls.edit('final words')).toEqual({ ok: true })
    ctx.agentStatus.a1 = 'idle'
    await vi.advanceTimersByTimeAsync(2000)
    expect(pasted).toEqual(['final words'])
    expect(cb.onTyped).toHaveBeenCalledTimes(1)
    expect(cb.onDelivered).toHaveBeenCalledTimes(1)
    // Typed: nothing to change any more.
    expect(controls.remove()).toEqual({ ok: false, code: 'gone' })
    expect(controls.edit('late')).toEqual({ ok: false, code: 'gone' })
  })

  it('deleted while waiting: never typed; the others still go, in order', async () => {
    const a = sendHeld('one')
    const b = sendHeld('two')
    sendHeld('three')
    expect(b.controls.remove()).toEqual({ ok: true })
    ctx.agentStatus.a1 = 'idle'
    await vi.advanceTimersByTimeAsync(10000)
    expect(pasted).toEqual(['one', 'three'])
    expect(a.cb.onTyped).toHaveBeenCalled()
    expect(b.cb.onTyped).not.toHaveBeenCalled()
  })

  it('Send now: typed at once, ahead of the others, without waiting for the turn', async () => {
    sendHeld('first')
    const second = sendHeld('second')
    expect(second.controls.sendNow()).toEqual({ ok: true })
    await settle()
    expect(pasted).toEqual(['second'])
  })

  it('deleted between the queue and the paste: its guard refuses it, it is dropped, never typed', async () => {
    let open
    gate = new Promise((r) => (open = r))
    ctx.agentStatus.a1 = 'idle'
    const { cb, controls } = sendHeld('in flight')
    await settle()
    expect(ctx.pendingMessages.a1).toBeUndefined()
    expect(controls.remove()).toEqual({ ok: true })
    open()
    await vi.advanceTimersByTimeAsync(6000)
    expect(pasted).toEqual([])
    expect(cb.onTyped).not.toHaveBeenCalled()
    expect(cb.onFailed).toHaveBeenCalledTimes(1)
    expect(ctx.pendingMessages.a1).toBeUndefined()
  })

  it('a slash command is not held: no card, typed at once', async () => {
    const onQueued = vi.fn()
    ctx.sendFromChatView('a1', '/compact', { command: 'paste', onQueued })
    await settle()
    expect(onQueued).not.toHaveBeenCalled()
    expect(pasted).toEqual(['/compact'])
  })
})
