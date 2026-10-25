import { describe, it, expect, afterEach } from 'vitest'
import { installFocusWatch, shortStack, describeEl } from '../focusWatch'

// The browser's own focus(), before the watch wraps it.
const nativeFocus = HTMLElement.prototype.focus
let off = null
afterEach(() => {
  if (off) off()
  off = null
  document.body.innerHTML = ''
})

function setup() {
  document.body.innerHTML = `
    <div class="pane" data-pane-id="pane-1"><textarea class="xterm-helper-textarea"></textarea></div>
    <div class="pane" data-pane-id="pane-2"><textarea class="xterm-helper-textarea"></textarea></div>
    <div class="board"><button class="card">Card</button></div>`
  const lines = []
  let t = 1000
  const clock = { now: () => t, add: (ms) => (t += ms) }
  off = installFocusWatch({ log: (s) => lines.push(s), now: clock.now, settleMs: 0 })
  const [a, b] = document.querySelectorAll('.xterm-helper-textarea')
  return { lines, clock, a, b, card: document.querySelector('.card') }
}
const key = (el, k = 'a', mods = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods }))
const settle = () => new Promise((r) => setTimeout(r, 5))

describe('focus watch', () => {
  it('logs the keyboard leaving a pane while typing, with the element and code that took it', async () => {
    const { lines, clock, a, card } = setup()
    a.focus()
    key(a)
    clock.add(300)
    card.focus()
    await settle()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('left pane-1 while typing')
    expect(lines[0]).toContain('now in button.card in .board')
    expect(lines[0]).toContain('last focus() on button.card')
  })

  it('says when the pane input was taken off the page (no focusout: the next key tells)', async () => {
    const { lines, clock, a } = setup()
    a.focus()
    key(a)
    a.parentNode.removeChild(a)
    clock.add(200)
    key(document.body)
    await settle()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('a key went elsewhere')
    expect(lines[0]).toContain('its input was taken off the page')
    expect(lines[0]).toContain('now in the page (no element)')
  })

  it('stays quiet after a click, a shortcut, or when the user was not typing', async () => {
    const { lines, clock, a, b, card } = setup()
    a.focus()
    key(a)
    window.dispatchEvent(new Event('pointerdown'))
    b.focus()
    await settle()
    clock.add(1000)
    key(b)
    key(b, 'Tab')
    card.focus()
    await settle()
    clock.add(1000)
    b.focus()
    clock.add(5000)
    a.focus()
    await settle()
    expect(lines).toEqual([])
  })

  describe('a browser page that takes the keyboard unasked', () => {
    function pageSetup() {
      document.body.innerHTML = `
        <div class="pane" data-pane-id="pane-1"><textarea class="xterm-helper-textarea"></textarea></div>
        <div class="pane browser-pane" data-pane-id="pane-web"><div data-test="browser-agent">Ada is driving</div></div>
        <div class="browser-host"><div class="bp-box" data-browser-page="pane-web"><webview class="bp-webview" tabindex="0"></webview></div></div>`
      const lines = []
      let t = 1000
      const clock = { now: () => t, add: (ms) => (t += ms) }
      off = installFocusWatch({ log: (s) => lines.push(s), now: clock.now, settleMs: 0 })
      const term = document.querySelector('.xterm-helper-textarea')
      const page = document.querySelector('webview')
      // jsdom draws nothing: give both a place on screen.
      term.getClientRects = () => [{}]
      page.getClientRects = () => [{}]
      page.getBoundingClientRect = () => ({ left: 500, right: 900, top: 0, bottom: 400, width: 400, height: 400 })
      return { lines, clock, term, page }
    }
    // The page takes the keyboard by itself (an agent's click, its own field
    // focused on load): no focus() from Tessel's code.
    const pageTakes = (page) => nativeFocus.call(page)

    it('gives it back to where the user was typing, and says so', async () => {
      const { lines, clock, term, page } = pageSetup()
      term.focus()
      key(term)
      clock.add(2000)
      pageTakes(page)
      expect(document.activeElement).toBe(page)
      await settle()
      expect(document.activeElement).toBe(term)
      expect(lines[0]).toContain('a browser page (pane-web) took the keyboard without a click; given back to textarea.xterm-helper-textarea in pane-1')
    })

    it('a page no agent drives keeps it unless the user is typing; one out of sight gives it back anyway', async () => {
      const { lines, clock, term, page } = pageSetup()
      document.querySelector('[data-test="browser-agent"]').remove()
      // Typed a while ago: the page keeps it.
      term.focus()
      key(term)
      clock.add(5000)
      pageTakes(page)
      await settle()
      expect(document.activeElement).toBe(page)
      // Typing now: given back.
      term.focus()
      key(term)
      clock.add(500)
      pageTakes(page)
      await settle()
      expect(document.activeElement).toBe(term)
      // Out of sight, typed a while ago: given back.
      page.parentElement.style.visibility = 'hidden' // its workspace is not shown
      clock.add(5000)
      pageTakes(page)
      await settle()
      expect(document.activeElement).toBe(term)
      expect(lines.filter((l) => l.includes('given back to'))).toHaveLength(2)
      expect(lines.at(-1)).toContain('out of sight')
    })

    // A page drawn unseen for an agent (browser/pageHost.js: visible, laid
    // over the user's view at 1%) is out of sight all the same, even with the
    // mouse over where it lies.
    it('a page drawn unseen for an agent counts as out of sight', async () => {
      const { lines, clock, term, page } = pageSetup()
      document.querySelector('[data-test="browser-agent"]').remove()
      page.parentElement.classList.add('bp-unseen')
      term.focus()
      key(term)
      clock.add(5000)
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 600, clientY: 100 }))
      pageTakes(page)
      await settle()
      expect(document.activeElement).toBe(term)
      expect(lines.at(-1)).toContain('out of sight')
    })

    it('leaves it to the page after a click on it, a shortcut, the window coming back, or Tessel focusing it', async () => {
      const { lines, clock, term, page } = pageSetup()
      // The mouse went over the page (a click in it).
      term.focus()
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 520, clientY: 100 }))
      pageTakes(page)
      await settle()
      expect(document.activeElement).toBe(page)
      // A shortcut.
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10 }))
      term.focus()
      clock.add(2000)
      key(term, 'ArrowRight', { altKey: true })
      pageTakes(page)
      await settle()
      expect(document.activeElement).toBe(page)
      // The window comes back from another program.
      term.focus()
      clock.add(2000)
      window.dispatchEvent(new FocusEvent('focus'))
      pageTakes(page)
      await settle()
      expect(document.activeElement).toBe(page)
      // Tessel's own code.
      term.focus()
      clock.add(2000)
      page.focus()
      await settle()
      expect(document.activeElement).toBe(page)
      expect(lines).toEqual([])
    })
  })

  it('restores focus() and blur() when removed', () => {
    const before = HTMLElement.prototype.focus
    const stop = installFocusWatch({ log: () => {} })
    expect(HTMLElement.prototype.focus).not.toBe(before)
    stop()
    expect(HTMLElement.prototype.focus).toBe(before)
  })

  it('shortens stacks and describes elements', () => {
    const stack = 'Error\n    at HTMLElement.focus (http://localhost:5173/src/focusWatch.js?t=1:3:1)\n    at termFocus (http://localhost:5173/src/components/TerminalPane.vue?t=12:945:7)\n    at onMounted (http://localhost:5173/src/App.vue:9:1)'
    expect(shortStack(stack)).toBe('termFocus (src/components/TerminalPane.vue:945:7) < onMounted (src/App.vue:9:1)')
    expect(describeEl(null)).toBe('nothing')
  })
})
