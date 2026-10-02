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
      state.log.push(`paste@${state.t}`)
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
