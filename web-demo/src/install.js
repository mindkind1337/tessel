// Runs before Tessel's first line: the simulated window.shellApi, and what keeps the
// page to itself.
import { createFakeApi } from './fakeApi'
import { createSimulator } from './simulator'
import { contentLanguage, demoText, requestedLanguage } from './text'
import { installChrome } from './chrome'
import { installGuards } from './guards'
import agents from 'virtual:tessel-agents'

/* global __DEMO_VERSION__, __DEMO_BUILD__ */
const uiLanguage = requestedLanguage()
const lang = contentLanguage(uiLanguage)
const t = demoText(lang)

installGuards({ t })

const simulator = createSimulator({
  lang,
  uiLanguage,
  agents,
  notAvailable: t('demo.notAvailable', 'Not available in this demo: install Tessel for this.'),
  version: __DEMO_VERSION__,
  build: __DEMO_BUILD__
})

// The window's buttons follow the theme, as the real title bar does (window:theme).
const chrome = installChrome({ t })
simulator.api.setWindowTheme = (theme) => chrome.setTheme(theme)

// ?debug=1: the calls no simulation answers, in the console (for working on the demo).
const debug = new URLSearchParams(location.search).get('debug') === '1'
window.shellApi = createFakeApi(simulator.api, {
  errorText: t('demo.notAvailable', 'Not available in this demo: install Tessel for this.'),
  onUnknown: debug ? (path) => console.debug('[demo] generic default:', path) : null
})

// The script starts once the interface is there, and waits while out of sight
// (the site's page says so with a message; a hidden tab by itself).
window.addEventListener('load', () => setTimeout(() => simulator.start(), 800))
document.addEventListener('visibilitychange', () => simulator.setPaused(document.visibilityState === 'hidden'))
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || e.data.type !== 'tessel-demo') return
  simulator.setPaused(e.data.visible === false)
})
