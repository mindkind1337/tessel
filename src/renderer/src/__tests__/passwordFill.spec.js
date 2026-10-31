import { it, expect, vi, afterEach } from 'vitest'
import { passwordFillScript } from '../../../main/browserPasswords'
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; vi.restoreAllMocks() })
const entry = { origin: 'https://login.test', username: 'fixture-user', password: 'fixture-secret' }
function form(action = 'https://login.test/session') {
  vi.stubGlobal('location', { origin: entry.origin, protocol: 'https:', href: entry.origin + '/login' })
  document.body.innerHTML = `<form action="${action}"><input name="email" type="email"><input type="password"></form>`
  vi.spyOn(HTMLInputElement.prototype, 'getClientRects').mockReturnValue([{}])
}
it('fills visible fields without submitting or returning passwords', () => {
  form()
  const submit = vi.fn()
  document.querySelector('form').addEventListener('submit', submit)
  const result = new Function('return ' + passwordFillScript(entry))()
  expect(result).toEqual({ ok: true, submitted: false })
  expect(document.querySelector('[type=email]').value).toBe(entry.username)
  expect(document.querySelector('[type=password]').value).toBe(entry.password)
  expect(submit).not.toHaveBeenCalled()
  expect(JSON.stringify(result)).not.toContain(entry.password)
})
it('refuses cross-origin actions, navigation races and ambiguous forms', () => {
  form('https://other.test/session')
  expect(new Function('return ' + passwordFillScript(entry))().code).toBe('unsafe-form')
  form()
  expect(new Function('return ' + passwordFillScript({ ...entry, origin: 'https://other.test' }))().code).toBe('wrong-site')
  document.querySelector('form').append(document.createElement('input'))
  document.querySelector('input[type=email]').type = 'text'
  expect(new Function('return ' + passwordFillScript(entry))().code).toBe('ambiguous-form')
})
