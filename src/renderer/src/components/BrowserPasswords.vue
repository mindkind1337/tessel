<script setup>
// Saved passwords: import from every browser profile at once (or one), search
// the saved list, one compact row per login. The window only ever receives
// site, username and the agent switch: never a password.
import { computed, inject, nextTick, ref, watch } from 'vue'
import { Check, Download, FileUp, KeyRound, Search, Trash2, TriangleAlert, X } from 'lucide-vue-next'
import { t } from '../i18n'
import ThemedSelect from './ui/ThemedSelect.vue'
const props = defineProps({ guestId: { type: Number, default: null } })
const askConfirm = inject('askConfirm', null)
const open = ref(false), busy = ref(false), entries = ref([]), sources = ref([]), selected = ref(''), message = ref(''), messageWarn = ref(false)
const query = ref(''), searchEl = ref(null)
const results = ref([]), resultsTitle = ref(''), progress = ref(null)
const api = () => window.shellApi?.browser
const exportHelp = ref(false)
const selectedSource = computed(() => sources.value[Number(selected.value)])

// Rows drawn at a time: 5000 logins stay fast, "Show more" adds a page.
const PAGE = 200
const limit = ref(PAGE)

const exportSteps = computed(() => {
  const id = selectedSource.value?.browserId
  if (selectedSource.value?.family === 'firefox') return t('browser.passwords.stepsFirefox', 'In Firefox (and Zen, LibreWolf, Waterfox, Floorp): menu ≡ → Passwords → the ⋯ menu at the top right → Export passwords. Confirm with your device, then save the CSV.')
  if (id === 'chrome' || id === 'chrome-beta' || id === 'chrome-dev' || id === 'chrome-canary' || id === 'chromium') return t('browser.passwords.stepsChrome', 'In Chrome: menu ⋮ → Passwords and autofill → Google Password Manager → Settings. Under Export passwords, choose Download file.')
  if (id === 'edge') return t('browser.passwords.stepsEdge', 'In Edge: menu ⋯ → Settings → Profiles → Passwords → the ⋯ (More actions) → Export passwords → Export.')
  if (id === 'vivaldi') return t('browser.passwords.stepsVivaldi', 'In Vivaldi: Vivaldi menu → File → Export → Export Passwords.')
  if (id === 'opera' || id === 'opera-gx') return t('browser.passwords.stepsOpera', 'In Opera / Opera GX: Settings → Privacy & Security → Password Manager → Settings. Under Export passwords, choose Download file.')
  if (id === 'brave') return t('browser.passwords.stepsBrave', 'In Brave, enter brave://password-manager/settings in the address bar. Find Export passwords and download the CSV file.')
  return t('browser.passwords.stepsOther', 'In Safari (macOS): menu bar → File → Export → Passwords, or Settings → Passwords → ⋯ → Export All Passwords. For any other browser, open its password manager and choose Export passwords (CSV).')
})
function error(code) {
  const map = {
    'private-page-required': t('browser.passwords.private', 'Use a private browser tab on the host. Credentials cannot be used in shared tabs or joined Live Share sessions.'),
    'encryption-unavailable': t('browser.passwords.encryption', 'Secure system encryption is unavailable. No passwords were saved.'),
    'vault-unavailable': t('browser.passwords.vault', 'The encrypted vault could not be opened.'),
    'locked': t('browser.passwords.locked', 'The browser database is locked. Close that browser and retry, or import its CSV export.'),
    'access-denied': t('browser.passwords.denied', 'Browser protection or permissions prevent access. Use a CSV export.'),
    'no-sqlite': t('browser.passwords.sqlite', 'This version cannot read browser databases. Update Tessel or import a CSV export.'),
    'unreadable': t('browser.passwords.unreadable', 'The browser database could not be read. Import a CSV export instead.'),
    'missing': t('browser.passwords.missing', 'The browser database no longer exists. Reopen this dialog and choose a profile.'),
    'not-found': t('browser.passwords.missing', 'The browser database no longer exists. Reopen this dialog and choose a profile.'),
    'primary-password': t('browser.passwords.primary', 'This Firefox profile has a Primary Password set, so its saved passwords cannot be read here. Unlock it in Firefox, export its passwords as CSV, then import the CSV.'),
    'format': t('browser.passwords.format', 'Expected a CSV export with url, username and password columns.'),
    'too-big': t('browser.passwords.tooBig', 'Too many passwords: Tessel keeps up to 5000.'),
    'no-login-form': t('browser.passwords.form', 'No single visible password field was found. Open the login form first.'),
    'unsafe-form': t('browser.passwords.unsafe', 'This form sends credentials to another site or cannot be verified.'),
    'ambiguous-form': t('browser.passwords.ambiguous', 'Several possible username fields were found. Fill this form manually.'),
    'https-required': t('browser.passwords.https', 'Open the HTTPS login page first.')
  }
  return map[code] || t('browser.passwords.failed', 'The operation could not be completed.')
}
// Results a CSV export fixes: show how to export.
const CSV_FIX = ['access-denied', 'locked', 'unreadable', 'no-sqlite', 'primary-password']
const needsCsv = (r) => r?.protectedCount > 0 || r?.appBoundCount > 0 || CSV_FIX.includes(r?.code)

