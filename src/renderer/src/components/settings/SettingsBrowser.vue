<script setup>
// Settings > Browser: where web links open, the built-in browser, its
// cookies and the agents' session.
import { ref, inject, computed } from 'vue'
import { t } from '../../i18n'
import SettingsToolRows from '../SettingsToolRows.vue'
import { settings } from '../../settings'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const { shown, emit } = useSettingsShell()
// Where a clicked web link opens (links/openTarget.js).
const URL_TARGETS = computed(() => [
  { id: 'builtin', label: t('settings.browser.openUrlsInBuiltin', 'Built-in browser') },
  { id: 'system', label: t('settings.browser.openUrlsInSystem', 'System browser') }
])

const browserApi = typeof window !== 'undefined' && window.shellApi ? window.shellApi.browser : null
const clearingCookies = ref(false)
const clearedCookies = ref(false)
const askConfirm = inject('askConfirm', null)
async function clearImportedCookies() {
  if (!browserApi || typeof browserApi.clearImportedCookies !== 'function' || clearingCookies.value) return
  // Signs the user out of every site: asked first, as the pane's Clear browsing data.
  const question = {
    title: t('settings.browser.clearConfirmTitle', 'Clear browser cookies?'),
    text: t('settings.browser.clearConfirmText', "Every cookie of Tessel's browser is deleted, including the ones you imported. You will be signed out of your sites."),
    confirmLabel: t('settings.browser.clearButton', 'Clear cookies'),
    danger: true
  }
  const ok = askConfirm ? await askConfirm(question) : window.confirm(question.title)
  if (!ok) return
  clearingCookies.value = true
  clearedCookies.value = false
  try {
    const r = await browserApi.clearImportedCookies()
    clearedCookies.value = !!(r && r.ok)
  } catch {
    clearedCookies.value = false
  }
  clearingCookies.value = false
}
</script>

<template>
  <section
    id="set-browser"
    class="set-page"
    data-page="browser"
    :hidden="!shown('browser')"
    aria-labelledby="set-browser-title"
  >
    <header class="set-page-head">
      <h2 id="set-browser-title">{{ PAGES.browser.title }}</h2>
      <p class="set-page-desc">{{ PAGES.browser.desc }}</p>
    </header>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.browser.links', 'Links') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div id="settings-links-open-in-label" class="set-label">
            {{ t('settings.browser.openUrlsIn', 'Open web links in') }}
            <span class="set-hint">{{ t('settings.browser.openUrlsInHint', 'Links clicked in a terminal, a chat, a Markdown file or Source Control. Built-in browser: a new tab in the current project. Ctrl+click (Cmd+click on a Mac) opens a link in the other one.') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-links-open-in-label" data-setting="linksOpenUrlsIn">
            <button
              v-for="o in URL_TARGETS"
              :key="o.id"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.linksOpenUrlsIn === o.id }"
              :aria-pressed="settings.linksOpenUrlsIn === o.id"
              :data-value="o.id"
              @click="settings.linksOpenUrlsIn = o.id"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.browser.cookies', 'Your sign-ins') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.browser.importCookies', 'Import cookies from another browser') }}
            <span class="set-hint">{{ t('settings.browser.importCookiesHint', 'Copy your sign-ins from Chrome, Edge, Brave, Firefox and others so you stay logged in to your sites in the built-in browser. You choose a browser and profile each time; Google cookies are never imported.') }}</span>
          </div>
          <button type="button" class="exit-btn" data-test="settings-import-cookies" @click="emit('open-cookie-import')">
            {{ t('settings.browser.importCookiesButton', 'Import cookies…') }}
          </button>
        </div>
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.browser.clearImported', 'Clear browser cookies') }}
            <span class="set-hint">{{ t('settings.browser.clearImportedHint', 'Delete every cookie in the built-in browser\'s main session, including the ones you imported. You will be signed out of your sites.') }}</span>
            <span v-if="clearedCookies" class="set-hint">{{ t('settings.browser.cleared', 'Cookies cleared.') }}</span>
          </div>
          <button type="button" class="exit-btn" :disabled="clearingCookies" data-test="settings-clear-cookies" @click="clearImportedCookies">
            {{ t('settings.browser.clearButton', 'Clear cookies') }}
          </button>
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.browser.agents', 'Agents and the browser') }}</h3>
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.browser.separateSession', 'Agents use a separate browser session') }}
            <span class="set-hint">{{ t('settings.browser.separateSessionHint', 'Pages agents open use their own session, without the sign-ins you imported, and agents can read, click and type only in those pages: your own browser pages are out of their reach. Links and pop-ups from an agent\'s page stay in its session. Turned on by your first cookie import. Off: agents share the one browser session and can use the sites you are signed into.') }}</span>
          </div>
          <input v-model="settings.browserAgentSeparateSession" type="checkbox" class="set-switch" data-setting="browserAgentSeparateSession" />
        </label>
      </div>
    </div>
    <SettingsToolRows page="browser" @open="emit('open-tool', $event)" />
  </section>
</template>
