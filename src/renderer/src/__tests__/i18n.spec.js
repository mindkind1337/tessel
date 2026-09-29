import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { t, setMessages, resolveLocale, flatten, setUiLanguage, currentLocale } from '../i18n'
import { untranslatedIn, rendererFiles, relPath, usedKeys } from '../i18n/audit'

const root = join(__dirname, '..')
const PENDING = /i18n-pending/

describe('template literal audit', () => {
  const dirs = []
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
  function audit(source, ext = 'js') {
    const dir = mkdtempSync(join(tmpdir(), 'tessel-i18n-'))
    dirs.push(dir)
    const file = join(dir, `fixture.${ext}`)
    writeFileSync(file, source)
    return untranslatedIn(file)
  }

  it('finds lowercase text after interpolations, including nested and multiline expressions', () => {
    const hits = audit([
      'const a = `${n}% used`',
      'const b = `${get({ nested: { n }, text: "}" })} left`',
      'const c = `${n}',
      'remaining`',
      'const d = `${ok ? `${n} files` : n}`',
      'const e = `ready`'
    ].join('\n'))
    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3, 5, 6])
    expect(hits.map((hit) => hit.text)).toContain('`${n}% used`')
  })

  it('checks only literal text, preserves whole words, and skips translated fallbacks and logs', () => {
    expect(audit([
      'const a = `${englishWords({ nested: true })}%`',
      'const b = `${n} MB / ${m} ms`',
      'const c = `${n} x`',
      'const d = t("usage.used", `${n}% used`)',
      'const e = t(`settings.themes.${id}.description`, description)',
      'console.warn(`failed ${n}`)',
      'window.shellApi.log("info", `failed ${n}`)',
      'throw new Error(`failed ${n}`)',
      '// const ignored = `${n} files`'
    ].join('\n'))).toEqual([])
    // Joining fragments must not invent a word from single letters.
    expect(audit('const value = `a${n}b`')).toEqual([])
  })

  it('allows explicit technical exemptions without suppressing other statements', () => {
    const hits = audit([
      'const css = `pane-${id}` // i18n-ignore',
      'const path = `${dir}/file.txt` // i18n-ignore',
      'const command = `git diff ${ref}` // i18n-ignore',
      'const prompt = `Tell the agent ${task}` // i18n-ignore',
      'const multiline = `agent ${id}',
      'instructions` // i18n-ignore',
      'const shown = `${n} files`',
      'const last = `key-${id}` // i18n-ignore'
    ].join('\n'))
    expect(hits).toEqual([{ line: 7, text: '`${n} files`' }])
    expect(audit('const shown = `${n} files // i18n-ignore`')).toHaveLength(1)
  })

  it('finds displayed Vue expressions with accurate file lines', () => {
    const hits = audit([
      '<script setup>',
      'const label = `${n} left`',
      '</script>',
      '<template>',
      '  <span :title="`${n} remaining`">{{ `${n}% used` }}</span>',
      '  <span>{{ `key-${id}` /* i18n-ignore */ }}</span>',
      '</template>'
    ].join('\n'), 'vue')
    expect(hits.map((hit) => hit.line).sort()).toEqual([2, 5, 5])
  })
})

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
