import { describe, it, expect } from 'vitest'
import { pasteAndConfirm, draftVisible } from '../deliver'

// A fake agent pane on a fake clock. `script(t, state)` decides, at each
// step, whether the agent is busy, what is on screen and whether it asks for
// approval; `state.submits` counts Enter presses.
function harness(script) {
  const state = { t: 0, submits: 0, pastes: 0, screen: '', busy: false, approval: false, gone: false, log: [] }
  const pane = {
    paste: (text) => {
      state.pastes++
      state.pasted = text
      state.log.push(`paste@${state.t}:${text}`)
    },
    typeKeys: async (text) => {
      state.typed = text
      state.log.push(`type@${state.t}:${text}`)
    },
    submit: () => {
      state.submits++
      state.log.push(`enter@${state.t}`)
    },
    screenText: () => state.screen
  }
  const deps = {
    getPane: () => (state.gone ? null : pane),
    isBusy: () => state.busy,
    awaitingApproval: () => state.approval,
    sleep: async (ms) => {
      state.t += ms
      script(state)
    }
  }
  return { state, deps }
}

const MSG = '[From #4 Claude] Please review the tracking branch now.'

describe('draftVisible', () => {
  it('finds the end of the message in the last lines', () => {
    expect(draftVisible({ screenText: () => '> ' + MSG }, MSG)).toBe(true)
    expect(draftVisible({ screenText: () => 'something else' }, MSG)).toBe(false)
  })
})

describe('pasteAndConfirm', () => {
  it('every Enter lost: no acknowledgement, three Enters at most, one paste', async () => {
    const { state, deps } = harness((s) => {
      s.busy = false
      s.screen = '› ' + MSG // the draft stays in the input box
    })
    expect(await pasteAndConfirm('p', MSG, deps)).toBe('unconfirmed')
    expect(state.submits).toBe(3)
    expect(state.pastes).toBe(1)
  })

  it('accepted and working, message still visible in the transcript: no extra Enter', async () => {
    const { state, deps } = harness((s) => {
      s.screen = '› ' + MSG + '\n• Working (2s)'
      s.busy = s.submits > 0 // works as soon as Enter is pressed
    })
    expect(await pasteAndConfirm('p', MSG, deps)).toBe('confirmed')
    expect(state.submits).toBe(1)
  })

  it('first Enter lost, second taken: two Enters, confirmed', async () => {
    const { state, deps } = harness((s) => {
      s.busy = s.submits >= 2
      s.screen = s.submits >= 2 ? '• Working' : '› ' + MSG
    })
    expect(await pasteAndConfirm('p', MSG, deps)).toBe('confirmed')
    expect(state.submits).toBe(2)
  })

  it('an approval prompt after Enter means it is acting on the message', async () => {
    const { deps } = harness((s) => {
      s.approval = s.submits > 0
    })
    expect(await pasteAndConfirm('p', MSG, deps)).toBe('confirmed')
  })

  it('quiet with no draft visible (e.g. a folded paste): unconfirmed, not acknowledged', async () => {
    const { state, deps } = harness((s) => {
      s.busy = false
      s.screen = '[Pasted text #1 +3 lines]'
    })
    expect(await pasteAndConfirm('p', MSG, deps)).toBe('unconfirmed')
    expect(state.submits).toBe(1)
  })

  it('waiting for a quiet agent that got busy meanwhile: put back, nothing typed', async () => {
    const { state, deps } = harness(() => {})
    state.busy = true
    expect(await pasteAndConfirm('p', MSG, { ...deps, waitIdle: true })).toBe('requeue')
    expect(state.pastes).toBe(0)
  })

  it('the user is typing in the pane: put back, nothing typed', async () => {
    const { state, deps } = harness(() => {})
    expect(await pasteAndConfirm('p', MSG, { ...deps, userTyping: () => true })).toBe('requeue')
    expect(state.pastes).toBe(0)
  })

  it('the user starts typing after the paste: no Enter (it would send their text)', async () => {
    const { state, deps } = harness(() => {})
    let typing = false
    const sleep = async (ms) => {
      state.t += ms
      typing = true
    }
    expect(await pasteAndConfirm('p', MSG, { ...deps, userTyping: () => typing, sleep })).toBe('unconfirmed')
    expect(state.submits).toBe(0)
  })

  it('an approval prompt before the paste: put back, nothing typed', async () => {
    const { state, deps } = harness(() => {})
    state.approval = true
    expect(await pasteAndConfirm('p', MSG, deps)).toBe('requeue')
    expect(state.pastes).toBe(0)
  })

  it('at the time limit, a last busy sample alone does not count as taken', async () => {
    const { deps } = harness((s) => {
      s.screen = 'nothing'
      // Busy in short bursts that never last 4 s.
      s.busy = s.t % 3000 === 0
    })
    const r = await pasteAndConfirm('p', MSG, { ...deps, cfg: { quietMs: 60000 } })
    expect(r).toBe('unconfirmed')
  })

  it('the pane closes after the paste: unconfirmed, never failed (no second paste)', async () => {
    const { deps } = harness((s) => {
      s.gone = s.t > 1000
    })
    expect(await pasteAndConfirm('p', MSG, deps)).toBe('unconfirmed')
  })
})

