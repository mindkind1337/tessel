import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { pickerScript, clampPickPayload, redactSecrets, PICK_BUDGET, PICK_HOST_ID } from '../browserPicker'

// Runs a picker script the way executeJavaScript does: an expression whose
// value (a promise) is returned.
function run (action) {
  // eslint-disable-next-line no-new-func
  return new Function(`return ${pickerScript(action)}`)()
}

function stubRect (el, r) {
  el.getBoundingClientRect = () => ({
    x: r.x, y: r.y, width: r.width, height: r.height,
    top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height
  })
}

function mouse (type, x = 15, y = 25) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y })
}

// jsdom marks every dispatchEvent() untrusted, like a browser does for a
// page's own events. The user's real input: dispatched the way jsdom does it
// for its own events, with isTrusted set.
function trusted (target, event) {
  const impl = Object.getOwnPropertySymbols(event).find((s) => s.description === 'impl')
  event[impl].isTrusted = true
  target[impl]._dispatch(event[impl])
  return event
}

const host = () => document.getElementById(PICK_HOST_ID)

describe('pickerScript', () => {
  let originalFromPoint
  let pageEvents

  beforeEach(() => {
    originalFromPoint = document.elementFromPoint
    history.replaceState(null, '', '/settings/profile?access_token=abc#frag')
    document.title = 'Profile settings'
    document.body.innerHTML = `
      <main role="main" class="page">
        <p>Intro text</p>
        <form class="form">
          <button id="save" class="btn primary css-1a2b3c" aria-label="Save changes" onclick="evil()" data-x="1"
            href="/go?session_id=1" title="Save">Save <b>now</b><img src="/a.png?sig=1#x"><script>steal()</script></button>
          <input type="hidden" name="csrf_token" value="tok123">
        </form>
        <p>After   the
          button</p>
      </main>`
    pageEvents = []
    const btn = document.getElementById('save')
    stubRect(btn, { x: 10, y: 20, width: 100, height: 30 })
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'contextmenu']) {
      btn.addEventListener(type, () => pageEvents.push(`btn:${type}`))
      document.addEventListener(type, () => pageEvents.push(`doc:${type}`))
    }
    document.elementFromPoint = () => btn
  })

  afterEach(async () => {
    await run('teardown')
    document.elementFromPoint = originalFromPoint
    delete window.__tesselPick
  })

  it('rejects an unknown action', () => {
    expect(() => pickerScript('nope')).toThrow()
  })

  it('installs a full-viewport overlay with a closed shadow root', async () => {
    const p = run('arm')
    const h = host()
    expect(h).toBeTruthy()
    expect(h.parentNode).toBe(document.documentElement)
    expect(h.shadowRoot).toBe(null)
    expect(h.style.getPropertyValue('position')).toBe('fixed')
    expect(h.style.getPropertyValue('z-index')).toBe('2147483647')
    expect(h.style.getPropertyValue('pointer-events')).toBe('all')
    expect(h.style.getPropertyValue('cursor')).toBe('crosshair')
    expect(typeof window.__tesselPick.cancel).toBe('function')
    window.__tesselPick.cancel()
    expect(await p).toEqual({ cancelled: true })
  })

  it('hit-tests under the overlay, blocks the page and resolves the payload of the clicked element', async () => {
    const btn = document.getElementById('save')
    const pointerDuringHitTest = []
    document.elementFromPoint = () => {
      pointerDuringHitTest.push(host().style.getPropertyValue('pointer-events'))
      return btn
    }
    const p = run('arm')
    const h = host()
    trusted(h, mouse('mousemove'))
    expect(pointerDuringHitTest).toEqual(['none'])
    expect(h.style.getPropertyValue('pointer-events')).toBe('all')
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'contextmenu']) {
      const ev = trusted(h, mouse(type))
      expect(ev.defaultPrevented).toBe(true)
    }
    const click = trusted(h, mouse('click'))
    expect(click.defaultPrevented).toBe(true)
    // Removed before the promise settles, so a screenshot never shows it.
    expect(host()).toBe(null)
    expect(window.__tesselPick).toBeUndefined()

    const res = await p
    expect(pageEvents).toEqual([])
    expect(res.url).toBe('http://localhost:3000/settings/profile')
    expect(res.title).toBe('Profile settings')
    expect(res.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight })
    expect(res.scroll).toEqual({ x: 0, y: 0 })
    expect(res.devicePixelRatio).toBe(1)
    const el = res.element
    expect(el.tag).toBe('button')
    expect(el.selector).toBe('button#save')
    expect(el.path).toBe('main[role="main"] > .form > #save')
    expect(el.fullPath).toBe('body > main.page > form.form > button#save')
    expect(el.classes).toBe('btn primary css-1a2b3c')
    expect(el.role).toBe('button')
    expect(el.accessibleName).toBe('Save changes')
    // The script inside is not text the element shows.
    expect(el.text).toBe('Save now')
    expect(el.selectedText).toBe(null)
    expect(el.html).not.toContain('<script')
    expect(el.html).not.toContain('data-x')
    expect(el.html).not.toContain('session_id')
    expect(el.html).toContain('href="[redacted]"')
    expect(el.html).toContain('src="/a.png"')
    expect(el.attributes).toEqual({
      id: 'save',
      class: 'btn primary css-1a2b3c',
      'aria-label': 'Save changes',
      href: '[redacted]',
      title: 'Save'
    })
    expect(el.rect).toEqual({ x: 10, y: 20, width: 100, height: 30 })
    expect(Object.keys(el.styles)).toHaveLength(16)
    expect(el.react).toBe(null)
    expect(el.source).toBe(null)
    expect(el.ancestors).toEqual(['form', 'main[role=main]', 'body'])
    expect(el.nearbyText).toEqual([])
  })

  it('falls back to the element under the click point, and reads siblings, selection and React', async () => {
    document.body.innerHTML = `
      <ul><li>One</li><li id="two">Two <em>items</em></li><li>Three</li></ul>
      <div class="a"></div><div class="a"></div>`
    const li = document.getElementById('two')
    li.removeAttribute('id')
    stubRect(li, { x: 1, y: 2, width: 3, height: 4 })
    function Button () {}
    li.__reactFiber$abc = {
      type: 'li',
      return: {
        type: Button,
        _debugSource: { fileName: 'webpack-internal:///./src/Button.jsx?x=1', lineNumber: 12, columnNumber: 4 },
        return: { type: { displayName: 'ThemeProvider' }, return: { type: { name: 'App' }, return: null } }
      }
    }
    const range = document.createRange()
    range.selectNodeContents(li)
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
    document.elementFromPoint = () => li

    const p = run('arm')
    trusted(host(), mouse('click'))
    const { element: el } = await p
    window.getSelection().removeAllRanges()
    expect(el.tag).toBe('li')
    expect(el.selector).toBe('li:nth-of-type(2)')
    expect(el.nearbyText).toEqual(['One', 'Three'])
    expect(el.selectedText).toBe('Two items')
    expect(el.react).toBe('<App> <Button>')
    expect(el.source).toBe('src/Button.jsx:12:4')
  })

  it('ignores html/body and keeps picking', async () => {
    document.elementFromPoint = () => document.body
    const p = run('arm')
    trusted(host(), mouse('mousemove'))
    trusted(host(), mouse('click'))
    expect(host()).toBeTruthy()
    window.__tesselPick.cancel()
    expect(await p).toEqual({ cancelled: true })
  })

  it('Escape resolves cancelled and removes the overlay', async () => {
    const p = run('arm')
    const ev = trusted(document.body, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(ev.defaultPrevented).toBe(true)
    expect(host()).toBe(null)
    expect(await p).toEqual({ cancelled: true })
  })

  it('teardown cancels a pending pick', async () => {
    const p = run('arm')
    expect(await run('teardown')).toBe(true)
    expect(host()).toBe(null)
    expect(await p).toEqual({ cancelled: true })
  })

  it('replaces a hostile window.__tesselPick and a planted host', async () => {
    const calls = []
    const hostile = { cancel: () => calls.push('cancel'), extractPayload: () => ({ fake: true }) }
    window.__tesselPick = hostile
    const planted = document.createElement('div')
    planted.id = PICK_HOST_ID
    document.body.appendChild(planted)

    const p = run('arm')
    expect(calls).toEqual(['cancel'])
    expect(window.__tesselPick).not.toBe(hostile)
    expect(planted.isConnected).toBe(false)
    expect(document.querySelectorAll(`#${PICK_HOST_ID}`)).toHaveLength(1)
    trusted(host(), mouse('mousemove'))
    trusted(host(), mouse('click'))
    const res = await p
    expect(res.fake).toBeUndefined()
    expect(res.element.tag).toBe('button')
  })

  it('re-arming cancels the previous pick', async () => {
    const first = run('arm')
    const second = run('arm')
    expect(await first).toEqual({ cancelled: true })
    expect(document.querySelectorAll(`#${PICK_HOST_ID}`)).toHaveLength(1)
    window.__tesselPick.cancel()
    expect(await second).toEqual({ cancelled: true })
  })

  it('the page\'s own events neither move the pick nor make it, and never reach the page', async () => {
    const btn = document.getElementById('save')
    let hitTests = 0
    document.elementFromPoint = () => {
      hitTests++
      return btn
    }
    const p = run('arm')
    const h = host()
    h.dispatchEvent(mouse('mousemove'))
    expect(hitTests).toBe(0)
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick']) {
      const ev = mouse(type)
      h.dispatchEvent(ev)
      // Still kept from the page, but no pick.
      expect(ev.defaultPrevented).toBe(true)
    }
    h.click()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(pageEvents).toEqual([])
    expect(host()).toBe(h)
    expect(typeof window.__tesselPick.cancel).toBe('function')
    let settled = false
    p.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 150))
    expect(settled).toBe(false)

    // The user's own click picks.
    trusted(h, mouse('click'))
    expect(hitTests).toBe(1)
    expect((await p).element.tag).toBe('button')
  })

  it('redacts secrets wherever the page puts them, and never reads scripts, styles or templates', async () => {
    history.replaceState(null, '', '/reset/Ab3dEf5gH7jK9mN1pQ3rS5tU?x=1')
    document.title = 'Home AKIAABCDEFGHIJKLMNOP'
    document.body.innerHTML = `
      <p>Key sk-ant-api03-REALLOOKINGKEY here</p>
      <div id="target" class="card" data-token="abc" data-user="bob" title="ghp_abcdefghijklmnopqrstuvwxyz123456"
        aria-label="Bearer abcdefghijklmnop">Hello eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig123456 and password=hunter2
        <input value="typed words"><textarea>draft text</textarea>
        <style>.leak{}</style><noscript>ns text</noscript><template><b>tpl</b></template>
        <!-- comment AKIAABCDEFGHIJKLMNOP -->
        <a href="https://user:pw@site.test/reset/Ab3dEf5gH7jK9mN1pQ3rS5tU?x=1">link</a>
        <img srcset="/a.png?sig=1 1x, /b.png?sig=2 2x">
        <span title="0123456789abcdef0123456789abcdef">hex</span>
      </div>
      <script>var leak = 'script text'</script>
      <noscript>nearby noscript</noscript>
      <p>Nearby xoxb-1234567890-abcdef</p>`
    const target = document.getElementById('target')
    stubRect(target, { x: 0, y: 0, width: 10, height: 10 })
    document.elementFromPoint = () => target
    const p = run('arm')
    trusted(host(), mouse('click'))
    const res = await p
    const el = res.element
    expect(res.url).toBe('http://localhost:3000/reset/[redacted]')
    expect(res.title).toBe('Home [redacted]')
    expect(el.text).toContain('Hello [redacted] and password=[redacted]')
    for (const leak of ['eyJ', 'hunter2', '.leak', 'ns text', 'tpl']) expect(el.text).not.toContain(leak)
    expect(el.accessibleName).toBe('[redacted]')
    expect(el.attributes.title).toBe('[redacted]')
    expect(Object.keys(el.attributes).some((k) => k.startsWith('data-'))).toBe(false)
    for (const leak of ['data-token', 'data-user', '<style', '<noscript', '<template', '<!--', 'AKIA', 'ghp_', 'typed words', 'draft text', 'user:pw', 'sig=', 'eyJ', 'hunter2', '0123456789abcdef']) {
      expect(el.html).not.toContain(leak)
    }
    expect(el.html).toContain('value="[redacted]"')
    expect(el.html).toContain('<textarea>[redacted]</textarea>')
    expect(el.html).toContain('href="https://site.test/reset/[redacted]"')
    expect(el.html).toContain('srcset="/a.png 1x, /b.png 2x"')
    expect(el.nearbyText).toEqual(['Key [redacted] here', 'Nearby [redacted]'])
  })

  it('resolves through the engine promise even when the page replaced Promise', async () => {
    // A subclass, so jsdom's own internals (which use the global) keep working;
    // the script itself must never name the global Promise.
    const NativePromise = Promise
    globalThis.Promise = class PagePromise extends NativePromise {
      constructor (fn) {
        super(fn)
      }
    }
    let p
    try {
      p = run('arm')
      window.__tesselPick.cancel()
    } finally {
      globalThis.Promise = NativePromise
    }
    expect(Object.getPrototypeOf(p)).toBe(NativePromise.prototype)
    expect(await p).toEqual({ cancelled: true })
    expect(pickerScript('arm')).not.toMatch(/(?<![.\w])Promise\s*[.(]|new Promise/)
  })
})

