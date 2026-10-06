// @vitest-environment node
// The cookie import's safety rails: a file is imported only through the
// single-use token its picker gave, and temp database copies never linger.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createFileTokens, isAllowedCookieFilePath } from '../cookieImport/fileTokens'
import { cleanStaleCopies, withDatabaseCopy, COPY_PREFIX } from '../cookieImport/chromium'

describe('cookie file tokens', () => {
  const winPath = 'C:\\Users\\me\\Downloads\\cookies.json'

  it('gives a token for a picked path and takes it back once', () => {
    const tokens = createFileTokens({ platform: 'win32' })
    const token = tokens.issue(winPath)
    expect(typeof token).toBe('string')
    expect(token).not.toContain('cookies.json')
    expect(tokens.take(token)).toBe(winPath)
    // Single use.
    expect(tokens.take(token)).toBeNull()
  })

  it('refuses an unknown token, a path passed as a token, and odd values', () => {
    const tokens = createFileTokens({ platform: 'win32' })
    tokens.issue(winPath)
    for (const bad of [winPath, 'nope', '', null, undefined, 42, {}]) expect(tokens.take(bad)).toBeNull()
  })

  it('refuses UNC, device and relative paths', () => {
    const tokens = createFileTokens({ platform: 'win32' })
    for (const bad of ['\\\\server\\share\\c.json', '//server/share/c.json', '\\\\?\\C:\\c.json', '\\\\.\\pipe\\x', '\\\\?\\UNC\\srv\\s\\c.json', 'cookies.json', '..\\c.json']) {
      expect(isAllowedCookieFilePath(bad, 'win32')).toBe(false)
      expect(tokens.issue(bad)).toBeNull()
    }
    expect(isAllowedCookieFilePath(winPath, 'win32')).toBe(true)
  })

  it('a token expires', () => {
    let now = 1000
    const tokens = createFileTokens({ platform: 'win32', now: () => now, ttlMs: 5000 })
    const token = tokens.issue(winPath)
    now += 6000
    expect(tokens.take(token)).toBeNull()
  })
})

describe('temp database copies', () => {
  it('cleans stale copy folders and leaves everything else', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'cookie-clean-'))
    try {
      const stale = join(root, `${COPY_PREFIX}abc123`)
      fs.mkdirSync(stale)
      fs.writeFileSync(join(stale, 'db.sqlite'), 'x')
      const other = join(root, 'something-else')
      fs.mkdirSync(other)
      const n = cleanStaleCopies([root])
      expect(n).toBe(1)
      expect(fs.existsSync(stale)).toBe(false)
      expect(fs.existsSync(other)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('never removes a copy an import is still reading, and the copy goes after', async () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'cookie-active-'))
    try {
      const tmpRoot = join(root, 'cookie-import-tmp') // created on demand
      const src = join(root, 'Cookies')
      fs.writeFileSync(src, 'db')
      let seen
      await withDatabaseCopy(
        src,
        (copy) => {
          seen = copy
          expect(cleanStaleCopies([tmpRoot])).toBe(0)
          expect(fs.existsSync(copy)).toBe(true)
        },
        { tmpRoot }
      )
      expect(seen.startsWith(tmpRoot)).toBe(true)
      expect(fs.existsSync(seen)).toBe(false)
      expect(fs.readdirSync(tmpRoot)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
