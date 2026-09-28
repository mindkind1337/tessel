// The main process's language: the same t(key, english, vars) as the
// interface (src/renderer/src/i18n), reading the same French catalogs. The
// renderer tells it the language it resolved (shellApi.setUiLanguage, IPC
// 'app:setUiLanguage'); until then it follows Windows' display languages.
// No Electron import here, so modules that use t() stay testable in Node.
import frMain from '../renderer/src/i18n/locales/fr/main.json'

export const LOCALES = ['en', 'fr']
export const DEFAULT_LOCALE = 'en'

// Nested catalogs ({ main: { dialog: { … } } }) become "main.dialog.…".
export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else if (typeof v === 'string') out[key] = v
  }
  return out
}

const CATALOGS = { fr: flatten(frMain) }

let locale = DEFAULT_LOCALE
let messages = {}
const listeners = new Set()

// 'en' / 'fr' as chosen; anything else ('system', unknown) follows the
// system languages (['fr-CA', 'en-US'] …), English when none is known.
export function resolveLocale(language, systemLanguages = []) {
  const base = (tag) => String(tag || '').toLowerCase().split(/[-_]/)[0]
  if (LOCALES.includes(base(language))) return base(language)
  for (const tag of systemLanguages || []) {
    if (LOCALES.includes(base(tag))) return base(tag)
  }
  return DEFAULT_LOCALE
}

// Returns the locale now in use; listeners run only when it changes.
export function setLanguage(language, systemLanguages = []) {
  const next = resolveLocale(language, systemLanguages)
  if (next === locale) return locale
  locale = next
  messages = CATALOGS[next] || {}
  for (const fn of listeners) {
    try {
      fn(locale)
    } catch {
      // A listener's failure must not stop the others.
    }
  }
  return locale
}

// For tests: a catalog set directly.
export function setMessages(nextLocale, catalog) {
  locale = nextLocale
  messages = flatten(catalog)
}

export function currentLocale() {
  return locale
}

// Rebuild what shows text (menus, tray) when the language changes.
export function onLanguageChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function interpolate(text, vars) {
  if (!vars) return text
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
}

function pluralForm(count) {
  try {
    return new Intl.PluralRules(locale).select(count)
  } catch {
    return count === 1 ? 'one' : 'other'
  }
}

export function t(key, fallback, vars) {
  let text
  if (locale !== DEFAULT_LOCALE) {
    if (vars && typeof vars.count === 'number') text = messages[`${key}_${pluralForm(vars.count)}`]
    if (text == null) text = messages[key]
  }
  if (text == null) text = fallback ?? key
  return interpolate(text, vars)
}
