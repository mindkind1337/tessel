<script setup>
// Import cookies from another browser into Tessel's browser, so the user stays
// signed in to their sites in the browser panes. Lists the detected browsers
// and profiles (the system default first, preselected), lets the user filter
// by domain, warns plainly, and shows what was imported and what was skipped.
// After Orca's cookie-import UI (MIT, Copyright (c) 2026 Lovecast Inc.).
// No cookie value is ever shown here: only counts and domain names.
import { ref, computed, onMounted } from 'vue'
import { Cookie, Loader2, AlertTriangle, Globe } from 'lucide-vue-next'
import { t } from '../i18n'
import { settings } from '../settings'
import { afterCookieImport } from '../browser/agentSession'
import { lastImportText, headlineText, skippedText, skipBreakdown } from '../browser/cookieImportText'

const emit = defineEmits(['close', 'imported'])

const api = window.shellApi && window.shellApi.browser
const loading = ref(true)
const browsers = ref([])
const selected = ref(null) // { browserId, profileDir }
const domainFilter = ref('')
const importing = ref(false)
const result = ref(null) // the last summary
const error = ref('')
// The first import turned the agents' separate session on: said under the result.
const separateTurnedOn = ref(false)

const current = computed(() => browsers.value.find((b) => b.id === (selected.value && selected.value.browserId)) || null)
const currentProfile = computed(() => current.value && current.value.profiles.find((p) => p.dir === (selected.value && selected.value.profileDir)))
const appBoundWarn = computed(() => (currentProfile.value && currentProfile.value.appBoundCount) || 0)
const appBoundText = computed(() =>
  t('browser.cookieImport.appBoundNote', "{{n}} of this profile's cookies use Chrome's app-bound encryption and cannot be read; export them to a file and use Import from file.", { n: appBoundWarn.value })
)

onMounted(async () => {
  if (!api || typeof api.cookieSources !== 'function') {
    loading.value = false
    error.value = t('browser.cookieImport.unavailable', 'Cookie import is not available.')
    return
  }
  try {
    browsers.value = (await api.cookieSources()) || []
  } catch {
    browsers.value = []
  }
  // The system default browser's default profile is preselected.
  const def = browsers.value.find((b) => b.isDefault) || browsers.value[0]
  const prof = def && (def.profiles.find((p) => p.lastUsed) || def.profiles[0])
  if (def && prof) selected.value = { browserId: def.id, profileDir: prof.dir }
  loading.value = false
})

function pick(browserId, profileDir) {
  selected.value = { browserId, profileDir }
  result.value = null
  error.value = ''
}

function profileLabel(b, p) {
  const count = p.cookieCount == null ? '' : t('browser.cookieImport.count', '{{n}} cookies', { n: p.cookieCount })
  const name = b.profiles.length > 1 || p.name !== b.name ? p.name : ''
  return [name, count].filter(Boolean).join(' · ')
}

async function doImport() {
  if (!selected.value || importing.value) return
  importing.value = true
  error.value = ''
  result.value = null
  separateTurnedOn.value = false
  try {
    const r = await api.importCookies({ ...selected.value, domainFilter: domainFilter.value })
    if (r && r.ok) {
      result.value = r.summary
      separateTurnedOn.value = afterCookieImport(settings)
      emit('imported', r.summary)
    } else error.value = codeMessage(r && r.code)
  } catch {
    error.value = codeMessage('failed')
  }
  importing.value = false
}

async function importFile() {
  if (importing.value || !api.pickCookieFile) return
  const picked = await api.pickCookieFile()
  if (!picked) return
  if (!picked.token) {
    error.value = codeMessage('refused')
    return
  }
  importing.value = true
  error.value = ''
  result.value = null
  separateTurnedOn.value = false
  try {
    const r = await api.importCookieFile({ token: picked.token, domainFilter: domainFilter.value })
    if (r && r.ok) {
      result.value = r.summary
      separateTurnedOn.value = afterCookieImport(settings)
      emit('imported', r.summary)
    } else error.value = codeMessage(r && r.code)
  } catch {
    error.value = codeMessage('failed')
  }
  importing.value = false
}

