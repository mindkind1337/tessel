// The agents' approval cards share one place on screen (App.vue
// askAgentApproval): a pause between two cards, the terminal tools' cards
// before an account switch's, and a terminal card's time not spent behind
// an account card. Run on App.vue's own code, as cliRequestHotReload.spec.js does.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8').replace(/\r\n/g, '\n')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}
const CODE = slice('const AGENT_APPROVAL_MS', '// An "Allow ..." rule needs auto approve on')

function load() {
  const ctx = {
    ref: (value) => ({ value }),
    confirmState: { value: null },
    Date: globalThis.Date,
    Map,
    Promise,
    setTimeout: (...a) => globalThis.setTimeout(...a)
  }
  vm.runInNewContext(`${CODE}\nthis.api = { askAgentApproval, answerAgentApproval, dismissAgentApprovals, approvalCard, APPROVAL_GAP_MS }`, ctx)
  return ctx.api
}
const shown = (api) => (api.approvalCard.value ? api.approvalCard.value.card.name : null)

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
    // The terminal card waited 2 minutes, more than its own minute: it still shows.
    await vi.advanceTimersByTimeAsync(1000)
    expect(shown(api)).toBe('terminal')
    api.answerAgentApproval({ allow: true })
    expect(await term).toEqual({ allow: true })
  })
})
