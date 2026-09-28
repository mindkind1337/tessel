// The interface's language, like Orca's (src/renderer/src/i18n, MIT, Lovecast
// Inc.): every string goes through t(key, english, vars). English is the text
// written inline in the code, so it needs no catalog; other languages come
// from locales/<lang>/*.json (one file per area, flat or nested keys),
// loaded when the language is chosen. A missing translation shows the English.
import { reactive } from 'vue'

export const UI_LANGUAGES = [
  { value: 'system', key: 'settings.language.system', label: 'System' },
  { value: 'en', key: 'settings.language.english', label: 'English' },
  { value: 'fr', key: 'settings.language.french', label: 'Français' }
]
export const LOCALES = ['en', 'fr']
export const DEFAULT_LOCALE = 'en'

const loaders = {
  fr: import.meta.glob('./locales/fr/*.json', { import: 'default' })
}

const state = reactive({ locale: DEFAULT_LOCALE, messages: {} })

// Nested catalogs ({ settings: { title: … } }) become "settings.title".
export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else if (typeof v === 'string') out[key] = v
  }
  return out
}

// "system" follows Windows' display language when Tessel has it.
export function resolveLocale(language, systemLanguages = navigatorLanguages()) {
  if (LOCALES.includes(language)) return language
  for (const tag of systemLanguages) {
    const base = String(tag || '').toLowerCase().split(/[-_]/)[0]
    if (LOCALES.includes(base)) return base
  }
  return DEFAULT_LOCALE
}

function navigatorLanguages() {
  if (typeof navigator === 'undefined') return []
  return navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]
}

let loadSeq = 0
export async function setUiLanguage(language) {
  const locale = resolveLocale(language)
  const seq = ++loadSeq
  let messages = {}
  const files = loaders[locale]
  if (files) {
    const parts = await Promise.all(Object.values(files).map((load) => load().catch(() => ({}))))
    for (const part of parts) Object.assign(messages, flatten(part))
  }
  if (seq !== loadSeq) return state.locale // a later choice won
  state.messages = messages
  state.locale = locale
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  tellMainProcess(locale)
  return locale
}

// The main process shows dialogs and messages in the same language
// (src/main/i18n.js). Not there in tests.
function tellMainProcess(locale) {
  try {
    const api = typeof window !== 'undefined' ? window.shellApi : null
    if (api && typeof api.setUiLanguage === 'function') api.setUiLanguage(locale)
  } catch {
    // The main process keeps its language.
  }
}

// For tests: set a catalog directly.
export function setMessages(locale, messages) {
  loadSeq++
  state.messages = flatten(messages)
  state.locale = locale
}

export function currentLocale() {
  return state.locale
}

// {{name}} placeholders; {{count}} with vars.count also picks key_one /
// key_other when the catalog has them (English: pass the right fallback).
function interpolate(text, vars) {
  if (!vars) return text
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
}

export function t(key, fallback, vars) {
  const messages = state.messages
  let text
  if (state.locale !== DEFAULT_LOCALE) {
    if (vars && typeof vars.count === 'number') {
      const form = pluralForm(state.locale, vars.count)
      text = messages[`${key}_${form}`]
    }
    if (text == null) text = messages[key]
  }
  if (text == null) text = fallback ?? key
  return interpolate(text, vars)
}

function pluralForm(locale, count) {
  try {
    return new Intl.PluralRules(locale).select(count)
  } catch {
    return count === 1 ? 'one' : 'other'
  }
}

// Dates, times and numbers in the interface's language.
export function intlLocale() {
  const tag = navigatorLanguages().find((l) => String(l || '').toLowerCase().split(/[-_]/)[0] === state.locale)
  if (tag) return tag
  return state.locale === 'fr' ? 'fr-CA' : 'en-US'
}
