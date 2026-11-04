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

  it('two password fields, or none: no login form', () => {
    document.body.innerHTML = '<form action="/a"><input type="password"><input type="password"></form>'
    expect(run()).toEqual({ ok: false, code: 'no-login-form' })
    document.body.innerHTML = '<form action="/a"><input type="text"></form>'
    expect(run()).toEqual({ ok: false, code: 'no-login-form' })
  })
})
