// The words of a cookie import's result (CookieImportDialog.vue and its
// toast in App.vue): new / updated / unchanged, when the profile was imported
// before, and why cookies were skipped. Counts and dates only: a summary
// never carries a cookie's value.
import { t, intlLocale } from '../i18n'

export function importDate(ms) {
  if (!Number.isFinite(ms)) return ''
  try {
    return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium' }).format(ms)
  } catch {
    return new Date(ms).toLocaleDateString()
  }
}

// A profile's last import, under its name in the list ('' when never).
export function lastImportText(last) {
  if (!last || !Number.isFinite(last.at)) return ''
  const count = Number(last.imported) || 0
  return t('browser.cookieImport.lastImport', 'Imported on {{date}} · {{count}} cookies', { date: importDate(last.at), count })
}

// "12 new, 3 updated, 2165 unchanged", or '' when the session could not be
// compared.
export function changesText(s) {
  if (!s || s.added == null) return ''
  return [
    t('browser.cookieImport.new', '{{count}} new', { count: s.added || 0 }),
    t('browser.cookieImport.updated', '{{count}} updated', { count: s.updated || 0 }),
    t('browser.cookieImport.unchanged', '{{count}} unchanged', { count: s.unchanged || 0 })
  ].join(', ')
}

// The first sentence of the result.
export function headlineText(s) {
  const changes = changesText(s)
  if (changes && Number.isFinite(s.previousAt))
    return t('browser.cookieImport.again', 'Already imported on {{date}}. This time: {{changes}}.', { date: importDate(s.previousAt), changes })
  if (changes) return t('browser.cookieImport.importedChanges', 'Imported {{n}} cookies: {{changes}}.', { n: s.imported, changes })
  return t('browser.cookieImport.imported', 'Imported {{n}} cookies', { n: s.imported }) + '.'
}

// Skipped cookies not told apart in the sentence ("N others").
export function otherSkipped(s) {
  const r = (s && s.reasons) || {}
  return Math.max(0, (s.skipped || 0) - (r.google || 0) - (r.appBound || 0) - (r.filtered || 0))
}

// The second sentence: what was skipped ('' when nothing).
export function skippedText(s) {
  const r = (s && s.reasons) || {}
  const parts = []
  if (r.appBound) parts.push(t('browser.cookieImport.skippedAppBound', "skipped {{n}} encrypted by Chrome's app-bound protection", { n: r.appBound }))
  if (r.google) parts.push(t('browser.cookieImport.skippedGoogle', "skipped {{n}} Google cookies (sign in to Google in Tessel's browser instead)", { n: r.google }))
  const other = otherSkipped(s)
  if (other) parts.push(t('browser.cookieImport.skippedOther', 'skipped {{n}} others', { n: other }))
  if (!parts.length) return ''
  const text = parts.join(', ') + '.'
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Why each skipped cookie was skipped, for the "Details" list: [{ id, label, n }].
const REASONS = [
  ['expired', () => t('browser.cookieImport.reason.expired', 'Expired (no longer valid in that browser)')],
  ['appBound', () => t('browser.cookieImport.reason.appBound', "Chrome's app-bound encryption (v20)")],
  ['partitioned', () => t('browser.cookieImport.reason.partitioned', 'Partitioned (third-party cookies kept per site)')],
  ['container', () => t('browser.cookieImport.reason.container', 'Firefox containers')],
  ['invalidHost', () => t('browser.cookieImport.reason.invalidHost', 'Invalid domain or host')],
  ['google', () => t('browser.cookieImport.reason.google', 'Google (never imported)')],
  ['filtered', () => t('browser.cookieImport.reason.filtered', 'Outside the chosen domains')],
  ['undecryptable', () => t('browser.cookieImport.reason.undecryptable', 'Could not be decrypted')],
  ['rejected', () => t('browser.cookieImport.reason.rejected', "Refused by Tessel's browser")]
]

export function skipBreakdown(s) {
  const r = (s && s.reasons) || {}
  const rows = []
  let known = 0
  for (const [id, label] of REASONS) {
    const n = Number(r[id]) || 0
    known += n
    if (n > 0) rows.push({ id, label: label(), n })
  }
  const rest = Math.max(0, (s && s.skipped ? s.skipped : 0) - known)
  if (rest > 0) rows.push({ id: 'other', label: t('browser.cookieImport.reason.other', 'Other (malformed)'), n: rest })
  return rows
}

// The toast after an import.
export function toastText(s) {
  const changes = changesText(s)
  if (changes) return t('browser.cookieImport.toastChanges', "Cookies imported into Tessel's browser: {{changes}}.", { changes })
  return t('browser.cookieImport.toast', "Imported {{n}} cookies into Tessel's browser.", { n: (s && s.imported) || 0 })
}
