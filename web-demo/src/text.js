// The demo's language and its own few words. Tessel's interface translates itself
// (src/renderer/src/i18n, chosen through the real uiLanguage setting); this is only
// what the demo adds: the simulation tag and the scripted agents' text.

// ?lang=fr or ?lang=en, else Tessel's own default ("system": the browser's language).
export function requestedLanguage(search = typeof location !== 'undefined' ? location.search : '') {
  const lang = new URLSearchParams(search).get('lang')
  return lang === 'fr' || lang === 'en' ? lang : 'system'
}

// The language the scripted text is written in.
export function contentLanguage(requested = requestedLanguage(), languages = typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : []) {
  if (requested === 'fr' || requested === 'en') return requested
  return /^fr\b/i.test(String((languages && languages[0]) || '')) ? 'fr' : 'en'
}

// t(key, english, vars), as Tessel's own: English in the code, French in a catalog.
const FR = {
  'demo.tag': 'Simulation',
  'demo.notAvailable': 'Non disponible dans cette démo : installez Tessel pour cela.',
  'demo.browserPage': 'Le navigateur intégré a besoin de l’application de bureau.',
  'demo.browserPageHint': 'Dans cette démo, aucune page ne s’ouvre et rien ne quitte cette page.'
}
export function demoText(lang) {
  return function t(key, english, vars) {
    let text = lang === 'fr' && FR[key] ? FR[key] : english
    for (const [k, v] of Object.entries(vars || {})) text = text.split(`{{${k}}}`).join(String(v))
    return text
  }
}
