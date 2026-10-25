// A page out of sight drawn, unseen, while an agent drives it or captures it
// (browser/pageHost.js keepDrawn / revealPage), and the agents' way to ask
// for it (browser/agentBrowserTargets.js op "paint").
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claimPage, placePage, revealPage, endCapture, keepDrawn, releasePage, _resetPagesForTests, REVEAL_OPACITY, UNSEEN_CLASS } from '../browser/pageHost'
import { createAgentBrowserTargets } from '../browser/agentBrowserTargets'

// jsdom lays nothing out: the boxes' rectangles are given here. A hidden
// workspace layer is moved 3840 px to the left (style.css); the box's own
// translate moves it back.
function laidOut(box, layer, place = { left: 0, top: 0, width: 640, height: 480 }) {
  const shift = () => (layer.classList.contains('hidden') || document.documentElement.classList.contains('window-hidden') ? -3840 : 0)
  box.getBoundingClientRect = () => {
    const t = String(box.style.translate || '').match(/(-?\d+)px(?:\s+(-?\d+)px)?/)
    const dx = t ? Number(t[1]) : 0
    const dy = t && t[2] ? Number(t[2]) : 0
    const width = parseFloat(box.style.width) || 0
    const height = parseFloat(box.style.height) || 0
    const left = place.left + shift() + dx
    const top = place.top + dy
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }
  }
  Object.defineProperty(box, 'offsetWidth', { configurable: true, get: () => parseFloat(box.style.width) || 0 })
  Object.defineProperty(box, 'offsetHeight', { configurable: true, get: () => parseFloat(box.style.height) || 0 })
}
const rect = (left, top, width, height) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('a page drawn unseen for an agent (pageHost.js)', () => {
  let layer, host, area, page

  beforeEach(() => {
    _resetPagesForTests()
    document.documentElement.classList.remove('window-hidden')
    layer = document.createElement('div')
    layer.className = 'ws-layer hidden'
    host = document.createElement('div')
    host.className = 'browser-host'
    area = document.createElement('div')
    layer.append(area, host)
    document.body.appendChild(layer)
    host.getBoundingClientRect = rect(0, 0, 1280, 800)
    area.getBoundingClientRect = rect(0, 0, 640, 480)
    page = claimPage('p1', host, 'https://example.com/', 'owner').page
    laidOut(page.box, layer)
    placePage(page, area)
  })
  afterEach(() => {
    _resetPagesForTests()
    layer.remove()
    document.documentElement.classList.remove('window-hidden')
  })

  const placed = () => page.box.getAttribute('style')

  it('a capture of a page in a hidden project: laid in the viewport, nearly transparent, no pointer; put back after', () => {
    const before = placed()
    const r = revealPage(page)
    expect(r).toEqual({ moved: true, why: 'layer' })
    const s = page.box.style
    expect(s.visibility).toBe('visible')
    expect(s.opacity).toBe(REVEAL_OPACITY)
    expect(Number(REVEAL_OPACITY)).toBeLessThanOrEqual(0.01)
    expect(s.pointerEvents).toBe('none')
    expect(page.box.getBoundingClientRect().left).toBe(0)
    expect(s.width).toBe('640px')
    endCapture(page)
    expect(placed()).toBe(before)
  })

  it('a page on screen is left as it is', () => {
    layer.classList.remove('hidden')
    const before = placed()
    expect(revealPage(page)).toEqual({ moved: false, why: null })
    expect(placed()).toBe(before)
    endCapture(page)
    expect(placed()).toBe(before)
  })

  it('kept drawn while an agent drives it; its project shown: at its own place at once; hidden again: drawn again', async () => {
    const before = placed()
    keepDrawn(page, true)
    expect(page.box.style.opacity).toBe(REVEAL_OPACITY)
    // The user opens that project: a class changes on an ancestor, looked at again before the window draws.
    layer.classList.remove('hidden')
    await tick()
    expect(page.box.style.opacity).toBe('')
    expect(page.box.style.translate).toBe('')
    expect(page.box.getBoundingClientRect().left).toBe(0)
    layer.classList.add('hidden')
    await tick()
    expect(page.box.style.opacity).toBe(REVEAL_OPACITY)
    keepDrawn(page, false)
    expect(placed()).toBe(before)
  })

  it('the window minimized: not kept drawn (nothing is drawn then), only for a capture', async () => {
    keepDrawn(page, true)
    document.documentElement.classList.add('window-hidden')
    await tick()
    expect(page.box.style.opacity).toBe('')
    expect(revealPage(page)).toEqual({ moved: true, why: 'window' })
    expect(page.box.style.opacity).toBe(REVEAL_OPACITY)
    endCapture(page)
    expect(page.box.style.opacity).toBe('')
    // Back on screen: drawn again while the agent drives it.
    document.documentElement.classList.remove('window-hidden')
    await tick()
    expect(page.box.style.opacity).toBe(REVEAL_OPACITY)
  })

  it('placed again while drawn (a layout change): still drawn, from its new place', () => {
    keepDrawn(page, true)
    area.getBoundingClientRect = rect(100, 40, 500, 400)
    placePage(page, area)
    expect(page.box.style.left).toBe('100px')
    expect(page.box.style.width).toBe('500px')
    expect(page.box.style.opacity).toBe(REVEAL_OPACITY)
  })

  it('a pane squeezed to nothing keeps its page at its last size (never a 0x0 viewport)', () => {
    layer.classList.remove('hidden')
    area.getBoundingClientRect = rect(0, 0, 0, 0)
    placePage(page, area)
    expect(page.box.style.width).toBe('640px')
    expect(page.box.style.height).toBe('480px')
    expect(page.box.style.visibility).toBe('hidden')
  })

  it('while drawn unseen it takes no click, no focus and is hidden from screen readers; all put back after', () => {
    const btn = document.createElement('button')
    page.overlay.appendChild(btn)
    page.webview.setAttribute('tabindex', '0')
    page.webview.focus()
    const blur = vi.spyOn(page.webview, 'blur')
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => page.webview })
    try {
      keepDrawn(page, true)
    } finally {
      delete document.activeElement
    }
    expect(page.box.classList.contains(UNSEEN_CLASS)).toBe(true)
    expect(page.box.getAttribute('aria-hidden')).toBe('true')
    expect(page.overlay.inert).toBe(true)
    expect(page.webview.getAttribute('tabindex')).toBe('-1')
    expect(blur).toHaveBeenCalled()
    keepDrawn(page, false)
    expect(page.box.classList.contains(UNSEEN_CLASS)).toBe(false)
    expect(page.box.hasAttribute('aria-hidden')).toBe(false)
    expect(page.overlay.inert).toBe(false)
    expect(page.webview.getAttribute('tabindex')).toBe('0')
  })

  it('style.css: nothing in an unseen box takes the pointer, Tessel\'s own panels included', () => {
    const css = readFileSync(join(__dirname, '..', 'style.css'), 'utf8')
    const rule = css.match(/\.bp-box\.bp-unseen,\s*\.bp-box\.bp-unseen \*\s*\{([^}]*)\}/)
    expect(rule).toBeTruthy()
    expect(rule[1]).toMatch(/pointer-events:\s*none\s*!important/)
  })

  it('a capture never ended ends by itself; ended by its own token only', async () => {
    vi.useFakeTimers()
    try {
      const before = placed()
      revealPage(page, 'cap-1', 15000)
      revealPage(page, 'cap-2', 15000)
      expect(endCapture(page, 'other')).toBe(false)
      expect(endCapture(page, 'cap-1')).toBe(true)
      expect(page.box.style.opacity).toBe(REVEAL_OPACITY)
      vi.advanceTimersByTime(15001)
      expect(placed()).toBe(before)
      expect(page.captures.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('its pane closed: nothing kept', () => {
    keepDrawn(page, true)
    releasePage('p1', 'owner')
    expect(page.keep).toBe(false)
    expect(page.box.style.opacity).toBe('')
    expect(page.box.style.visibility).toBe('hidden')
  })
})

describe('an agent asks for its page drawn for a capture (agentBrowserTargets.js)', () => {
  const leaf = (id, kind) => ({ type: 'leaf', id, kind })
  const forEachLeaf = (node, fn) => (node.type === 'leaf' ? fn(node) : node.children.forEach((c) => forEachLeaf(c, fn)))
  const wsA = { id: 'A', name: 'Game', tree: { type: 'split', children: [leaf('agent-a', 'agent'), leaf('browser-a', 'browser')] } }
  const wsB = { id: 'B', name: 'Other', tree: { type: 'split', children: [leaf('browser-b', 'browser')] } }
  const setup = ({ enabled = () => true } = {}) => {
    const paint = vi.fn((id, on) => (on ? { moved: true, why: 'layer' } : { moved: true, why: null }))
    const targets = createAgentBrowserTargets({
      enabled,
      workspaces: () => [wsA, wsB],
      forEachLeaf,
      sameView: () => true,
      guestOf: () => 1,
      paneLabel: () => 'Gauss',
      openPage: () => null,
      paint
    })
    return { targets, paint }
  }

  it('its own page only; says why it was out of sight and its project', async () => {
    const { targets, paint } = setup()
    expect(await targets.handle({ agent: 'agent-a', op: 'paint', page: 'browser-a', on: true, token: 'tok_1' })).toEqual({ agent: 'Gauss', page: 'browser-a', moved: true, why: 'layer', project: 'Game' })
    await targets.handle({ agent: 'agent-a', op: 'paint', page: 'browser-a', on: false, token: 'tok_1' })
    expect(paint.mock.calls).toEqual([
      ['browser-a', true, 'tok_1'],
      ['browser-a', false, 'tok_1']
    ])
    await expect(targets.handle({ agent: 'agent-a', op: 'paint', page: 'browser-b', on: true })).rejects.toMatchObject({ code: 'page_not_found' })
    expect(paint).toHaveBeenCalledTimes(2)
  })

  it('the end of a capture is always done: setting turned off, the agent\'s pane gone', async () => {
    let on = true
    const { targets, paint } = setup({ enabled: () => on })
    on = false
    expect(await targets.handle({ agent: 'gone-pane', op: 'paint', page: 'browser-a', on: false, token: 'tok_2' })).toMatchObject({ page: 'browser-a', moved: true })
    expect(paint).toHaveBeenCalledWith('browser-a', false, 'tok_2')
    // Its start is still refused while the setting is off.
    await expect(targets.handle({ agent: 'agent-a', op: 'paint', page: 'browser-a', on: true })).rejects.toMatchObject({ code: 'disabled' })
  })
})
