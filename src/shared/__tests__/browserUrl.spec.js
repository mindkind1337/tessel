// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  BLANK_URL,
  normalizeBrowserInput,
  allowedBrowserUrl,
  isLocalUrl,
  displayUrl,
  hostOf,
  searchUrl
} from '../browserUrl'

const google = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`

describe('normalizeBrowserInput', () => {
  it('opens a local dev server over http', () => {
    expect(normalizeBrowserInput('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeBrowserInput('localhost')).toBe('http://localhost/')
    expect(normalizeBrowserInput('127.0.0.1:3000/x')).toBe('http://127.0.0.1:3000/x')
    expect(normalizeBrowserInput('[::1]:8080')).toBe('http://[::1]:8080/')
    expect(normalizeBrowserInput('0.0.0.0:4000')).toBe('http://0.0.0.0:4000/')
    expect(normalizeBrowserInput('  localhost:5173  ')).toBe('http://localhost:5173/')
  })

  it('opens *.localhost over http, other dotted hosts over https', () => {
    expect(normalizeBrowserInput('app.localhost:3000')).toBe('http://app.localhost:3000/')
    expect(normalizeBrowserInput('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserInput('example.com:8443')).toBe('https://example.com:8443/')
    expect(normalizeBrowserInput('example.com/docs?a=1')).toBe('https://example.com/docs?a=1')
  })

  it('keeps an http(s) URL typed with its scheme', () => {
    expect(normalizeBrowserInput('http://localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeBrowserInput('https://example.com/a#b')).toBe('https://example.com/a#b')
  })

  it('searches for words', () => {
    expect(normalizeBrowserInput('react hooks')).toBe(google('react hooks'))
    expect(normalizeBrowserInput('vitest')).toBe(google('vitest'))
    expect(normalizeBrowserInput('react hooks', { engine: 'duckduckgo' })).toBe('https://duckduckgo.com/?q=react%20hooks')
  })

  it('refuses every other scheme', () => {
    expect(normalizeBrowserInput('javascript:alert(1)')).toBeNull()
    expect(normalizeBrowserInput('JavaScript:alert(document.cookie)')).toBeNull()
    expect(normalizeBrowserInput('file:///C:/x')).toBeNull()
    expect(normalizeBrowserInput('file://server/share/x')).toBeNull()
    expect(normalizeBrowserInput('data:text/html,x')).toBeNull()
    expect(normalizeBrowserInput('view-source:https://example.com')).toBeNull()
    expect(normalizeBrowserInput('about:config')).toBeNull()
    expect(normalizeBrowserInput('chrome://settings')).toBeNull()
  })

  it('never turns a scheme-looking input into a page of that scheme', () => {
    // "javascript:alert(1).com" looks like a host: it must not become javascript:.
    for (const input of ['javascript:alert(1).com', 'javascript:foo.com', 'file:foo.com']) {
      const out = normalizeBrowserInput(input)
      expect(out === null || /^https:\/\/www\.google\.com\/search\?q=/.test(out)).toBe(true)
    }
  })

  it('refuses a user:password@host URL', () => {
    expect(normalizeBrowserInput('http://user:pw@host')).toBeNull()
    expect(normalizeBrowserInput('https://user@example.com/')).toBeNull()
  })

  it('never opens mailto:', () => {
    const out = normalizeBrowserInput('mailto:a@b.com')
    expect(out === null || out.startsWith('https://www.google.com/search?q=')).toBe(true)
  })

  it('the blank page for nothing or about:blank', () => {
    expect(normalizeBrowserInput('')).toBe(BLANK_URL)
    expect(normalizeBrowserInput('   ')).toBe(BLANK_URL)
    expect(normalizeBrowserInput(null)).toBe(BLANK_URL)
    expect(normalizeBrowserInput('about:blank')).toBe(BLANK_URL)
  })

  it('search off: words are refused, addresses still open', () => {
    expect(normalizeBrowserInput('react hooks', { search: false })).toBeNull()
    expect(normalizeBrowserInput('example.com', { search: false })).toBe('https://example.com/')
    expect(normalizeBrowserInput('localhost:5173', { search: false })).toBe('http://localhost:5173/')
    expect(normalizeBrowserInput('javascript:alert(1)', { search: false })).toBeNull()
  })
})

describe('allowedBrowserUrl', () => {
  it('lets http(s) and the blank page through, written the browser way', () => {
    expect(allowedBrowserUrl('https://example.com')).toBe('https://example.com/')
    expect(allowedBrowserUrl(' http://localhost:5173/x ')).toBe('http://localhost:5173/x')
    expect(allowedBrowserUrl('HTTP://EXAMPLE.COM/A')).toBe('http://example.com/A')
    expect(allowedBrowserUrl(BLANK_URL)).toBe(BLANK_URL)
  })

  it('refuses everything else', () => {
    for (const url of [
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'blob:https://example.com/1234',
      'about:config',
      'about:blank#x',
      'chrome://gpu',
      'devtools://devtools/bundled/inspector.html',
      'ftp://example.com',
      'mailto:a@b.com',
      'http://user:pw@example.com',
      'https://user@example.com',
      'example.com',
      '',
      null,
      undefined
    ]) {
      expect(allowedBrowserUrl(url)).toBeNull()
    }
  })
})

describe('isLocalUrl', () => {
  it('knows the pages of this computer', () => {
    expect(isLocalUrl('http://localhost:5173/')).toBe(true)
    expect(isLocalUrl('http://app.localhost:3000/')).toBe(true)
    expect(isLocalUrl('http://127.0.0.1:8000/')).toBe(true)
    expect(isLocalUrl('http://127.4.5.6/')).toBe(true)
    expect(isLocalUrl('http://[::1]:8080/')).toBe(true)
    expect(isLocalUrl('http://0.0.0.0:4000/')).toBe(true)
  })

  it('not look-alikes nor other hosts', () => {
    expect(isLocalUrl('https://example.com/')).toBe(false)
    expect(isLocalUrl('http://localhost.evil.com/')).toBe(false)
    expect(isLocalUrl('http://127.0.0.1.evil.com/')).toBe(false)
    expect(isLocalUrl('http://mylocalhost/')).toBe(false)
    expect(isLocalUrl('not a url')).toBe(false)
    expect(isLocalUrl(BLANK_URL)).toBe(false)
  })
})

describe('displayUrl and hostOf', () => {
  it('the blank page shows nothing', () => {
    expect(displayUrl(BLANK_URL)).toBe('')
    expect(displayUrl('')).toBe('')
    expect(displayUrl(null)).toBe('')
    expect(displayUrl('https://example.com/a')).toBe('https://example.com/a')
  })

  it('the host and port of a page', () => {
    expect(hostOf('http://localhost:5173/x')).toBe('localhost:5173')
    expect(hostOf('https://example.com/a')).toBe('example.com')
    expect(hostOf('not a url')).toBe('not a url')
    expect(hostOf(null)).toBe('')
  })

  it('searchUrl encodes the words and falls back to the default engine', () => {
    expect(searchUrl('a&b=c')).toBe('https://www.google.com/search?q=a%26b%3Dc')
    expect(searchUrl('x', 'nope')).toBe('https://www.google.com/search?q=x')
    expect(searchUrl('x', 'bing')).toBe('https://www.bing.com/search?q=x')
  })
})
