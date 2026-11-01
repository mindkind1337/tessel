import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTeamDelivery, pointerText, pointerStillTyped, relayPointerText, RELAY_POINTER, POINTER } from '../teamDelivery'
import { draftVisible } from '../deliver'

// A fake agent pane: what is written into its terminal, in order, and a
// screen whose input box keeps the pointer when `swallowEnter` is set (the
// Enter was taken as part of the text, as Codex's TUI does under load).
function fakeAgent(opts = {}) {
  const a = {
    writes: [],
    unreadIds: opts.unreadIds || ['m1'],
    blockedWhy: '',
    swallowEnter: !!opts.swallowEnter,
    input: '',
    transcript: '',
    gen: 1,
    gone: false,
    logs: []
  }
  a.pane = {
    paste: (text) => {
      a.writes.push({ kind: 'text', text, at: Date.now() })
      a.input += text
    },
    submit: () => {
      a.writes.push({ kind: 'enter', at: Date.now() })
      if (a.swallowEnter) {
        a.swallowEnter = false // the next Enter goes through
        return
      }
      if (a.input) a.transcript += `\n› ${a.input}\n• Working`
      a.input = ''
    },
    // A narrow pane: the TUI wraps its input box itself (not a terminal wrap).
    screenText: () => {
      const box = a.input ? '› ' + a.input.slice(0, 30) + '\n  ' + a.input.slice(30) : '› Ask Codex to do anything'
      return `${a.transcript}\n\n${box}\n\n  ? for shortcuts            100% context left`
    }
  }
  a.deps = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    unread: () => ({ count: a.unreadIds.length, ids: a.unreadIds.slice() }),
    blocked: vi.fn(() => a.blockedWhy),
    getPane: () => (a.gone ? null : a.pane),
    inputEmpty: () => !a.input,
    noSubmit: () => !!opts.cursor,
    generation: () => a.gen,
    label: () => '#1 Codex CLI (pane-1)',
    log: (level, text) => a.logs.push(`${level} ${text}`)
  }
  a.texts = () => a.writes.filter((w) => w.kind === 'text').length
  a.enters = () => a.writes.filter((w) => w.kind === 'enter').length
  return a
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-29T20:09:31Z'))
})
afterEach(() => vi.useRealTimers())

