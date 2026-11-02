// The agents' approval cards share one place on screen (App.vue
// askAgentApproval): a pause between two cards, the terminal tools' cards
// before an account switch's, and a terminal card's time not spent behind
// an account card. Run on App.vue's own code, as cliRequestHotReload.spec.js does.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { ref, shallowRef } from 'vue'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8').replace(/\r\n/g, '\n')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}
const CODE = slice('const AGENT_APPROVAL_MS', '// An "Allow ..." rule needs auto approve on')

const toasts = []
function load(extra) {
  const ctx = {
    // Vue's own refs: a fake one hid that a deep ref hands back a proxy.
    ref,
    shallowRef,
    confirmState: { value: null },
    userWritingNow: () => !!(extra && extra.writing && extra.writing()),
    showToast: (text) => toasts.push(text),
    t: (key, text, vars) => String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars || {})[k]),
    Date: globalThis.Date,
    Map,
    Promise,
    setTimeout: (...a) => globalThis.setTimeout(...a)
  }
  vm.runInNewContext(`${CODE}\nthis.api = { approvalsBehind, approvalParked, approvalOpenedByUser, parkAgentApproval, openParkedApproval, askAgentApproval, answerAgentApproval, dismissAgentApprovals, expireAgentApprovalById, checkAgentApprovalTime, closeExpiredApproval, approvalCard, APPROVAL_GAP_MS, APPROVAL_EXPIRED_SHOW_MS }`, ctx)
  return ctx.api
}
const shown = (api) => (api.approvalCard.value && !api.approvalCard.value.expired ? api.approvalCard.value.card.name : null)
const expired = (api) => !!(api.approvalCard.value && api.approvalCard.value.expired)