describe('clampPickPayload', () => {
  const good = () => ({
    url: 'https://example.com/a/b?token=1#h',
    title: 'Page',
    viewport: { width: 800, height: 600 },
    scroll: { x: 0, y: 10 },
    devicePixelRatio: 2,
    element: {
      tag: 'button',
      selector: 'button#save',
      path: '#save',
      fullPath: 'main > button#save',
      classes: 'btn',
      role: 'button',
      accessibleName: 'Save',
      text: 'Save',
      selectedText: null,
      html: '<button id="save">Save</button>',
      attributes: { id: 'save' },
      rect: { x: 1, y: 2, width: 3, height: 4 },
      styles: { display: 'block' },
      react: '<App>',
      source: 'src/App.jsx:1:2',
      ancestors: ['main'],
      nearbyText: ['Hello']
    }
  })

  it('keeps a well-formed payload', () => {
    const out = clampPickPayload(good())
    expect(out.url).toBe('https://example.com/a/b')
    expect(out.devicePixelRatio).toBe(2)
    expect(out.element.selector).toBe('button#save')
    expect(out.element.styles.display).toBe('block')
    expect(out.element.styles.zIndex).toBe('')
    expect(Object.keys(out.element.styles)).toHaveLength(16)
    expect(out.element.attributes).toEqual({ id: 'save' })
  })

  it('passes cancellation through and rejects non-picks', () => {
    expect(clampPickPayload({ cancelled: true, extra: 1 })).toEqual({ cancelled: true })
    expect(clampPickPayload(null)).toBe(null)
    expect(clampPickPayload('x')).toBe(null)
    expect(clampPickPayload([])).toBe(null)
    expect(clampPickPayload({ error: 'extract-failed' })).toBe(null)
    expect(clampPickPayload({ element: 'button' })).toBe(null)
    expect(clampPickPayload({ element: { tag: 42 } })).toBe(null)
    const throwing = { get element () { throw new Error('boom') } }
    expect(clampPickPayload(throwing)).toBe(null)
  })

  it('re-clamps every budget', () => {
    const raw = good()
    const huge = 'x'.repeat(100000)
    Object.assign(raw.element, {
      selector: huge, path: huge, classes: huge, text: huge, selectedText: huge,
      html: huge, react: huge, source: huge, accessibleName: huge
    })
    raw.title = huge
    raw.element.ancestors = Array(50).fill(huge)
    raw.element.nearbyText = Array(50).fill(huge)
    const attributes = {}
    for (let i = 0; i < 40; i++) attributes[`aria-x${String.fromCharCode(97 + (i % 26))}${i > 25 ? 'b' : ''}`] = huge
    raw.element.attributes = attributes
    const el = clampPickPayload(raw).element
    const suffix = ' (truncated)'.length
    expect(el.selector.length).toBe(PICK_BUDGET.selector + suffix)
    expect(el.path.length).toBe(PICK_BUDGET.path + suffix)
    expect(el.classes.length).toBe(PICK_BUDGET.classes + suffix)
    expect(el.text.length).toBe(PICK_BUDGET.text + suffix)
    expect(el.selectedText.length).toBe(PICK_BUDGET.selectedText + suffix)
    expect(el.html.length).toBe(PICK_BUDGET.html + suffix)
    expect(el.react.length).toBe(PICK_BUDGET.react + suffix)
    expect(el.source.length).toBe(PICK_BUDGET.source + suffix)
    expect(clampPickPayload(raw).title.length).toBe(PICK_BUDGET.title + suffix)
    expect(el.ancestors).toHaveLength(PICK_BUDGET.ancestors)
    expect(el.nearbyText).toHaveLength(PICK_BUDGET.nearbyText)
    expect(el.nearbyText[0].length).toBe(PICK_BUDGET.nearbyTextEntry + suffix)
    expect(Object.keys(el.attributes)).toHaveLength(PICK_BUDGET.attributes)
    expect(Object.values(el.attributes)[0].length).toBe(PICK_BUDGET.attributeValue + suffix)
  })

  it('fixes wrong types and non-finite numbers, drops unknown keys', () => {
    const raw = good()
    raw.viewport = { width: 'wide', height: Infinity }
    raw.scroll = null
    raw.devicePixelRatio = NaN
    raw.title = { toString: () => 'x' }
    raw.extra = 'nope'
    raw.element.rect = { x: NaN, y: '5', width: 1e400, height: -3 }
    raw.element.styles = { display: 42, color: 'red', evil: 'x' }
    raw.element.ancestors = 'main'
    raw.element.nearbyText = [1, null, 'ok', { a: 1 }]
    raw.element.onclick = 'x'
    raw.element.selectedText = 12
    const out = clampPickPayload(raw)
    expect(out.viewport).toEqual({ width: 0, height: 0 })
    expect(out.scroll).toEqual({ x: 0, y: 0 })
    expect(out.devicePixelRatio).toBe(1)
    expect(out.title).toBe('')
    expect(out.extra).toBeUndefined()
    expect(out.element.onclick).toBeUndefined()
    expect(out.element.rect).toEqual({ x: 0, y: 0, width: 0, height: -3 })
    expect(out.element.styles.display).toBe('')
    expect(out.element.styles.color).toBe('red')
    expect(out.element.styles.evil).toBeUndefined()
    expect(out.element.ancestors).toEqual([])
    expect(out.element.nearbyText).toEqual(['ok'])
    expect(out.element.selectedText).toBe(null)
  })

  it('sanitizes the url', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'not a url', 42, 'https://x.com/' + 'a'.repeat(70000)]) {
      expect(clampPickPayload({ ...good(), url }).url).toBe('')
    }
    expect(clampPickPayload({ ...good(), url: 'http://a.test/p?q=1#x' }).url).toBe('http://a.test/p')
  })

  it('re-filters attributes and redacts secrets', () => {
    const raw = good()
    raw.element.attributes = {
      onclick: 'alert(1)',
      style: 'color:red',
      __proto__x: 'x',
      'aria-label': 'Close',
      'aria-<script>': 'x',
      ID: 'main',
      name: 'client_secret_field',
      href: 'https://a.test/cb?code=1#t',
      src: 'javascript:alert(1)',
      action: '/submit?next=/x',
      title: 42,
      placeholder: 'Your PASSWORD'
    }
    raw.element.path = 'form > input[name=csrf]'
    raw.element.accessibleName = 'my api_key'
    raw.element.nearbyText = ['fine', 'the secret is 42']
    const el = clampPickPayload(raw).element
    expect(el.attributes).toEqual({
      'aria-label': 'Close',
      id: 'main',
      name: '[redacted]',
      href: 'https://a.test/cb',
      src: '',
      action: '/submit',
      placeholder: '[redacted]'
    })
    expect(el.path).toBe('[redacted]')
    expect(el.accessibleName).toBe('[redacted]')
    expect(el.nearbyText).toEqual(['fine', '[redacted]'])
  })

  it('redacts tokens a lying page left in, wherever they are', () => {
    const raw = good()
    raw.url = 'https://user:pw@a.test/reset/Ab3dEf5gH7jK9mN1pQ3rS5tU/x?t=1#h'
    raw.title = 'Key sk-ant-api03-abcdefghijkl'
    Object.assign(raw.element, {
      selector: 'div#ghp_abcdefghijklmnopqrstuvwxyz0123',
      text: 'token: abc123 and AKIAABCDEFGHIJKLMNOP',
      selectedText: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc',
      accessibleName: 'Accept cookies',
      html: '<div data-token="x" data-a=\'y\' title="ok" value="typed"><script>steal()</script><style>.x{}</style>' +
        '<noscript>n</noscript><template>t</template><!-- c --><textarea>draft</textarea>' +
        '<a href="https://u:p@x.test/p?q=1">l</a><img srcset="/a.png?s=1 1x"> ghp_abcdefghijklmnopqrstuvwxyz0123 <script>unclosed',
      attributes: { 'aria-token': 'x', title: 'Bearer abcdefghijkl', alt: 'see 0123456789abcdef0123456789abcdef' },
      nearbyText: ['fine', 'xoxp-1234567890-abc'],
      ancestors: ['div[role=token]', 'main']
    })
    const out = clampPickPayload(raw)
    const el = out.element
    expect(out.url).toBe('https://a.test/reset/[redacted]/x')
    expect(out.title).toBe('Key [redacted]')
    expect(el.selector).toBe('div#[redacted]')
    expect(el.text).toBe('token: [redacted] and [redacted]')
    expect(el.selectedText).toBe('[redacted]')
    expect(el.accessibleName).toBe('[redacted]')
    expect(el.html).toBe('<div title="ok" value="[redacted]"><textarea>[redacted]</textarea>' +
      '<a href="https://x.test/p">l</a><img srcset="/a.png 1x"> [redacted] ')
    expect(el.attributes).toEqual({ 'aria-token': '[redacted]', title: '[redacted]', alt: 'see [redacted]' })
    expect(el.nearbyText).toEqual(['fine', '[redacted]'])
    expect(el.ancestors).toEqual(['[redacted]', 'main'])
  })
})