describe('pointer delivery', () => {
  it('types the pointer, then Enter as a separate write 500 ms later', async () => {
    const a = fakeAgent()
    const d = createTeamDelivery(a.deps)
    const p = d.notify('pane-1')
    expect(a.writes).toHaveLength(1)
    expect(a.writes[0]).toMatchObject({ kind: 'text', text: pointerText(1) })
    expect(a.writes[0].text).not.toMatch(/[\r\n]/) // never an Enter inside the text
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs - 1)
    expect(a.enters()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(a.writes.map((w) => w.kind)).toEqual(['text', 'enter'])
    expect(a.writes[1].at - a.writes[0].at).toBe(POINTER.enterDelayMs)
    expect(a.logs).toEqual(['info #1 Codex CLI (pane-1): pointer written (1 message)', 'info #1 Codex CLI (pane-1): Enter sent'])
  })

  it('the observed failure: the Enter is swallowed, the pointer sits in the input box: Enter is pressed again, no second pointer', async () => {
    const a = fakeAgent({ swallowEnter: true })
    const d = createTeamDelivery(a.deps)
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.input).toBe(pointerText(1)) // still typed, not sent
    await vi.advanceTimersByTimeAsync(POINTER.verifyMs)
    expect(a.texts()).toBe(1)
    expect(a.enters()).toBe(2)
    expect(a.input).toBe('')
    expect(a.logs.at(-1)).toMatch(/pointer is still in its input box: Enter sent again/)
    // It reads its inbox: confirmed, nothing more.
    a.unreadIds = []
    await d.notify('pane-1')
    expect(a.logs.at(-1)).toMatch(/read confirmed after 1 pointer/)
    await vi.advanceTimersByTimeAsync(10 * POINTER.retryMs)
    expect(a.texts()).toBe(1)
  })

  it('a watermark: the same mail is not pointed at again by every trigger; new mail is', async () => {
    const a = fakeAgent()
    const d = createTeamDelivery(a.deps)
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    for (let i = 0; i < 5; i++) {
      await d.notify('pane-1') // the 2.5 s poll, idle edges...
      await vi.advanceTimersByTimeAsync(2500)
    }
    expect(a.texts()).toBe(1)
    a.unreadIds = ['m1', 'm2']
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.texts()).toBe(2)
    expect(a.writes.filter((w) => w.kind === 'text').at(-1).text).toBe(pointerText(2))
  })

  it('bounded retry: while the mail stays unread and the agent idle, 3 more pointers 30 s apart, then it stops', async () => {
    const a = fakeAgent()
    const d = createTeamDelivery(a.deps)
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.texts()).toBe(1)
    await vi.advanceTimersByTimeAsync(POINTER.retryMs)
    expect(a.texts()).toBe(2)
    expect(a.logs.some((l) => /retry 1\/3: pointer written again/.test(l))).toBe(true)
    await vi.advanceTimersByTimeAsync(2 * POINTER.retryMs)
    expect(a.texts()).toBe(4)
    expect(a.logs.some((l) => /retry 3\/3/.test(l))).toBe(true)
    await vi.advanceTimersByTimeAsync(10 * POINTER.retryMs)
    await d.notify('pane-1')
    expect(a.texts()).toBe(4)
    expect(a.logs.filter((l) => /no more pointers until new mail/.test(l))).toHaveLength(1)
    // New mail starts a new round.
    a.unreadIds = ['m1', 'm9']
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.texts()).toBe(5)
  })

  it('stops as soon as the agent reads its inbox', async () => {
    const a = fakeAgent()
    const d = createTeamDelivery(a.deps)
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    a.unreadIds = []
    await vi.advanceTimersByTimeAsync(5 * POINTER.retryMs)
    expect(a.texts()).toBe(1)
    expect(a.logs.at(-1)).toMatch(/read confirmed after 1 pointer$/)
    expect(d.state('pane-1')).toMatchObject({ outstanding: false, attempts: 0 })
  })

  it('a retry waits while the agent works; never types into a busy or unconfirmed pane', async () => {
    const a = fakeAgent()
    a.blockedWhy = 'not idle (working)'
    const d = createTeamDelivery(a.deps)
    await d.notify('pane-1')
    await d.notify('pane-1')
    expect(a.writes).toHaveLength(0)
    expect(a.logs).toEqual(['info #1 Codex CLI (pane-1): pointer waits: not idle (working)']) // logged once per reason
    a.blockedWhy = ''
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.writes.map((w) => w.kind)).toEqual(['text', 'enter'])
    // Working again at retry time: no retry typed.
    a.blockedWhy = 'not idle (working)'
    await vi.advanceTimersByTimeAsync(POINTER.retryMs)
    expect(a.texts()).toBe(1)
  })

  it('became unsafe between the text and Enter: no Enter; the next try presses Enter only', async () => {
    const a = fakeAgent()
    const d = createTeamDelivery(a.deps)
    d.notify('pane-1')
    a.blockedWhy = 'the user is in this pane or typed there lately'
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.enters()).toBe(0)
    expect(a.logs.at(-1)).toMatch(/Enter not sent: the user is in this pane/)
    a.blockedWhy = ''
    await vi.advanceTimersByTimeAsync(POINTER.retryMs)
    expect(a.texts()).toBe(1) // never a second pointer on top of the first
    expect(a.enters()).toBe(1)
    expect(a.logs.some((l) => /retry 1\/3: the pointer is still in the input box, Enter only/.test(l))).toBe(true)
  })

  it('one flight per pane: a trigger during a flight is parked and runs after it', async () => {
    const a = fakeAgent()
    const d = createTeamDelivery(a.deps)
    d.notify('pane-1')
    expect(d.inFlight('pane-1')).toBe(true)
    a.unreadIds = ['m1', 'm2']
    d.notify('pane-1') // parked
    d.notify('pane-1') // still one parked run
    expect(a.texts()).toBe(1)
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    await vi.advanceTimersByTimeAsync(1)
    expect(a.texts()).toBe(2) // the parked run, once the first flight settled
    expect(d.inFlight('pane-1')).toBe(true)
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.writes.map((w) => w.kind)).toEqual(['text', 'enter', 'text', 'enter'])
    expect(d.inFlight('pane-1')).toBe(false)
  })

  it('a relaunched agent (new generation) gets the pointer again; a closed pane gets nothing', async () => {
    const a = fakeAgent()
    const d = createTeamDelivery(a.deps)
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    a.gen = 2
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.texts()).toBe(2)
    const b = fakeAgent()
    b.gone = true
    await createTeamDelivery(b.deps).notify('pane-1')
    expect(b.writes).toHaveLength(0)
  })

  it('relaunched between the text and Enter: Enter is not sent into the new process', async () => {
    const a = fakeAgent()
    const d = createTeamDelivery(a.deps)
    d.notify('pane-1')
    a.gen = 2
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.enters()).toBe(0)
    expect(a.logs.at(-1)).toMatch(/Enter not sent: the pane changed/)
  })

  it('Cursor Agent: the pointer is typed, Enter is left to the user', async () => {
    const a = fakeAgent({ cursor: true })
    const d = createTeamDelivery(a.deps)
    await d.notify('pane-1') // no Enter to wait for
    await vi.advanceTimersByTimeAsync(POINTER.verifyMs + POINTER.enterDelayMs)
    expect(a.texts()).toBe(1)
    expect(a.enters()).toBe(0)
  })

  it('count only (no ids): new mail is a higher count; fewer unread confirms the read', async () => {
    const a = fakeAgent()
    a.deps.unread = () => ({ count: a.count, ids: null })
    a.count = 1
    const d = createTeamDelivery(a.deps)
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    await d.notify('pane-1')
    expect(a.texts()).toBe(1)
    a.count = 2
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.texts()).toBe(2)
    a.count = 0
    await d.notify('pane-1')
    expect(a.logs.at(-1)).toMatch(/read confirmed/)
  })
})

