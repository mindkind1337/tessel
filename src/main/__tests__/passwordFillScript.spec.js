// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://site.example/login" }
// The password fill script (browserPasswords.js passwordFillScript), run in a
// page: the password goes only into the one login form whose every
// destination is the site itself, checked again on the live form after the
// username's input event ran the page's own scripts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { passwordFillScript } from '../browserPasswords'

const ENTRY = { origin: 'https://site.example', username: 'me', password: 'secret-1' }
const run = () => window.eval(passwordFillScript(ENTRY))

let rects
beforeEach(() => {
  // jsdom lays nothing out: every element counts as shown.
  rects = Element.prototype.getClientRects
  Element.prototype.getClientRects = () => [{}]
  document.body.innerHTML = ''
})
afterEach(() => {
  Element.prototype.getClientRects = rects
})

function loginForm({ action = '/session', extra = '' } = {}) {
  document.body.innerHTML = `<form id="f" action="${action}"><input id="u" type="email"><input id="p" type="password">${extra}<button id="go">Go</button></form>`
  return { form: document.getElementById('f'), username: document.getElementById('u'), password: document.getElementById('p') }
}

describe('passwordFillScript', () => {
  it('fills the one login form of the site, and never submits', () => {
    const { username, password } = loginForm()
    expect(run()).toEqual({ ok: true, submitted: false })
    expect(username.value).toBe('me')
    expect(password.value).toBe('secret-1')
  })

  it('a form that posts elsewhere gets nothing', () => {
    const { username, password } = loginForm({ action: 'https://evil.example/steal' })
    expect(run()).toEqual({ ok: false, code: 'unsafe-form' })
    expect(username.value).toBe('')
    expect(password.value).toBe('')
  })

  it('a submit button with a formaction elsewhere makes the form unsafe, even with a same-site action', () => {
    const { username, password } = loginForm({ extra: '<button type="submit" formaction="https://evil.example/steal">Also</button>' })
    expect(run()).toEqual({ ok: false, code: 'unsafe-form' })
    expect(username.value).toBe('')
    expect(password.value).toBe('')
    const ok = loginForm({ extra: '<input type="submit" formaction="/other-same-site">' })
    expect(run()).toEqual({ ok: true, submitted: false })
    expect(ok.password.value).toBe('secret-1')
  })

  it("the page's script moving the password field to another form on the username's input event: nothing goes in", () => {
    const { username, password } = loginForm()
    username.addEventListener('input', () => {
      const other = document.createElement('form')
      other.action = 'https://evil.example/steal'
      document.body.appendChild(other)
      other.appendChild(password)
    })
    expect(run()).toEqual({ ok: false, code: 'unsafe-form' })
    expect(password.value).toBe('')
  })

  it("the page's script pointing the form elsewhere on the username's input event: nothing goes in", () => {
    const { form, username, password } = loginForm()
    username.addEventListener('input', () => form.setAttribute('action', 'https://evil.example/steal'))
    expect(run()).toEqual({ ok: false, code: 'unsafe-form' })
    expect(password.value).toBe('')
    const button = loginForm()
    button.username.addEventListener('input', () => button.form.querySelector('button').setAttribute('formaction', 'https://evil.example/steal'))
    expect(run()).toEqual({ ok: false, code: 'unsafe-form' })
    expect(button.password.value).toBe('')
  })

  it('a <base href> pointing elsewhere makes a relative action foreign (resolved as the browser will)', () => {
    const { username, password } = loginForm()
    const base = document.createElement('base')
    base.setAttribute('href', 'https://evil.example/')
    document.head.appendChild(base)
    try {
      expect(run()).toEqual({ ok: false, code: 'unsafe-form' })
      expect(username.value).toBe('')
      expect(password.value).toBe('')
    } finally {
      base.remove()
    }
  })

  it('a submit button outside the form but tied to it (form=) with a foreign formaction makes it unsafe', () => {
    const { password } = loginForm()
    document.body.insertAdjacentHTML('beforeend', '<button form="f" formaction="https://evil.example/steal">Sign in</button>')
    expect(run()).toEqual({ ok: false, code: 'unsafe-form' })
    expect(password.value).toBe('')
  })

  it('a javascript: action is foreign; a control named "action" does not fool the check', () => {
    loginForm({ action: 'javascript:void(0)' })
    expect(run()).toEqual({ ok: false, code: 'unsafe-form' })
    const { password } = loginForm({ extra: '<input type="hidden" name="action" value="https://evil.example/">' })
    expect(run()).toEqual({ ok: true, submitted: false })
    expect(password.value).toBe('secret-1')
  })

  it('a username field inside the form but owned by another form is not used', () => {
    document.body.innerHTML = '<form id="other" action="https://evil.example/x"></form><form id="f" action="/session"><input id="u" type="email" form="other"><input id="p" type="password"><button>Go</button></form>'
    expect(run()).toEqual({ ok: true, submitted: false })
    expect(document.getElementById('u').value).toBe('')
    expect(document.getElementById('p').value).toBe('secret-1')
  })

  it('two password fields, or none: no login form', () => {
    document.body.innerHTML = '<form action="/a"><input type="password"><input type="password"></form>'
    expect(run()).toEqual({ ok: false, code: 'no-login-form' })
    document.body.innerHTML = '<form action="/a"><input type="text"></form>'
    expect(run()).toEqual({ ok: false, code: 'no-login-form' })
  })
})
