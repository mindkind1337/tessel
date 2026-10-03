import { describe, it, expect } from 'vitest'
import { pasteAndConfirm, draftVisible, turnStarting } from '../deliver'

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

describe('pasteAndConfirm waits for each image to show in its input (Claude Code, OpenClaude)', () => {
  const img = (n) => `C:\Temp\tessel-paste\chat\img_${String(n).padStart(24, '0')}.png`
  // A pane whose input turns each pasted image path into "[Image #N]" after
  // `delay(n)` ms (null: never); imageMarkers() counts them.
  function withMarkers(delay, extra = () => {}) {
    const shown = [] // when each pasted path shows as its marker
    const h = harness((s) => {
      s.busy = s.submits > 0
      extra(s)
    })
    const base = h.deps.getPane
    const pane = base()
    const paste = pane.paste
    pane.paste = (text) => {
      paste(text)
      if (/img_\d+\.png$/.test(text)) {
        const d = delay(shown.length + 1)
        shown.push(d === null ? Infinity : h.state.t + d)
      }
    }
    pane.imageMarkers = () => shown.filter((at) => at <= h.state.t).length
    return { ...h, pane }
  }
  const enters = (s) => s.log.filter((l) => l.startsWith('enter@'))
  const imagePastes = (s) => s.log.filter((l) => /img_/.test(l))

  it('a slow image (2 s): the next path and the text wait for its marker, then one Enter', async () => {
    const { state, deps } = withMarkers((n) => (n === 1 ? 2000 : 300))
    expect(await pasteAndConfirm('p', 'Colours?', { ...deps, images: [img(1), img(2)] })).toBe('confirmed')
    const second = state.log.findIndex((l) => l.includes(img(2)))
    expect(Number(state.log[second].match(/@(\d+)/)[1])).toBeGreaterThanOrEqual(2000)
    expect(state.log.find((l) => l.includes('Colours?'))).toMatch(/^paste@(\d+):/)
    const textAt = Number(state.log.find((l) => l.includes('Colours?')).match(/@(\d+)/)[1])
    expect(textAt).toBeGreaterThanOrEqual(2300)
    expect(enters(state)).toHaveLength(1)
  })

  it('a fast image is not held long: a short minimum settle only', async () => {
    const { state, deps } = withMarkers(() => 50)
    expect(await pasteAndConfirm('p', 'Hi', { ...deps, images: [img(1), img(2)] })).toBe('confirmed')
    // No space pasted between: the first path is already "[Image #1]".
    expect(state.log.slice(0, 3)).toEqual([`paste@0:${img(1)}`, `paste@200:${img(2)}`, 'paste@400: Hi'])
  })

  it('three images: each waited for in turn, all before the text, Enter once', async () => {
    const { state, deps } = withMarkers((n) => n * 400)
    expect(await pasteAndConfirm('p', 'How many?', { ...deps, images: [img(1), img(2), img(3)] })).toBe('confirmed')
    expect(imagePastes(state)).toEqual([`paste@0:${img(1)}`, `paste@400:${img(2)}`, `paste@1200:${img(3)}`])
    expect(state.log.indexOf('paste@2400: How many?')).toBeGreaterThan(0)
    expect(enters(state)).toEqual(['enter@2900'])
  })

  it('a marker that never shows: stops after the wait, the rest not pasted, never Enter, told why', async () => {
    const { state, deps } = withMarkers((n) => (n === 2 ? null : 100))
    const why = []
    const res = await pasteAndConfirm('p', 'How many?', { ...deps, images: [img(1), img(2), img(3)], stopped: (w) => why.push(w) })
    expect(res).toBe('unconfirmed')
    expect(state.submits).toBe(0)
    expect(imagePastes(state)).toHaveLength(2)
    expect(state.log.some((l) => l.includes('How many?'))).toBe(false)
    expect(why).toEqual(['image'])
    expect(state.t).toBeLessThanOrEqual(200 + 5000 + 100)
  })

  it('the user types in its terminal while an image is attaching: nothing more pasted, no Enter', async () => {
    let typing = false
    const { state, deps } = withMarkers(() => 1000, (s) => {
      if (s.t >= 300) typing = true
    })
    const why = []
    const res = await pasteAndConfirm('p', 'Hi', { ...deps, images: [img(1), img(2)], userTyping: () => typing, stopped: (w) => why.push(w) })
    expect(res).toBe('unconfirmed')
    expect(imagePastes(state)).toHaveLength(1)
    expect(state.submits).toBe(0)
    expect(why).toEqual(['noEnter'])
  })

  it('an approval prompt while an image is attaching: no Enter', async () => {
    const { state, deps } = withMarkers(() => 1000, (s) => {
      if (s.t >= 300) s.approval = true
    })
    expect(await pasteAndConfirm('p', 'Hi', { ...deps, images: [img(1)] })).toBe('unconfirmed')
    expect(state.submits).toBe(0)
  })

  it('the user typing before it starts: requeued, nothing pasted', async () => {
    const { state, deps } = withMarkers(() => 100)
    expect(await pasteAndConfirm('p', 'Hi', { ...deps, images: [img(1)], userTyping: () => true })).toBe('requeue')
    expect(state.pastes).toBe(0)
  })

  it('an input it cannot read (Codex, Cursor, Antigravity: null): the fixed settle after each path', async () => {
    const { state, deps, pane } = withMarkers(() => 100)
    pane.imageMarkers = () => null
    expect(await pasteAndConfirm('p', 'Hi', { ...deps, images: [img(1), img(2)] })).toBe('confirmed')
    expect(imagePastes(state)).toEqual([`paste@0:${img(1)}`, `paste@500:${img(2)}`])
    expect(state.log).toContain('paste@500: ') // a space apart: a path never joins the one before it
  })
})