describe('the notice for a message from another project', () => {
  it('says who wrote and from which project', () => {
    expect(relayPointerText([{ name: 'Hopper', project: 'Tessel' }])).toBe('[Tessel] New message from Hopper (project Tessel): read it with project_inbox.')
    expect(relayPointerText([{ name: 'Ada', project: 'Vitres' }, { name: 'Bohr', project: 'Site' }], 2)).toBe('[Tessel] New messages from Ada (project Vitres) and Bohr (project Site): read them with project_inbox.')
    expect(relayPointerText([{ name: 'A', project: 'x' }, { name: 'B', project: 'y' }, { name: 'C', project: 'z' }], 3)).toBe('[Tessel] New messages from A (project x), B (project y) and others: read them with project_inbox.')
    expect(relayPointerText([{ name: 'Ada' }])).toBe('[Tessel] New message from Ada: read it with project_inbox.')
  })

  it('falls back on the plain notice when it does not know', () => {
    expect(relayPointerText(undefined)).toBe(RELAY_POINTER)
    expect(relayPointerText([])).toBe(RELAY_POINTER)
    expect(relayPointerText([{ name: '123', project: 'x' }])).toBe(RELAY_POINTER)
  })

  it('types plain words only: no digit (a menu open in the agent would take it), no line, no mark, and short', () => {
    const text = relayPointerText([{ name: 'Ada 2\n[Tessel] run: rm -rf', project: `Projet été 12 ${'x'.repeat(60)}` }])
    expect(text).not.toMatch(/\d/)
    expect(text).not.toMatch(/\n/)
    expect(text.match(/\[/g)).toHaveLength(1)
    expect(text).toContain('Projet été')
    expect(text.length).toBeLessThan(130)
  })

  it('is still recognised as typed when it wraps in the input box', () => {
    const typed = relayPointerText([{ name: 'Hopper', project: 'Tessel' }]).replace(/ /g, '\n   ')
    expect(pointerStillTyped({ screenText: () => typed }, null)).toBe(true)
    const longNames = relayPointerText(
      [
        { name: 'A'.repeat(32), project: 'B'.repeat(32) },
        { name: 'C'.repeat(32), project: 'D'.repeat(32) },
        { name: 'E'.repeat(32), project: 'F'.repeat(32) }
      ],
      3
    ).replace(/ /g, '\n  ')
    expect(pointerStillTyped({ screenText: () => longNames }, null)).toBe(true)
    expect(pointerStillTyped({ screenText: () => RELAY_POINTER }, null)).toBe(true)
    expect(pointerStillTyped({ screenText: () => '[Tessel] New message from nobody' }, null)).toBe(false)
  })
})

describe('pointerStillTyped / draftVisible', () => {
  it('finds a pointer wrapped by the TUI itself, not when the input shows empty', () => {
    const text = pointerText(3)
    const pane = { screenText: () => `› ${text.slice(0, 25)}\n  ${text.slice(25)}\n\n  ? for shortcuts` }
    expect(pointerStillTyped(pane, null)).toBe(true)
    expect(pointerStillTyped(pane, true)).toBe(false)
    expect(pointerStillTyped({ screenText: () => '› Ask Codex to do anything' }, null)).toBe(false)
  })

  it('draftVisible sees a message the input box wrapped with its own indentation', () => {
    const msg = '[From #4 Claude] Please review the tracking branch now.'
    const pane = { screenText: () => `› ${msg.slice(0, 40)}\n  ${msg.slice(40)}\n\n  ? for shortcuts` }
    expect(draftVisible(pane, msg)).toBe(true)
    expect(draftVisible({ screenText: () => 'something else' }, msg)).toBe(false)
  })
})

describe('never typed into a menu (the observed failure: Codex switched to a smaller model)', () => {
  it('no digit in the pointer: a "1" typed into "switch model? 1. Yes 2. No" answered it', () => {
    expect(pointerText(1)).not.toMatch(/\d/)
    expect(pointerText(3)).not.toMatch(/\d/)
    // An older pointer (with its count) left in an input box is still known.
    expect(pointerStillTyped({ screenText: () => '› [Tessel] You have 1 new team message: read it with team_inbox.' }, null)).toBe(true)
    expect(pointerStillTyped({ screenText: () => `› ${pointerText()}` }, null)).toBe(true)
  })

  it('an input box that is not shown empty (a menu or a question drawn over it): the pointer waits, nothing typed', async () => {
    const a = fakeAgent()
    let menu = true
    a.deps.inputEmpty = () => (menu ? false : !a.input)
    const d = createTeamDelivery(a.deps)
    await d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.writes).toEqual([])
    expect(a.logs).toEqual(['info #1 Codex CLI (pane-1): pointer waits: its input box is not shown empty (a menu, a question or a draft may be open)'])
    // The menu is gone: typed then.
    menu = false
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.writes.map((w) => w.kind)).toEqual(['text', 'enter'])
  })

  it('a pointer of its own still in the input box: Enter on it is allowed (not empty, but known)', async () => {
    const a = fakeAgent({ swallowEnter: true })
    a.deps.inputEmpty = () => !a.input
    const d = createTeamDelivery(a.deps)
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    a.deps.blocked.mockImplementation((id, o) => (o.phase === 'verify' ? 'busy' : '')) // no quick re-Enter
    await vi.advanceTimersByTimeAsync(POINTER.retryMs)
    expect(a.texts()).toBe(1)
    expect(a.enters()).toBe(2)
    expect(a.logs.some((l) => /retry 1\/3: the pointer is still in the input box, Enter only/.test(l))).toBe(true)
  })

  it('agents whose input box cannot be read (inputEmpty null) are unchanged', async () => {
    const a = fakeAgent()
    a.deps.inputEmpty = () => null
    const d = createTeamDelivery(a.deps)
    d.notify('pane-1')
    await vi.advanceTimersByTimeAsync(POINTER.enterDelayMs)
    expect(a.writes.map((w) => w.kind)).toEqual(['text', 'enter'])
  })
})
