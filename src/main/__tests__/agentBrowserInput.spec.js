// Points, drags and keys for canvas and game pages (agentBrowserInput.js),
// and where the keyboard is when it is inside a frame of another process.
import { describe, it, expect, vi } from 'vitest'
import {
  viewportPoint,
  pointInBox,
  dragEvents,
  mouseButton,
  keyTiming,
  pressKey,
  focusedField,
  BrowserInputError,
  OPAQUE_REFUSAL,
  MAX_DRAG_STEPS,
  MAX_HOLD_MS,
  MAX_REPEAT,
  REPEAT_GAP_MS
} from '../agentBrowserInput'

const VP = { width: 640, height: 480 }

describe('coordinates (CSS pixels of the viewport)', () => {
  it('takes a point inside the viewport, rounded', () => {
    expect(viewportPoint(170, 120.4, VP)).toEqual({ x: 170, y: 120 })
    expect(viewportPoint('12', '7', VP)).toEqual({ x: 12, y: 7 })
    expect(viewportPoint(0, 0, VP)).toEqual({ x: 0, y: 0 })
  })

  it('clamps a point a little outside (a scaled screenshot rounds) to the edge', () => {
    expect(viewportPoint(-1.5, 481, VP)).toEqual({ x: 0, y: 479 })
    expect(viewportPoint(640, 480, VP)).toEqual({ x: 639, y: 479 })
  })

  it('refuses a point outside the viewport, saying its size', () => {
    for (const [x, y] of [
      [5000, 10],
      [-10, 5],
      [10, 483]
    ]) {
      let err = null
      try {
        viewportPoint(x, y, VP)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(BrowserInputError)
      expect(err.code).toBe('out_of_viewport')
      expect(err.message).toContain('640x480')
    }
  })

  it('refuses what is not a number', () => {
    for (const [x, y] of [
      [NaN, 1],
      [1, Infinity],
      ['a', 2],
      [null, 2],
      [undefined, 2],
      [true, 2],
      ['', 3]
    ])
      expect(() => viewportPoint(x, y, VP)).toThrow(expect.objectContaining({ code: 'invalid_argument' }))
  })

  it('a point inside an element, from its top left corner', () => {
    const box = { x: 20, y: 260, width: 300, height: 200 }
    expect(pointInBox(box, 150, 100, VP)).toEqual({ x: 170, y: 360 })
    // The far corner (and a pixel of slack) is still the element's.
    expect(pointInBox(box, 301, 200, VP)).toEqual({ x: 320, y: 460 })
    expect(() => pointInBox(box, 400, 10, VP)).toThrow(expect.objectContaining({ code: 'out_of_element' }))
    expect(() => pointInBox(box, 10, NaN, VP)).toThrow(expect.objectContaining({ code: 'invalid_argument' }))
    // Inside the element, but where it runs out of the viewport: refused (not clicked elsewhere).
    expect(() => pointInBox({ x: 600, y: 10, width: 200, height: 20 }, 150, 5, VP)).toThrow(expect.objectContaining({ code: 'out_of_viewport' }))
  })

  it('buttons: left (default), right, middle; nothing else', () => {
    expect(mouseButton(undefined)).toBe('left')
    expect(mouseButton('Right')).toBe('right')
    expect(mouseButton('middle')).toBe('middle')
    expect(() => mouseButton('back')).toThrow(expect.objectContaining({ code: 'invalid_argument' }))
  })
})

describe('a drag (Input.dispatchMouseEvent, in order)', () => {
  it('moves to the start, presses, moves in steps with the button held, releases at the end', () => {
    const ev = dragEvents({ x: 40, y: 40 }, { x: 200, y: 150 }, { steps: 5 })
    expect(ev.map((e) => e.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseReleased'])
    expect(ev[0]).toEqual({ type: 'mouseMoved', x: 40, y: 40, button: 'none', buttons: 0 })
    expect(ev[1]).toEqual({ type: 'mousePressed', x: 40, y: 40, button: 'left', buttons: 1, clickCount: 1 })
    expect(ev.slice(2, 7).map((e) => [e.x, e.y, e.buttons, e.button])).toEqual([
      [72, 62, 1, 'left'],
      [104, 84, 1, 'left'],
      [136, 106, 1, 'left'],
      [168, 128, 1, 'left'],
      [200, 150, 1, 'left']
    ])
    expect(ev[7]).toEqual({ type: 'mouseReleased', x: 200, y: 150, button: 'left', buttons: 0, clickCount: 1 })
  })

  it('the right button holds its own bit; steps default to 10 and stay under the cap', () => {
    const ev = dragEvents({ x: 0, y: 0 }, { x: 10, y: 0 }, { button: 'right' })
    expect(ev.filter((e) => e.type === 'mouseMoved').length).toBe(11)
    expect(ev[1].buttons).toBe(2)
    expect(dragEvents({ x: 0, y: 0 }, { x: 10, y: 0 }, { steps: 10000 }).length).toBe(MAX_DRAG_STEPS + 3)
    expect(dragEvents({ x: 0, y: 0 }, { x: 10, y: 0 }, { steps: 0 }).length).toBe(10 + 3)
  })
})

describe('keys held and repeated', () => {
  it('keyTiming: defaults, limits', () => {
    expect(keyTiming(undefined, undefined)).toEqual({ holdMs: 0, repeat: 1, gapMs: REPEAT_GAP_MS })
    expect(keyTiming(250, 3)).toEqual({ holdMs: 250, repeat: 3, gapMs: REPEAT_GAP_MS })
    for (const [h, r] of [
      [-1, 1],
      [MAX_HOLD_MS + 1, 1],
      [0, 0],
      [0, 1.5],
      [0, MAX_REPEAT + 1],
      ['x', 1],
      [10000, 10]
    ])
      expect(() => keyTiming(h, r)).toThrow(expect.objectContaining({ code: 'invalid_argument' }))
  })

  // A page whose keyboard is on its body (nothing in a frame).
  const plainPage = () => {
    const sent = []
    const send = async (method, params) => {
      sent.push([method, params])
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F', loaderId: 'L' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
      if (method === 'Runtime.evaluate') return { result: { type: 'object', subtype: 'null' } }
      return {}
    }
    return { send, sent }
  }

  it('held: keyDown (and its char), the hold, then keyUp; repeated with a gap', async () => {
    vi.useFakeTimers()
    try {
      const { send } = plainPage()
      const events = []
      const sendInput = vi.fn(async (ev) => events.push([ev.type, ev.keyCode, Date.now()]))
      const start = Date.now()
      const done = pressKey(send, 'ArrowLeft', sendInput, {}, [], { holdMs: 300, repeat: 2, gapMs: 30 })
      await vi.advanceTimersByTimeAsync(1000)
      await done
      expect(events.map(([t, k]) => `${t}:${k}`)).toEqual(['keyDown:Left', 'keyUp:Left', 'keyDown:Left', 'keyUp:Left'])
      const at = events.map(([, , t]) => t - start)
      expect(at[1] - at[0]).toBe(300)
      expect(at[2] - at[1]).toBe(30)
      expect(at[3] - at[2]).toBe(300)
      // A character's char event goes with its keyDown, before the hold.
      events.length = 0
      const typed = pressKey(send, 'a', sendInput, {}, [], { holdMs: 100, repeat: 1, gapMs: 30 })
      await vi.advanceTimersByTimeAsync(500)
      await typed
      expect(events.map(([t]) => t)).toEqual(['keyDown', 'char', 'keyUp'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stopped during a hold: the key goes up at once, then the stop is thrown; no further press', async () => {
    vi.useFakeTimers()
    try {
      const { send } = plainPage()
      const events = []
      const sendInput = vi.fn(async (ev) => events.push(`${ev.type}:${ev.keyCode}@${Date.now()}`))
      let stopped = false
      const check = () => {
        if (stopped) throw new BrowserInputError('stopped_by_user', 'stopped')
      }
      const start = Date.now()
      const done = pressKey(send, 'ArrowLeft', sendInput, {}, [], { holdMs: 5000, repeat: 3, gapMs: 30 }, check).catch((e) => e)
      await vi.advanceTimersByTimeAsync(200)
      stopped = true
      await vi.advanceTimersByTimeAsync(100)
      const err = await done
      expect(err.code).toBe('stopped_by_user')
      expect(events.map((e) => e.split('@')[0])).toEqual(['keyDown:Left', 'keyUp:Left'])
      // Up within a hold step of the stop, not after the 5 s hold.
      expect(Number(events[1].split('@')[1]) - start).toBeLessThanOrEqual(250)
      await vi.advanceTimersByTimeAsync(20000)
      expect(events.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

// A page whose keyboard went into a frame of another process (another site,
// or a sandboxed game embed): the page's own document only sees its <iframe>.
function framedPage({ frameFocus = { tag: 'BODY' }, hasFocus = false, attached = true, local = false } = {}) {
  const sent = []
  const frameSent = []
  const topEval = (p) => {
    const ex = String(p.expression)
    if (ex.includes("querySelectorAll('*')")) return { result: {} }
    // DEEP_FRAME (the <iframe> it cannot look into) returns the element; DEEP_ACTIVE says 'opaque'.
    if (ex.includes('return el;') && ex.includes('contentDocument')) return { result: { objectId: 'iframe-el' } }
    if (ex.includes('document.activeElement')) {
      if (p.contextId === 77) return frameResult(frameFocus, false)
      return { result: { type: 'string', value: 'opaque' } }
    }
    return { result: {} }
  }
  const frameResult = (f, gated) => {
    if (gated && !hasFocus) return { result: { type: 'string', value: 'elsewhere' } }
    return { result: { objectId: `f-${f.tag}` } }
  }
  const describeFrameNode = (p) => {
    const tag = String(p.objectId || '').slice(2)
    return { node: { backendNodeId: tag === 'INPUT' ? 901 : 900, nodeName: tag } }
  }
  const page = async (method, params = {}) => {
    sent.push([method, params])
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'TOP', loaderId: 'L' }, childFrames: local ? [{ frame: { id: 'GAME', loaderId: 'LG' } }] : [] } }
      case 'Page.createIsolatedWorld':
        return { executionContextId: params.frameId === 'GAME' ? 77 : 1 }
      case 'Runtime.evaluate':
        return topEval(params)
      case 'DOM.describeNode':
        if (params.objectId === 'iframe-el') return { node: { backendNodeId: 5, nodeName: 'IFRAME', frameId: 'GAME' } }
        return describeFrameNode(params)
      case 'Runtime.callFunctionOn':
        return { result: { value: !!frameFocus.secret } }
      default:
        return {}
    }
  }
  const frame = async (method, params = {}) => {
    frameSent.push([method, params])
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'GAME', loaderId: 'LG' } } }
      case 'Page.createIsolatedWorld':
        return { executionContextId: 5 }
      case 'Runtime.evaluate': {
        const ex = String(params.expression)
        if (ex.includes("querySelectorAll('*')")) return { result: {} }
        return frameResult(frameFocus, ex.includes('document.hasFocus()'))
      }
      case 'DOM.describeNode':
        return describeFrameNode(params)
      case 'Runtime.callFunctionOn':
        return { result: { value: !!frameFocus.secret } }
      default:
        return {}
    }
  }
  const frameState = { targetId: 'GAME', secretIds: new Set() }
  const frames = attached && !local ? [{ send: frame, cache: frameState }] : []
  return { page, frame, frames, sent, frameSent }
}

describe('the keyboard in a frame of another site', () => {
  it('found through the <iframe> that has it, even when the frame does not say document.hasFocus()', async () => {
    const p = framedPage({ hasFocus: false })
    const focus = await focusedField(p.page, {}, p.frames)
    expect(focus).toMatchObject({ secret: false, opaque: false, remote: true })
    expect(focus.frame.cache.targetId).toBe('GAME')
  })

  it('a canvas or the body of an inspected frame takes keys; they go through the frame\'s own session', async () => {
    const p = framedPage({ frameFocus: { tag: 'CANVAS' } })
    const sendInput = vi.fn(async () => {})
    await pressKey(p.page, 'Space', sendInput, {}, p.frames)
    await pressKey(p.page, 'ArrowLeft', sendInput, {}, p.frames)
    // Not webContents.sendInputEvent: it reaches the page's own process only.
    expect(sendInput).not.toHaveBeenCalled()
    const keys = p.frameSent.filter(([m]) => m === 'Input.dispatchKeyEvent').map(([, e]) => `${e.type}:${e.key}`)
    expect(keys).toEqual(['keyDown: ', 'keyUp: ', 'rawKeyDown:ArrowLeft', 'keyUp:ArrowLeft'])
    expect(p.sent.filter(([m]) => m === 'Input.dispatchKeyEvent')).toEqual([])
  })

  it('a field in the frame is checked: a password field is refused', async () => {
    const p = framedPage({ frameFocus: { tag: 'INPUT', secret: true } })
    await expect(pressKey(p.page, 'a', vi.fn(), {}, p.frames)).rejects.toMatchObject({ code: 'password_field' })
    expect(p.frameSent.filter(([m]) => m === 'Input.dispatchKeyEvent')).toEqual([])
    const ok = framedPage({ frameFocus: { tag: 'INPUT', secret: false } })
    await pressKey(ok.page, 'a', vi.fn(), {}, ok.frames)
    expect(ok.frameSent.filter(([m]) => m === 'Input.dispatchKeyEvent').length).toBe(2)
  })

  it('the password fields of a frame of the page\'s own process are remembered (scanned in its isolated world)', async () => {
    const p = framedPage({ local: true, frameFocus: { tag: 'INPUT', secret: false } })
    // The game frame's world (context 77) finds a password field (backend 901: the focused INPUT).
    const scanned = []
    const page = async (method, params = {}) => {
      if (method === 'Runtime.evaluate' && String(params.expression).includes("querySelectorAll('*')")) {
        scanned.push(params.contextId)
        return params.contextId === 77 ? { result: { objectId: 'scan-77' } } : { result: {} }
      }
      if (method === 'Runtime.getProperties' && params.objectId === 'scan-77') return { result: [{ name: '0', value: { objectId: 'f-INPUT' } }] }
      return p.page(method, params)
    }
    const cache = {}
    await expect(pressKey(page, 'a', vi.fn(), cache, [])).rejects.toMatchObject({ code: 'password_field' })
    expect(scanned).toEqual([1, 77])
    expect(cache.secretIds.has(901)).toBe(true)
  })

  it('a frame of the page\'s own process is looked at in its own isolated world', async () => {
    const p = framedPage({ local: true, frameFocus: { tag: 'CANVAS' } })
    const focus = await focusedField(p.page, {}, p.frames)
    expect(focus).toMatchObject({ secret: false, opaque: false, remote: true })
    expect(focus.frame).toBeUndefined()
    expect(p.sent).toContainEqual(['Page.createIsolatedWorld', expect.objectContaining({ frameId: 'GAME' })])
    // Its keys go the page's way (the same process).
    const sendInput = vi.fn(async () => {})
    await pressKey(p.page, 'k', sendInput, {}, p.frames)
    expect(sendInput.mock.calls.map(([e]) => e.type)).toEqual(['keyDown', 'char', 'keyUp'])
  })

  it('a frame Tessel cannot inspect: characters refused with what to do; arrows and Enter still go', async () => {
    const p = framedPage({ attached: false })
    let err = null
    try {
      await pressKey(p.page, 'a', vi.fn(), {}, p.frames)
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: 'field_not_visible', message: OPAQUE_REFUSAL })
    expect(err.message).toMatch(/browser_click with x\/y/)
    expect(err.message).toMatch(/arrows, Enter, Escape/)
    const sendInput = vi.fn(async () => {})
    await pressKey(p.page, 'ArrowUp', sendInput, {}, p.frames)
    await pressKey(p.page, 'Enter', sendInput, {}, p.frames)
    expect(sendInput.mock.calls.map(([e]) => `${e.type}:${e.keyCode}`)).toEqual(['keyDown:Up', 'keyUp:Up', 'keyDown:Enter', 'char:\r', 'keyUp:Enter'])
  })
})