describe("pasteAndConfirm from a terminal agent's chat view", () => {
  const IMG = 'C:\\Temp\\tessel-paste\\chat\\img_0123456789abcdef01234567.png'
  it('pastes each image path on its own, waiting after each (a second path pasted at once was lost), then the text one space apart, then Enter', async () => {
    const { state, deps } = harness((s) => {
      s.busy = s.submits > 0
    })
    expect(await pasteAndConfirm('p', 'What is this?', { ...deps, images: [IMG, IMG] })).toBe('confirmed')
    expect(state.log.slice(0, 5)).toEqual([`paste@0:${IMG}`, 'paste@500: ', `paste@500:${IMG}`, 'paste@1000: What is this?', 'enter@1500'])
  })
  it('images alone: no text pasted, Enter after them', async () => {
    const { state, deps } = harness((s) => {
      s.busy = s.submits > 0
    })
    expect(await pasteAndConfirm('p', '', { ...deps, images: [IMG] })).toBe('confirmed')
    expect(state.pastes).toBe(1)
    expect(state.submits).toBe(1)
  })
  it('a slash command: pasted (Claude) or typed key by key (Codex), one Enter, nothing watched', async () => {
    const { state, deps } = harness(() => {})
    expect(await pasteAndConfirm('p', '/compact', { ...deps, command: 'paste' })).toBe('confirmed')
    expect(state.pasted).toBe('/compact')
    expect(state.submits).toBe(1)
    const typed = harness(() => {})
    expect(await pasteAndConfirm('p', '/model', { ...typed.deps, command: 'type' })).toBe('confirmed')
    expect(typed.state.typed).toBe('/model')
    expect(typed.state.pastes).toBe(0)
    expect(typed.state.submits).toBe(1)
  })
  it('never types while the user has a line in the terminal', async () => {
    const { state, deps } = harness(() => {})
    expect(await pasteAndConfirm('p', '/clear', { ...deps, command: 'paste', userTyping: () => true })).toBe('requeue')
    expect(state.pastes).toBe(0)
  })
})

// Claude Code 2.1.286, five real deliveries: a turn that answered in 1-2 s or
// asked a question at once was never seen busy for 4 s, so the message was
// marked "not confirmed" and the pane held every later one.
describe('pasteAndConfirm: other evidence that the message was taken', () => {
  const withClock = (deps, state) => ({ ...deps, now: () => state.t })

  it('a fast turn its hooks opened and ended after Enter: confirmed, one Enter', async () => {
    const { state, deps } = harness((s) => {
      if (s.submits && s.started == null) s.started = s.t
      s.busy = s.started != null && s.t - s.started < 1000
      if (s.started != null && !s.busy && s.completed == null) s.completed = s.t
      s.screen = s.submits ? `> ${MSG}\n● Done.\n> ` : `> ${MSG}`
    })
    const taken = (id, at) => state.completed != null && state.completed >= at
    expect(await pasteAndConfirm('p', MSG, { ...withClock(deps, state), taken })).toBe('confirmed')
    expect(state.submits).toBe(1)
    expect(state.pastes).toBe(1)
  })

  it('a question asked at once (its hooks: approval since Enter): confirmed', async () => {
    const { state, deps } = harness((s) => {
      if (s.submits && s.asked == null) s.asked = s.t
    })
    const taken = (id, at) => state.asked != null && state.asked >= at
    expect(await pasteAndConfirm('p', MSG, { ...withClock(deps, state), taken })).toBe('confirmed')
    expect(state.submits).toBe(1)
  })

  it('its hooks tell a moment late (after the quiet wait): still confirmed, no second Enter', async () => {
    const { state, deps } = harness((s) => {
      if (s.submits && s.enterAt == null) s.enterAt = s.t
      s.screen = '● Done.'
      if (s.enterAt != null && s.t - s.enterAt >= 3000) s.completed = s.enterAt + 800
    })
    const taken = (id, at) => state.completed != null && state.completed >= at
    expect(await pasteAndConfirm('p', MSG, { ...withClock(deps, state), taken })).toBe('confirmed')
    expect(state.submits).toBe(1)
  })

  it('its input held the text before Enter and is empty after: confirmed, though the text shows above', async () => {
    const { state, deps } = harness((s) => {
      // The transcript shows the message it just took, at the bottom.
      s.screen = `> ${MSG}\n● Done.`
    })
    const pane = deps.getPane()
    pane.agentObservation = () => ({ input: state.submits ? 'empty' : 'draft' })
    expect(await pasteAndConfirm('p', MSG, deps)).toBe('confirmed')
    expect(state.submits).toBe(1)
  })

  it('an input empty already before Enter proves nothing (the paste may not have landed)', async () => {
    const { state, deps } = harness((s) => {
      s.screen = '● Done.'
    })
    deps.getPane().agentObservation = () => ({ input: 'empty' })
    expect(await pasteAndConfirm('p', MSG, deps)).toBe('unconfirmed')
    expect(state.submits).toBe(1)
  })

  it('typed while it was working: hooks of the running turn are no evidence', async () => {
    // Its running turn's hooks, right after the first Enter.
    const taken = () => state.t < 1500
    const { state, deps } = harness((s) => {
      s.busy = s.submits === 0 // working when Enter is pressed, then quiet
      s.screen = '› ' + MSG // still in its input
    })
    state.busy = true
    expect(await pasteAndConfirm('p', MSG, { ...withClock(deps, state), taken })).toBe('unconfirmed')
    expect(state.submits).toBe(3)
    expect(state.pastes).toBe(1)
  })
})