describe('redactSecrets', () => {
  it('cuts out keys, tokens and secrets\' values where they stand', () => {
    const cases = [
      ['key sk-ant-api03-AbCdEf123456', 'key [redacted]'],
      ['sk-proj-abcdefghijklmnopqrstuvwx', '[redacted]'],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123 gho_abcdefghijklmnopqrstuvwxyz0123', '[redacted] [redacted]'],
      ['github_pat_11ABCDEFG0123456789_abcdefghijk', '[redacted]'],
      ['xoxb-1234567890-abcdef', '[redacted]'],
      ['AKIAABCDEFGHIJKLMNOP', '[redacted]'],
      ['Authorization: Bearer abc.def-ghi_jkl', 'Authorization: [redacted]'],
      ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'jwt [redacted]'],
      ['password=hunter2&x=1', 'password=[redacted]&x=1'],
      ['{"api_key": "abcd1234"}', '{"api_key": "[redacted]"}'],
      ['csrf_token: 123abc', 'csrf_token: [redacted]'],
      ['id 0123456789abcdef0123456789abcdef', 'id [redacted]'],
      ['uuid 550e8400-e29b-41d4-a716-446655440000-550e8400', 'uuid [redacted]'],
      ['b64 QWxhZGRpbjpvcGVuIHNlc2FtZQ12345678abcd==', 'b64 [redacted]']
    ]
    for (const [input, want] of cases) expect(redactSecrets(input)).toBe(want)
  })

  it('keeps ordinary text, and stays fast on a long one', () => {
    const ordinary = ['Hello world', 'a-very-long-css-class-name-for-some-component', 'index-2024-annual-report.pdf', 'Session expired']
    for (const text of ordinary) expect(redactSecrets(text)).toBe(text)
    expect(redactSecrets(42)).toBe('')
    const started = Date.now()
    redactSecrets('token'.repeat(13000))
    redactSecrets('a'.repeat(64 * 1024))
    redactSecrets('<a x="'.repeat(10000))
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