function codeMessage(code) {
  if (code === 'locked') return t('browser.cookieImport.locked', 'Close that browser first, then try again (it keeps its cookies locked while open).')
  if (code === 'format') return t('browser.cookieImport.badFile', 'That file is not a cookie export Tessel understands (a JSON export or a cookies.txt).')
  if (code === 'too-big') return t('browser.cookieImport.tooBig', 'That file is too large.')
  if (code === 'refused') return t('browser.cookieImport.refusedFile', 'Choose a cookie file on this computer (not on a network share), then try again.')
  if (code === 'not-found' || code === 'missing') return t('browser.cookieImport.notFound', 'That profile could not be found.')
  return t('browser.cookieImport.failed', 'The import could not be completed.')
}

// "Already imported on <date>. This time: X new, Y updated, Z unchanged."
// then what was skipped; the reasons one by one under "Details".
const resultText = computed(() => {
  const s = result.value
  if (!s) return ''
  return [headlineText(s), skippedText(s)].filter(Boolean).join(' ')
})
const breakdown = computed(() => (result.value ? skipBreakdown(result.value) : []))
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="emit('close')">
    <div class="help-card cookie-card" role="dialog" aria-modal="true" aria-labelledby="cookie-title" @keydown.escape.prevent.stop="emit('close')">
      <div class="help-head">
        <span id="cookie-title"><Cookie :size="16" aria-hidden="true" /> {{ t('browser.cookieImport.title', 'Import cookies from another browser') }}</span>
        <button class="tb-icon" :title="t('browser.cookieImport.close', 'Close (Esc)')" @click="emit('close')">✕</button>
      </div>

      <p class="cookie-intro">{{ t('browser.cookieImport.intro', 'Copy your sign-ins from another browser so you stay logged in to your sites in Tessel\'s browser.') }}</p>

      <div v-if="loading" class="cookie-loading"><Loader2 :size="18" class="bp-spin" /> {{ t('browser.cookieImport.detecting', 'Detecting your browsers…') }}</div>

      <div v-else-if="!browsers.length" class="cookie-empty">{{ t('browser.cookieImport.none', 'No other browser with cookies was found on this computer.') }}</div>

      <div v-else class="cookie-list" role="radiogroup" :aria-label="t('browser.cookieImport.chooseProfile', 'Choose a profile')">
        <div v-for="b in browsers" :key="b.id" class="cookie-browser">
          <div class="cookie-browser-name">
            {{ b.name }}
            <span v-if="b.isDefault" class="cookie-default">{{ t('browser.cookieImport.defaultBrowser', 'Default browser') }}</span>
          </div>
          <label
            v-for="p in b.profiles"
            :key="p.dir"
            class="cookie-profile"
            :class="{ on: selected && selected.browserId === b.id && selected.profileDir === p.dir }"
          >
            <input
              type="radio"
              name="cookie-profile"
              :checked="selected && selected.browserId === b.id && selected.profileDir === p.dir"
              @change="pick(b.id, p.dir)"
            />
            <span class="cookie-profile-text">
              <span class="cookie-profile-label">{{ profileLabel(b, p) || p.name }}</span>
              <span v-if="p.lastImport" class="cookie-profile-last" data-test="cookie-last-import">{{ lastImportText(p.lastImport) }}</span>
            </span>
          </label>
        </div>
      </div>

      <label v-if="browsers.length" class="cookie-filter">
        <span class="cookie-filter-label"><Globe :size="13" aria-hidden="true" /> {{ t('browser.cookieImport.domainFilter', 'Only these domains (optional)') }}</span>
        <input
          v-model="domainFilter"
          class="cookie-filter-input"
          type="text"
          spellcheck="false"
          :placeholder="t('browser.cookieImport.domainPlaceholder', 'e.g. github.com, linear.app')"
        />
      </label>

      <div class="cookie-warn" role="note">
        <AlertTriangle :size="15" aria-hidden="true" />
        <span>{{ t('browser.cookieImport.warning', 'These are your logins. Agents that use the browser tools act with them unless agents use a separate session (Settings > Browser; your first import turns it on). Google cookies are never imported.') }}</span>
      </div>
      <div v-if="appBoundWarn" class="cookie-appbound">{{ appBoundText }}</div>

      <div v-if="result" class="cookie-result" data-test="cookie-result">
        <span data-test="cookie-result-text">{{ resultText }}</span>
        <details v-if="breakdown.length" class="cookie-details" data-test="cookie-details">
          <summary>{{ t('browser.cookieImport.details', 'Details') }}</summary>
          <ul>
            <li v-for="row in breakdown" :key="row.id" :data-reason="row.id">
              <span>{{ row.label }}</span><span class="cookie-details-n">{{ row.n }}</span>
            </li>
          </ul>
        </details>
      </div>
      <div v-if="result && separateTurnedOn" class="cookie-separate" data-test="cookie-separate-note">
        {{ t('browser.cookieImport.separateOn', 'Agents now use a separate session without these logins; change it in Settings > Browser.') }}
      </div>
      <div v-if="error" class="cookie-error" role="alert">{{ error }}</div>

      <div class="confirm-actions">
        <button class="confirm-btn" @click="emit('close')">{{ result ? t('browser.cookieImport.done', 'Done') : t('app.confirm.cancel', 'Cancel') }}</button>
        <button class="confirm-btn" :disabled="importing" data-test="cookie-import-file" @click="importFile">
          {{ t('browser.cookieImport.fromFile', 'Import from file…') }}
        </button>
        <button class="confirm-btn primary" :disabled="importing || !selected" data-test="cookie-import" @click="doImport">
          <Loader2 v-if="importing" :size="14" class="bp-spin" />
          {{ t('browser.cookieImport.import', 'Import cookies') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cookie-card {
  width: min(520px, 100%);
}
.help-head span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.cookie-intro {
  margin: 0 0 12px;
  color: var(--text-dim);
  font-size: 12.5px;
}
.cookie-loading,
.cookie-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 0;
  color: var(--text-dim);
  font-size: 13px;
}
.cookie-list {
  max-height: 46vh;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 6px;
}
.cookie-browser + .cookie-browser {
  margin-top: 8px;
}
.cookie-browser-name {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
}
.cookie-default {
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--text-strong);
  font-size: 10.5px;
  font-weight: 500;
}
.cookie-profile {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 8px;
  border-radius: 7px;
  color: var(--text);
  font-size: 12.5px;
  cursor: pointer;
}
.cookie-profile:hover {
  background: var(--surface-3);
}
.cookie-profile.on {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.cookie-profile input {
  accent-color: var(--accent);
}
.cookie-filter {
  display: block;
  margin-top: 14px;
}
.cookie-filter-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
  color: var(--text-dim);
  font-size: 12px;
}
.cookie-filter-input {
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
}
.cookie-warn {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--warn) 50%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
}
.cookie-warn svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--warn);
}
.cookie-appbound {
  margin-top: 8px;
  color: var(--text-dim);
  font-size: 11.5px;
}
.cookie-result {
  margin-top: 14px;
  padding: 9px 11px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text-strong);
  font-size: 12.5px;
}
.cookie-profile-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.cookie-profile-last {
  color: var(--text-dim);
  font-size: 11px;
}
.cookie-details {
  margin-top: 6px;
  font-size: 12px;
}
.cookie-details summary {
  cursor: pointer;
  color: var(--text-dim);
}
.cookie-details ul {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
.cookie-details li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0;
  color: var(--text);
}
.cookie-details-n {
  font-variant-numeric: tabular-nums;
}
.cookie-separate {
  margin-top: 8px;
  color: var(--text-dim);
  font-size: 12px;
}
.cookie-error {
  margin-top: 12px;
  color: var(--danger);
  font-size: 12.5px;
}
</style>