// One line for an import's result: new, updated, already saved, skipped and why.
function summary(r) {
  if (!r?.ok) return error(r?.code)
  const parts = []
  if (r.added != null) {
    parts.push(t('browser.passwords.added', '{{count}} new', { count: r.added }))
    if (r.updated > 0) parts.push(t('browser.passwords.changedCount', '{{count}} updated (agent access turned off again)', { count: r.updated }))
    if (r.unchanged > 0) parts.push(t('browser.passwords.unchanged', '{{count}} already saved', { count: r.unchanged }))
  } else parts.push(t('browser.passwords.importedCount', '{{count}} imported', { count: r.imported || 0 }))
  if (r.skipped > 0) parts.push(t('browser.passwords.skipped', '{{count}} skipped (not an HTTPS site, no password or unreadable)', { count: r.skipped }))
  if (r.appBoundCount > 0) parts.push(t('browser.passwords.appBoundShort', '{{count}} locked by App-Bound Encryption (Chrome/Edge 127+): import a CSV export', { count: r.appBoundCount }))
  if (r.protectedCount > 0) parts.push(t('browser.passwords.protectedShort', '{{count}} protected and unreadable: import a CSV export', { count: r.protectedCount }))
  return parts.join(' · ')
}

async function reload() {
  const result = await api()?.passwordList()
  entries.value = result?.entries || []
  if (!result?.ok) say(error(result?.code), true)
}
function say(text, warn = false) { message.value = text; messageWarn.value = warn }
async function show() {
  open.value = true; say(''); exportHelp.value = false; busy.value = true; query.value = ''; results.value = []; limit.value = PAGE
  nextTick(() => searchEl.value?.focus())
  try {
    await reload()
    const r = await api()?.passwordSources()
    sources.value = (r?.sources || []).flatMap((b) => (b.profiles || []).map((p) => ({ browserId: b.id, family: b.family, profileDir: p.dir, label: `${b.name} — ${p.name}` })))
    selected.value = sources.value.length ? '0' : ''
  } catch { say(error(), true) } finally { busy.value = false }
}
async function run(action, success) {
  busy.value = true; say('')
  try {
    const r = await action()
    if (needsCsv(r)) exportHelp.value = true
    if (r?.code === 'cancelled') return
    say(r?.ok ? success(r) : error(r?.code), !r?.ok || needsCsv(r))
    await reload()
  } catch { say(error(), true) } finally { busy.value = false }
}
const changed = () => t('browser.passwords.updated', 'Updated.')
// Vue proxies cannot be cloned across Electron IPC. Send only plain strings.
const plain = (source) => ({ browserId: String(source.browserId), profileDir: String(source.profileDir) })
function importSelectedProfile() {
  const source = selectedSource.value
  if (!source) return
  return run(() => api().passwordImportProfile(plain(source)), summary)
}
function importCsv() { return run(() => api().passwordImportCsv(), summary) }

