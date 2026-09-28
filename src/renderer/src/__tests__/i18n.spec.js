import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { t, setMessages, resolveLocale, flatten, setUiLanguage, currentLocale } from '../i18n'
import { untranslatedIn, rendererFiles, relPath, usedKeys } from '../i18n/audit'

const root = join(__dirname, '..')
const PENDING = /i18n-pending/

describe('t()', () => {
  afterEach(() => setMessages('en', {}))

  it('English is the text in the code; placeholders are filled', () => {
    expect(t('x.hello', 'Hello {{name}}', { name: 'Ada' })).toBe('Hello Ada')
  })

  it('French comes from the catalog, English when a key is missing', () => {
    setMessages('fr', { x: { hello: 'Bonjour {{name}}' } })
    expect(t('x.hello', 'Hello {{name}}', { name: 'Ada' })).toBe('Bonjour Ada')
    expect(t('x.missing', 'Missing')).toBe('Missing')
  })

  it('plural forms: key_one / key_other by count', () => {
    setMessages('fr', { x: { files_one: '{{count}} fichier', files_other: '{{count}} fichiers' } })
    expect(t('x.files', '{{count}} files', { count: 1 })).toBe('1 fichier')
    expect(t('x.files', '{{count}} files', { count: 3 })).toBe('3 fichiers')
  })

  it('System follows Windows when Tessel has that language', () => {
    expect(resolveLocale('system', ['fr-CA', 'en-US'])).toBe('fr')
    expect(resolveLocale('system', ['de-DE'])).toBe('en')
    expect(resolveLocale('en', ['fr-CA'])).toBe('en')
    expect(resolveLocale('fr', [])).toBe('fr')
  })

  it('loads the French catalogs', async () => {
    await setUiLanguage('fr')
    expect(currentLocale()).toBe('fr')
    expect(t('settings.language.title', 'Language')).toBe('Langue')
    await setUiLanguage('en')
    expect(t('settings.language.title', 'Language')).toBe('Language')
  })
})

describe('nothing is forgotten', () => {
  const files = rendererFiles(root)

  it('every file without the i18n-pending mark shows no text outside t()', () => {
    const report = []
    for (const f of files) {
      if (PENDING.test(readFileSync(f, 'utf8').slice(0, 200))) continue
      for (const hit of untranslatedIn(f)) report.push(`${relPath(root, f)}:${hit.line}  ${hit.text}`)
    }
    expect(report, 'Put this text through t(key, english), or end the line with // i18n-ignore').toEqual([])
  })

  it('a file whose text is all translated drops its i18n-pending mark', () => {
    const stale = files
      .filter((f) => PENDING.test(readFileSync(f, 'utf8').slice(0, 200)))
      .filter((f) => untranslatedIn(f).length === 0)
      .map((f) => relPath(root, f))
    expect(stale).toEqual([])
  })

  it('every key used has its French translation', () => {
    const fr = {}
    const dir = join(root, 'i18n', 'locales', 'fr')
    for (const name of readdirSync(dir)) Object.assign(fr, flatten(JSON.parse(readFileSync(join(dir, name), 'utf8'))))
    const missing = []
    for (const [key, { file }] of usedKeys(files)) {
      if (fr[key] == null && fr[`${key}_other`] == null) missing.push(`${key}  (${relPath(root, file)})`)
    }
    expect(missing).toEqual([])
  })

  it('the French keeps every {{placeholder}} of the English', () => {
    const fr = {}
    const dir = join(root, 'i18n', 'locales', 'fr')
    for (const name of readdirSync(dir)) Object.assign(fr, flatten(JSON.parse(readFileSync(join(dir, name), 'utf8'))))
    const bad = []
    const names = (s) => [...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',')
    for (const [key, { english }] of usedKeys(files)) {
      const french = fr[key] ?? fr[`${key}_other`]
      if (french == null) continue
      const want = names(english).split(',').filter((n) => n && n !== 'count').join(',')
      const got = names(french).split(',').filter((n) => n && n !== 'count').join(',')
      if (want !== got) bad.push(`${key}: "${english}" → "${french}"`)
    }
    expect(bad).toEqual([])
  })
})
