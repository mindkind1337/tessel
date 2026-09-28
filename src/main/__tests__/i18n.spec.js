import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { t, setLanguage, setMessages, resolveLocale, currentLocale, onLanguageChange, flatten } from '../i18n'
import frMain from '../../renderer/src/i18n/locales/fr/main.json'

describe('main process t()', () => {
  afterEach(() => setLanguage('en'))

  it('English is the text in the code, with its placeholders filled', () => {
    setLanguage('en')
    expect(t('main.error.launchShell', 'Failed to launch {{shell}}: {{error}}', { shell: 'Bash', error: 'boom' })).toBe(
      'Failed to launch Bash: boom'
    )
  })

  it('French comes from locales/fr/main.json', () => {
    setLanguage('fr')
    expect(currentLocale()).toBe('fr')
    expect(t('main.dialog.pickFolder', 'Choose a project folder')).toBe('Choisir un dossier de projet')
    expect(t('main.review.branchGone', 'The branch {{branch}} no longer exists.', { branch: 'agent/x' })).toBe(
      "La branche agent/x n'existe plus."
    )
  })

  it('a key without French shows the English', () => {
    setLanguage('fr')
    expect(t('main.nothing.here', 'Only English')).toBe('Only English')
  })

  it('plural forms by count', () => {
    setMessages('fr', { x: { files_one: '{{count}} fichier', files_other: '{{count}} fichiers' } })
    expect(t('x.files', '{{count}} files', { count: 1 })).toBe('1 fichier')
    expect(t('x.files', '{{count}} files', { count: 4 })).toBe('4 fichiers')
  })

  it('System follows the system languages until the interface says otherwise', () => {
    expect(resolveLocale('system', ['fr-CA', 'en-US'])).toBe('fr')
    expect(resolveLocale('system', ['de-DE'])).toBe('en')
    expect(resolveLocale(undefined, [])).toBe('en')
    expect(resolveLocale('fr', ['en-US'])).toBe('fr')
    expect(resolveLocale('en', ['fr-FR'])).toBe('en')
  })

  it('tells listeners when the language changes (menus are rebuilt)', () => {
    setLanguage('en')
    const seen = []
    const off = onLanguageChange((l) => seen.push(l))
    setLanguage('fr')
    setLanguage('fr')
    setLanguage('system', ['en-GB'])
    off()
    setLanguage('fr')
    expect(seen).toEqual(['fr', 'en'])
  })
})

describe('main process catalog', () => {
  // Every t('main.…', 'English') in src/main has its French, with the same
  // {{placeholders}}.
  const dir = join(__dirname, '..')
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'))
  const used = new Map()
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8')
    const re = /\bt\(\s*(['"])(main\.[\w.-]+)\1\s*,\s*(['"`])((?:\\.|(?!\3).)*)\3/g
    let m
    while ((m = re.exec(src))) used.set(m[2], { english: m[4], file: f })
  }
  const fr = flatten(frMain)
  const names = (s) =>
    [...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
      .map((m) => m[1])
      .filter((n) => n !== 'count')
      .sort()
      .join(',')

  it('finds the keys', () => {
    expect(used.size).toBeGreaterThan(10)
  })

  it('every key has French', () => {
    const missing = [...used].filter(([k]) => fr[k] == null && fr[`${k}_other`] == null).map(([k, v]) => `${k} (${v.file})`)
    expect(missing).toEqual([])
  })

  it('French keeps the placeholders', () => {
    const bad = [...used]
      .filter(([k, { english }]) => fr[k] != null && names(english) !== names(fr[k]))
      .map(([k]) => k)
    expect(bad).toEqual([])
  })
})
