// The words of a cookie import's result, in English and French
// (browser/cookieImportText.js).
import { afterEach, describe, expect, it } from 'vitest'
import { setMessages } from '../i18n'
import fr from '../i18n/locales/fr/browser.json'
import { headlineText, skippedText, toastText, lastImportText, skipBreakdown } from '../browser/cookieImportText'

const AT = Date.UTC(2026, 9, 3, 12)
const AGAIN = {
  imported: 2180,
  added: 12,
  updated: 1,
  unchanged: 2167,
  previousAt: AT,
  skipped: 1137,
  reasons: { google: 89, expired: 1000, partitioned: 48 }
}

afterEach(() => setMessages('en', {}))

describe('cookie import text', () => {
  it('English', () => {
    expect(headlineText(AGAIN)).toMatch(/^Already imported on .+\. This time: 12 new, 1 updated, 2167 unchanged\.$/)
    expect(skippedText(AGAIN)).toBe("Skipped 89 Google cookies (sign in to Google in Tessel's browser instead), skipped 1048 others.")
    expect(toastText(AGAIN)).toBe("Cookies imported into Tessel's browser: 12 new, 1 updated, 2167 unchanged.")
    // Without a comparison: the old wording.
    expect(toastText({ imported: 5, added: null })).toBe("Imported 5 cookies into Tessel's browser.")
    expect(headlineText({ imported: 5, added: null })).toBe('Imported 5 cookies.')
  })

  it('French, with the plural forms and the date in French', () => {
    setMessages('fr', fr)
    expect(headlineText(AGAIN)).toMatch(/^Déjà importé le 3 oct\. 2026\. Cette fois : 12 nouveaux, 1 mis à jour, 2167 inchangés\.$/)
    expect(headlineText({ ...AGAIN, added: 1, unchanged: 1 })).toContain('1 nouveau, 1 mis à jour, 1 inchangé.')
    expect(skippedText(AGAIN)).toBe('89 cookies Google ignorés (connectez-vous plutôt à Google dans le navigateur de Tessel), 1048 autres ignorés.')
    expect(toastText(AGAIN)).toBe('Cookies importés dans le navigateur de Tessel : 12 nouveaux, 1 mis à jour, 2167 inchangés.')
    expect(lastImportText({ at: AT, imported: 2180 })).toBe('Importé le 3 oct. 2026 · 2180 cookies')
    expect(skipBreakdown(AGAIN).map((r) => r.label)).toEqual(['Expirés (plus valides dans ce navigateur)', 'Partitionnés (cookies tiers gardés par site)', 'Google (jamais importés)'])
  })

  it('the breakdown adds up to the skipped total', () => {
    const s = { skipped: 10, reasons: { expired: 4, appBound: 2, invalid: 3, mystery: 1 } }
    const rows = skipBreakdown(s)
    expect(rows.map((r) => r.id)).toEqual(['expired', 'appBound', 'other'])
    expect(rows.reduce((n, r) => n + r.n, 0)).toBe(10)
  })
})