describe('turnStarting: the next quiet-agent message waits for the turn the last one started', () => {
  it('waits while the agent has not shown it works yet, then while it works', () => {
    const p = { at: 1000, sawBusy: false }
    expect(turnStarting(p, { busy: false, now: 1500 })).toBe(true)
    expect(turnStarting(p, { busy: true, now: 3000 })).toBe(true)
    expect(turnStarting(p, { busy: false, now: 9000 })).toBe(false)
  })
  it('its hooks saw a turn end since that Enter: over at once', () => {
    expect(turnStarting({ at: 1000, sawBusy: false }, { busy: false, endedAt: 1200, now: 1300 })).toBe(false)
    expect(turnStarting({ at: 1000, sawBusy: false }, { busy: false, endedAt: 900, now: 1300 })).toBe(true)
  })
  it('never seen working: over after maxMs', () => {
    expect(turnStarting({ at: 1000, sawBusy: false }, { busy: false, now: 22000 })).toBe(false)
    expect(turnStarting(null, { busy: true })).toBe(false)
  })
})

describe('an image path the agent left as plain text (Codex on Windows, now and then)', () => {
  const img = (n) => `C:\Temp\tessel-paste\chat\img_${String(n).padStart(24, '0')}.png`
  // Pastes of a path that fail (by attempt number) stay as text on screen.
  function flaky(fails) {
    const h = harness((s) => {
      s.busy = s.submits > 0
    })
    const pane = h.deps.getPane()
    const paste = pane.paste
    let markers = 0
    let text = ''
    const tries = {}
    pane.paste = (t) => {
      paste(t)
      if (/img_\d+\.png$/.test(t)) {
        tries[t] = (tries[t] || 0) + 1
        if (fails(t, tries[t])) text += t
        else markers++
      } else text += t
    }
    pane.erase = (n) => {
      h.state.log.push(`erase@${h.state.t}:${n}`)
      text = text.slice(0, Math.max(0, text.length - n))
    }
    pane.imageMarkers = () => markers
    pane.screenText = () => text
    return { ...h, pane, tries }
  }
  it('erased (exactly its length) and pasted again: then all goes, one Enter', async () => {
    const { state, deps, tries } = flaky((f, n) => f === img(2) && n === 1)
    expect(await pasteAndConfirm('p', 'Colours?', { ...deps, images: [img(1), img(2), img(3)] })).toBe('confirmed')
    expect(tries[img(2)]).toBe(2)
    expect(state.log.filter((l) => l.startsWith('erase@'))).toEqual([`erase@1800:${img(2).length}`])
    expect(state.submits).toBe(1)
  })
  // Codex turns the path into its image a moment after the wait ended: that
  // image is taken, never erased (the backspaces would eat it and the earlier
  // ones) nor called missing.
  it('an image that shows just after the wait: taken, nothing erased, one Enter', async () => {
    const { state, deps, pane, tries } = flaky(() => true)
    const plain = pane.screenText
    pane.imageMarkers = () => (state.t > 1500 ? 1 : 0)
    pane.screenText = () => (state.t > 1500 ? '' : plain())
    const why = []
    const result = await pasteAndConfirm('p', 'Colours?', { ...deps, images: [img(1)], stopped: (w) => why.push(w) })
    expect(result).toBe('confirmed')
    expect(tries[img(1)]).toBe(1)
    expect(state.log.some((l) => l.startsWith('erase@'))).toBe(false)
    expect(why).toEqual([])
    expect(state.submits).toBe(1)
  })
  it('never taken: three tries, then stopped without Enter', async () => {
    const { state, deps, tries } = flaky((f) => f === img(1))
    const why = []
    expect(await pasteAndConfirm('p', 'Colours?', { ...deps, images: [img(1)], stopped: (w) => why.push(w) })).toBe('unconfirmed')
    expect(tries[img(1)]).toBe(3)
    expect(state.log.filter((l) => l.startsWith('erase@'))).toHaveLength(2)
    expect(state.submits).toBe(0)
    expect(why).toEqual(['image'])
  })
  it('the path is not what ends its input: nothing erased, stopped', async () => {
    const { state, deps, pane } = flaky(() => true)
    pane.screenText = () => 'something else'
    expect(await pasteAndConfirm('p', 'Hi', { ...deps, images: [img(1)] })).toBe('unconfirmed')
    expect(state.log.some((l) => l.startsWith('erase@'))).toBe(false)
    expect(state.submits).toBe(0)
  })
  it('a pane that cannot erase (not Codex): one paste, the whole wait, then stopped', async () => {
    const { state, deps, pane } = flaky(() => true)
    delete pane.erase
    expect(await pasteAndConfirm('p', 'Hi', { ...deps, images: [img(1)] })).toBe('unconfirmed')
    expect(state.pastes).toBe(1)
    expect(state.t).toBeGreaterThanOrEqual(5000)
  })
})
