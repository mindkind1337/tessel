// Intl formatters kept per locale and options: creating one is slow (tens of
// microseconds; thousands of them when a long list renders), using one is
// fast. A locale Intl refuses throws as before and is not kept.
const MAX = 200
const kept = new Map()

function cached(kind, Ctor, locale, options) {
  const key = `${kind}|${locale == null ? '' : String(locale)}|${options ? JSON.stringify(options) : ''}`
  let f = kept.get(key)
  if (!f) {
    f = new Ctor(locale, options)
    if (kept.size >= MAX) kept.clear()
    kept.set(key, f)
  }
  return f
}

export const numberFormat = (locale, options) => cached('n', Intl.NumberFormat, locale, options)
export const dateTimeFormat = (locale, options) => cached('d', Intl.DateTimeFormat, locale, options)
export const pluralRules = (locale, options) => cached('p', Intl.PluralRules, locale, options)

// For tests: forget them all.
export function clearIntlCache() {
  kept.clear()
}