describe('the approval cards\' queue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the next card shows only a moment after one closes', async () => {
    const api = load()
    const a = api.askAgentApproval({ kind: 'command', name: 'a' }, 'p1')
    const b = api.askAgentApproval({ kind: 'command', name: 'b' }, 'p2')
    await vi.advanceTimersByTimeAsync(0)
    expect(shown(api)).toBe('a')
    api.answerAgentApproval({ allow: true })
    expect(await a).toEqual({ allow: true })
    await vi.advanceTimersByTimeAsync(api.APPROVAL_GAP_MS - 150)
    expect(shown(api)).toBeNull()
    await vi.advanceTimersByTimeAsync(300)
    expect(shown(api)).toBe('b')
    api.answerAgentApproval({ allow: false })
    expect(await b).toEqual({ allow: false })
  })

  it('a terminal card goes before an account switch\'s card asked while it waits', async () => {
    const api = load()
    api.askAgentApproval({ kind: 'command', name: 'first' }, 'p1')
    await vi.advanceTimersByTimeAsync(0)
    const acc = api.askAgentApproval({ kind: 'accounts', name: 'account' }, 'p2', { ms: 120000 })
    const term = api.askAgentApproval({ kind: 'command', name: 'terminal' }, 'p3')
    api.answerAgentApproval({ allow: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(shown(api)).toBe('terminal')
    api.answerAgentApproval({ allow: true })
    expect(await term).toEqual({ allow: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(shown(api)).toBe('account')
    api.answerAgentApproval({ allow: false })
    expect(await acc).toEqual({ allow: false })
  })

  it('a terminal card does not lose its time behind an account card; an account card ends at its own time', async () => {
    const api = load()
    const acc = api.askAgentApproval({ kind: 'accounts', name: 'account' }, 'p2', { ms: 120000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(shown(api)).toBe('account')
    const term = api.askAgentApproval({ kind: 'command', name: 'terminal' }, 'p3', { ms: 60000 })
    // The account card runs out (2 minutes): no answer.
    await vi.advanceTimersByTimeAsync(121000)
    expect(await acc).toEqual({ allow: false, timedOut: true })
    // The account card shows "expired" a few seconds; the terminal card
    // waited all that time, more than its own minute: it still shows.
    expect(expired(api)).toBe(true)
    await vi.advanceTimersByTimeAsync(api.APPROVAL_EXPIRED_SHOW_MS + 1000)
    expect(shown(api)).toBe('terminal')
    api.answerAgentApproval({ allow: true })
    expect(await term).toEqual({ allow: true })
  })

  it('its own timer, even one that fires late in a hidden window, ends the card: "expired", then gone; a click there allows nothing', async () => {
    const api = load()
    const acc = api.askAgentApproval({ kind: 'accounts', name: 'account', token: 'tok-1' }, 'p1', { ms: 120000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(shown(api)).toBe('account')
    // Its timer runs (late or not): the card ends, as it did not before.
    await vi.advanceTimersByTimeAsync(120500)
    expect(await acc).toEqual({ allow: false, timedOut: true })
    expect(expired(api)).toBe(true)
    api.answerAgentApproval({ allow: true })
    expect(api.approvalCard.value).toBeNull()
    expect(await acc).toEqual({ allow: false, timedOut: true })
  })

  it('the expired card closes by itself after a few seconds', async () => {
    const api = load()
    api.askAgentApproval({ kind: 'command', name: 'a' }, 'p1', { ms: 10000 })
    await vi.advanceTimersByTimeAsync(10500)
    expect(expired(api)).toBe(true)
    await vi.advanceTimersByTimeAsync(api.APPROVAL_EXPIRED_SHOW_MS)
    expect(api.approvalCard.value).toBeNull()
  })

  it('a timer held back past the card’s time: Allow is checked against the clock and does not allow', async () => {
    const api = load()
    const acc = api.askAgentApproval({ kind: 'accounts', name: 'account', token: 'tok-1' }, 'p1', { ms: 120000 })
    await vi.advanceTimersByTimeAsync(0)
    // The clock moves on, the timer has not run (a throttled hidden window).
    vi.setSystemTime(Date.now() + 130000)
    api.answerAgentApproval({ allow: true })
    expect(await acc).toEqual({ allow: false, timedOut: true })
    expect(expired(api)).toBe(true)
  })

  it('the window shows again past the card’s time: the card ends at once', async () => {
    const api = load()
    const term = api.askAgentApproval({ kind: 'command', name: 'a', cardId: 'c1' }, 'p1', { ms: 60000 })
    await vi.advanceTimersByTimeAsync(0)
    api.checkAgentApprovalTime()
    expect(shown(api)).toBe('a')
    vi.setSystemTime(Date.now() + 61000)
    api.checkAgentApprovalTime()
    expect(await term).toEqual({ allow: false, timedOut: true })
    expect(expired(api)).toBe(true)
  })

  it('the main process stopped waiting: the card on screen turns "expired", a queued one never shows', async () => {
    const api = load()
    const a = api.askAgentApproval({ kind: 'accounts', name: 'account', token: 'tok-1' }, 'p1', { ms: 120000 })
    const b = api.askAgentApproval({ kind: 'command', name: 'cmd', cardId: 'c2' }, 'p2')
    await vi.advanceTimersByTimeAsync(0)
    // The terminal card goes first; the account card waits.
    expect(shown(api)).toBe('cmd')
    api.expireAgentApprovalById('tok-1')
    api.expireAgentApprovalById('c2')
    expect(await b).toEqual({ allow: false, timedOut: true })
    expect(expired(api)).toBe(true)
    api.answerAgentApproval({ allow: true })
    await vi.advanceTimersByTimeAsync(10000)
    expect(await a).toEqual({ allow: false })
    expect(api.approvalCard.value).toBeNull()
  })

  it('the agent’s call went away while its card shows: "expired", answered no', async () => {
    const api = load()
    const a = api.askAgentApproval({ kind: 'command', name: 'a' }, 'p1')
    await vi.advanceTimersByTimeAsync(0)
    api.dismissAgentApprovals('p1')
    expect(await a).toEqual({ allow: false })
    expect(expired(api)).toBe(true)
  })

  describe('while someone is writing', () => {
    it('the card waits in the toolbar, its answer still counts, and the next one is asked the same way', async () => {
      let writing = true
      const api = load({ writing: () => writing })
      const answer = api.askAgentApproval({ name: 'one', command: 'a', cardId: 'c1' }, 'p1')
      await vi.waitFor(() => expect(shown(api)).toBe('one'))
      expect(api.approvalParked.value).toBe(true)
      expect(api.approvalOpenedByUser.value).toBe(false)
      api.openParkedApproval()
      expect(api.approvalParked.value).toBe(false)
      expect(api.approvalOpenedByUser.value).toBe(true)
      api.answerAgentApproval({ allow: true })
      expect(await answer).toEqual({ allow: true })
      writing = false
      const next = api.askAgentApproval({ name: 'two', command: 'b', cardId: 'c2' }, 'p1')
      await vi.waitFor(() => expect(shown(api)).toBe('two'), { timeout: 3000 })
      expect(api.approvalParked.value).toBe(false)
      api.answerAgentApproval({ allow: false })
      await next
    })

    it('requests behind a parked one are counted, and one that ends behind it is said', async () => {
      toasts.length = 0
      const api = load({ writing: () => true })
      const first = api.askAgentApproval({ name: 'one', agentLabel: 'Ada', command: 'a', cardId: 'c1' }, 'p1')
      await vi.waitFor(() => expect(shown(api)).toBe('one'))
      expect(api.approvalsBehind.value).toBe(0)
      const second = api.askAgentApproval({ name: 'two', agentLabel: 'Bob', command: 'b', cardId: 'c2' }, 'p2', { ms: 50 })
      expect(api.approvalsBehind.value).toBe(1)
      await vi.advanceTimersByTimeAsync(200)
      api.openParkedApproval()
      api.answerAgentApproval({ allow: false })
      await vi.advanceTimersByTimeAsync(5000)
      await first
      expect(await second).toEqual({ allow: false, timedOut: true })
      expect(api.approvalsBehind.value).toBe(0)
      expect(toasts).toEqual(['A request from Bob ended without an answer.'])
    })

    it('put away by the person, it waits too', async () => {
      const api = load()
      const answer = api.askAgentApproval({ name: 'one', command: 'a', cardId: 'c1' }, 'p1')
      await vi.waitFor(() => expect(shown(api)).toBe('one'))
      expect(api.approvalParked.value).toBe(false)
      api.parkAgentApproval()
      expect(api.approvalParked.value).toBe(true)
      api.openParkedApproval()
      api.answerAgentApproval({ allow: false })
      await answer
    })

    it('its time runs out in the toolbar: no card takes the screen, a small notice says so', async () => {
      toasts.length = 0
      const api = load({ writing: () => true })
      const answer = api.askAgentApproval({ name: 'one', agentLabel: 'Ada', command: 'a', cardId: 'c1' }, 'p1')
      await vi.waitFor(() => expect(shown(api)).toBe('one'))
      api.expireAgentApprovalById('c1')
      expect(await answer).toEqual({ allow: false, timedOut: true })
      expect(api.approvalCard.value).toBeNull()
      expect(api.approvalParked.value).toBe(false)
      expect(toasts).toEqual(['A request from Ada ended without an answer.'])
    })

    it("the agent's call went away: it goes quietly", async () => {
      toasts.length = 0
      const api = load({ writing: () => true })
      const answer = api.askAgentApproval({ name: 'one', command: 'a', cardId: 'c1' }, 'p1')
      await vi.waitFor(() => expect(shown(api)).toBe('one'))
      api.dismissAgentApprovals('p1')
      expect(await answer).toEqual({ allow: false })
      expect(api.approvalCard.value).toBeNull()
      expect(toasts).toEqual([])
    })
  })
})