// Every profile of every browser, one after the other (the vault is written
// by each import: never two at once). One profile failing never stops the rest.
async function importAll() {
  const list = sources.value.slice()
  if (!list.length || busy.value) return
  busy.value = true; say(''); results.value = []; resultsTitle.value = ''
  let added = 0, failed = 0
  try {
    for (let i = 0; i < list.length; i++) {
      progress.value = { done: i + 1, total: list.length }
      let r
      try { r = await api().passwordImportProfile(plain(list[i])) } catch { r = { ok: false, code: 'failed' } }
      if (r?.ok) added += r.added ?? r.imported ?? 0
      const warn = !r?.ok || r.appBoundCount > 0 || r.protectedCount > 0
      if (warn) failed++
      results.value.push({ index: i, label: list[i].label, ok: !!r?.ok, warn, csv: needsCsv(r), text: summary(r) })
    }
    resultsTitle.value = failed
      ? t('browser.passwords.allDoneWarn', '{{profiles}} profiles read: {{added}} new accounts. {{count}} need attention.', { profiles: list.length, added, count: failed })
      : t('browser.passwords.allDone', '{{profiles}} profiles read: {{added}} new accounts.', { profiles: list.length, added })
    await reload()
  } catch { say(error(), true) } finally { busy.value = false; progress.value = null }
}
function exportFor(index) { selected.value = String(index); exportHelp.value = true }

async function remove(entry) {
  const ok = askConfirm
    ? await askConfirm({
        title: t('browser.passwords.removeTitle', 'Remove this login from Tessel?'),
        text: t('browser.passwords.removeText', '{{user}} on {{site}}. It stays saved in your browser.', { user: entry.username || t('browser.passwords.noUser', '(no username)'), site: entry.site }),
        confirmLabel: t('browser.passwords.removeConfirm', 'Remove'),
        danger: true
      })
    : true
  if (ok === true) return run(() => api().passwordChange({ id: entry.id, action: 'delete' }), changed)
}
function setAllow(entry, on) { return run(() => api().passwordChange({ id: entry.id, action: 'allow', allowAgents: on }), changed) }
function fill(entry) { return run(() => api().passwordFill(props.guestId, entry.id), () => t('browser.passwords.filled', 'Login filled. The form was not submitted.')) }

// Sorted by site, then username. The search looks at site and username only.
const rows = computed(() =>
  entries.value
    .map((e) => {
      const site = String(e.origin || '').replace(/^https:\/\//, '')
      const username = String(e.username || '')
      return { id: e.id, origin: e.origin, site, username, allowAgents: e.allowAgents === true, key: `${site}\n${username}`.toLowerCase() }
    })
    .sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : a.username < b.username ? -1 : a.username > b.username ? 1 : 0))
)
const terms = computed(() => query.value.trim().toLowerCase().split(/\s+/).filter(Boolean))
const filtered = computed(() => (terms.value.length ? rows.value.filter((r) => terms.value.every((w) => r.key.includes(w))) : rows.value))
const visible = computed(() => filtered.value.slice(0, limit.value).map((r, i, all) => ({ ...r, same: i > 0 && all[i - 1].site === r.site })))
const remaining = computed(() => filtered.value.length - visible.value.length)
const allowedCount = computed(() => rows.value.filter((r) => r.allowAgents).length)
watch(query, () => { limit.value = PAGE })

const countLabel = computed(() => (terms.value.length
  ? t('browser.passwords.shown', '{{shown}} of {{total}}', { shown: filtered.value.length, total: rows.value.length })
  : t('browser.passwords.total', '{{count}} accounts', { count: rows.value.length })))
const agentsLabel = computed(() => t('browser.passwords.agentsCount', '{{count}} allowed for agents', { count: allowedCount.value }))
const noMatchLabel = computed(() => t('browser.passwords.noMatch', 'No account matches “{{query}}”.', { query: query.value.trim() }))
const moreLabel = computed(() => t('browser.passwords.more', 'Show more ({{count}} left)', { count: remaining.value }))
const progressLabel = computed(() => (progress.value ? t('browser.passwords.importing', 'Importing {{done}} of {{total}}…', progress.value) : ''))
const allowLabel = (r) => t('browser.passwords.allowFor', 'Allow my local agents to use {{user}} on {{site}}', { user: r.username || t('browser.passwords.noUser', '(no username)'), site: r.site })
const removeLabel = (r) => t('browser.passwords.removeFor', 'Remove {{user}} on {{site}} from Tessel', { user: r.username || t('browser.passwords.noUser', '(no username)'), site: r.site })

function onSearchEsc(e) {
  if (!query.value) return
  e.stopPropagation(); query.value = ''
}
watch(() => props.guestId, () => { open.value = false; entries.value = [] })
</script>

<template>
  <button type="button" class="bp-btn" :title="t('browser.passwords.title', 'Saved passwords')" :aria-label="t('browser.passwords.title', 'Saved passwords')" data-test="browser-passwords" @click="show"><KeyRound :size="16" /></button>
  <Teleport to="body">
    <div v-if="open" class="help-backdrop" @pointerdown.self="open = false" @keydown.esc="open = false">
      <section class="help-card pw-card" role="dialog" aria-modal="true" :aria-label="t('browser.passwords.title', 'Saved passwords')">
        <header class="pw-head">
          <h2><KeyRound :size="16" aria-hidden="true" />{{ t('browser.passwords.title', 'Saved passwords') }}</h2>
          <button type="button" class="pw-icon" :title="t('browser.passwords.close', 'Close')" :aria-label="t('browser.passwords.close', 'Close')" @click="open = false"><X :size="16" /></button>
        </header>

        <div class="pw-bar">
          <div class="pw-import">
            <button type="button" class="exit-btn primary pw-all" data-test="pw-import-all" :disabled="busy || !sources.length" @click="importAll">
              <Download :size="13" aria-hidden="true" />{{ progress ? progressLabel : t('browser.passwords.importAll', 'Import from all browsers') }}
            </button>
            <ThemedSelect v-model="selected" class="pw-source" :disabled="busy || !sources.length" :aria-label="t('browser.passwords.profile', 'Browser profile')"><option v-for="(source, i) in sources" :key="i" :value="String(i)">{{ source.label }}</option></ThemedSelect>
            <button type="button" class="exit-btn" data-test="pw-import-one" :disabled="busy || selected === ''" @click="importSelectedProfile">{{ t('browser.passwords.importOne', 'Import this profile') }}</button>
            <button type="button" class="exit-btn" data-test="pw-import-csv" :disabled="busy" @click="importCsv"><FileUp :size="13" aria-hidden="true" />{{ t('browser.passwords.importCsv', 'Import CSV…') }}</button>
          </div>
          <p v-if="!busy && !sources.length" class="set-hint">{{ t('browser.passwords.noSources', 'No browser with saved passwords was found on this computer. Import a CSV export instead.') }}</p>
          <div class="pw-search-row">
            <label class="pw-search">
              <Search :size="13" aria-hidden="true" />
              <input ref="searchEl" v-model="query" type="search" spellcheck="false" data-test="pw-search" :placeholder="t('browser.passwords.search', 'Search sites and usernames')" :aria-label="t('browser.passwords.search', 'Search sites and usernames')" @keydown.esc="onSearchEsc" />
            </label>
            <span class="set-hint" data-test="pw-count" aria-live="polite">{{ countLabel }}</span>
            <span v-if="rows.length" class="set-hint pw-agents" data-test="pw-agents" :title="t('browser.passwords.agentsHint', 'Agents can use an account only after you allow it here, one account at a time.')">{{ agentsLabel }}</span>
          </div>
          <p v-if="message" class="pw-message" :class="{ warn: messageWarn }" role="status">{{ message }}</p>
          <div v-if="results.length" class="pw-results" data-test="pw-results">
            <div class="pw-results-head">
              <strong>{{ resultsTitle || progressLabel }}</strong>
              <button type="button" class="pw-icon" :disabled="busy" :title="t('browser.passwords.dismiss', 'Hide')" :aria-label="t('browser.passwords.dismiss', 'Hide')" @click="results = []"><X :size="14" /></button>
            </div>
            <ul>
              <li v-for="r in results" :key="r.index" :class="{ warn: r.warn }" data-test="pw-result">
                <TriangleAlert v-if="r.warn" :size="13" aria-hidden="true" /><Check v-else :size="13" aria-hidden="true" />
                <span class="pw-result-label">{{ r.label }}</span>
                <span class="pw-result-text">{{ r.text }}</span>
                <button v-if="r.csv" type="button" class="exit-btn small" @click="exportFor(r.index)">{{ t('browser.passwords.howExport', 'How to export') }}</button>
              </li>
            </ul>
          </div>
        </div>

        <div class="pw-list" data-test="pw-list">
          <div v-if="rows.length" class="pw-row pw-list-head" aria-hidden="true">
            <span>{{ t('browser.passwords.site', 'Site') }}</span><span>{{ t('browser.passwords.username', 'Username') }}</span><span>{{ t('browser.passwords.agents', 'Agents') }}</span><span></span><span></span>
          </div>
          <div v-for="r in visible" :key="r.id" class="pw-row" data-test="pw-row">
            <span class="pw-site" :class="{ same: r.same }" :title="r.origin">{{ r.site }}</span>
            <span class="pw-user" :title="r.username">{{ r.username || t('browser.passwords.noUser', '(no username)') }}</span>
            <input type="checkbox" class="set-switch" :checked="r.allowAgents" :disabled="busy" :title="allowLabel(r)" :aria-label="allowLabel(r)" @change="setAllow(r, $event.target.checked)" />
            <button type="button" class="exit-btn small" :disabled="busy || guestId == null" :title="t('browser.passwords.fillHint', 'Fill this login on the page open in this browser (the form is not sent)')" @click="fill(r)">{{ t('browser.passwords.fillShort', 'Fill') }}</button>
            <button type="button" class="pw-icon danger" :disabled="busy" :title="removeLabel(r)" :aria-label="removeLabel(r)" @click="remove(r)"><Trash2 :size="14" /></button>
          </div>
          <p v-if="!busy && !rows.length" class="pw-empty">{{ t('browser.passwords.empty', 'No saved passwords yet. Import them from your browsers or from a CSV export.') }}</p>
          <p v-else-if="rows.length && !filtered.length" class="pw-empty" data-test="pw-no-match">{{ noMatchLabel }}</p>
          <button v-if="remaining > 0" type="button" class="exit-btn small pw-more" data-test="pw-more" @click="limit += PAGE">{{ moreLabel }}</button>
        </div>

        <footer class="pw-foot">
          <p class="set-hint">{{ t('browser.passwords.localShort', 'Encrypted on this computer, outside your projects, never sent through Live Share. Agent access is off for every account until you allow it.') }}</p>
          <details :open="exportHelp" class="set-more pw-export" @toggle="exportHelp = $event.target.open">
            <summary>{{ t('browser.passwords.exportHelp', 'How to export passwords for this browser') }}</summary>
            <p>{{ t('browser.passwords.csvHintShort', 'When a browser blocks the import, export its passwords as a CSV file and import that file. Passkeys and verification codes are not imported.') }}</p>
            <ol>
              <li>{{ t('browser.passwords.sameProfile', 'Open the original browser (not Tessel) and select this same profile:') }} <strong>{{ selectedSource?.label || t('browser.passwords.profile', 'Browser profile') }}</strong></li>
              <li>{{ exportSteps }}</li>
              <li>{{ t('browser.passwords.saveCsv', 'Confirm with your device password or Windows Hello if requested, then save the CSV on this computer, outside any shared project.') }}</li>
              <li>{{ t('browser.passwords.returnCsv', 'Return here, click Import CSV, and select the file you just saved.') }}</li>
              <li>{{ t('browser.passwords.removeCsv', 'After confirming the import, delete the CSV when no longer needed: it contains readable passwords. Do not send it in chat or through Live Share.') }}</li>
            </ol>
          </details>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.pw-card {
  display: flex;
  flex-direction: column;
  width: min(780px, 100%);
  max-height: calc(100vh - 60px);
  overflow: hidden;
  padding: 0;
}
.pw-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px 8px; }
.pw-head h2 { display: inline-flex; align-items: center; gap: 8px; margin: 0; color: var(--text-strong); font-size: 15px; font-weight: 600; }
.pw-bar { flex: 0 0 auto; display: grid; gap: 8px; padding: 0 16px 10px; border-bottom: 1px solid var(--border); }
.pw-bar p { margin: 0; }
.pw-import, .pw-search-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pw-import .exit-btn { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.pw-source { flex: 1 1 180px; min-width: 0; }
.pw-search {
  display: flex; flex: 1 1 220px; align-items: center; gap: 6px; height: 28px; padding: 0 8px;
  border: 1px solid var(--border-strong); border-radius: 6px; background: var(--term); color: var(--text-dim);
}
.pw-search:focus-within { border-color: var(--accent); }
.pw-search input { flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: transparent; color: var(--text-strong); font: inherit; font-size: 12px; }
.pw-agents { margin-left: auto; }
.pw-message { color: var(--text); font-size: 12px; line-height: 1.45; }
.pw-message.warn { color: var(--warn); }
.pw-results { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); font-size: 12px; }
.pw-results-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 6px 5px 10px; color: var(--text-strong); }
.pw-results ul { max-height: 22vh; margin: 0; padding: 0 10px 6px; overflow-y: auto; list-style: none; }
.pw-results li { display: flex; align-items: baseline; gap: 6px; padding: 3px 0; border-top: 1px solid var(--border); color: var(--text); line-height: 1.4; }
.pw-results li > svg { flex: 0 0 auto; align-self: center; color: var(--ok, #4caf7a); }
.pw-results li.warn > svg { color: var(--warn); }
.pw-result-label { flex: 0 0 auto; max-width: 40%; overflow: hidden; color: var(--text-strong); text-overflow: ellipsis; white-space: nowrap; }
.pw-result-text { flex: 1; min-width: 0; color: var(--text-dim); }
.pw-results li .exit-btn { align-self: center; }
.pw-list { flex: 1 1 auto; min-height: 96px; overflow-y: auto; }
.pw-row {
  display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) 40px auto 26px; align-items: center; gap: 10px;
  min-height: 32px; padding: 2px 16px; border-bottom: 1px solid var(--border); font-size: 12.5px;
}
.pw-row:not(.pw-list-head):hover { background: var(--surface-2); }
.pw-list-head { position: sticky; top: 0; z-index: 1; min-height: 26px; background: var(--surface); color: var(--text-dim); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.pw-site, .pw-user { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-site { color: var(--text-strong); }
.pw-site.same { color: var(--text-dim); }
.pw-user { color: var(--text); }
.pw-icon {
  display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--text-dim); cursor: pointer;
}
.pw-icon:hover { background: var(--surface-3); color: var(--text-strong); }
.pw-icon.danger:hover { background: color-mix(in srgb, var(--danger) 25%, transparent); color: #ffb4b6; }
.pw-icon:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.pw-icon:disabled, .exit-btn:disabled, .set-switch:disabled { opacity: 0.5; cursor: default; }
.pw-empty { margin: 0; padding: 18px 16px; color: var(--text-dim); font-size: 12.5px; text-align: center; }
.pw-more { margin: 10px auto; display: flex; }
.pw-foot { flex: 0 0 auto; max-height: 38vh; overflow-y: auto; padding: 8px 16px 12px; border-top: 1px solid var(--border); }
.pw-foot p { margin: 0 0 4px; line-height: 1.45; }
.pw-export p, .pw-export ol { margin: 6px 0 0; color: var(--text); }
.pw-export ol { padding-left: 20px; }
.pw-export li { margin: 4px 0; }
@media (max-width: 560px) {
  .pw-row { grid-template-columns: minmax(0, 1fr) 40px auto 26px; row-gap: 0; padding-top: 4px; padding-bottom: 4px; }
  .pw-site { grid-column: 1; grid-row: 1; }
  .pw-user { grid-column: 1; grid-row: 2; color: var(--text-dim); }
  .pw-row > .set-switch, .pw-row > .exit-btn, .pw-row > .pw-icon { grid-row: 1 / span 2; }
  .pw-list-head { display: none; }
  .pw-agents { margin-left: 0; }
}
</style>
