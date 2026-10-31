<script setup>
import { computed, ref, watch } from 'vue'
import { KeyRound, X } from 'lucide-vue-next'
import { t } from '../i18n'
const props = defineProps({ guestId: { type: Number, default: null } })
const open = ref(false), busy = ref(false), entries = ref([]), sources = ref([]), selected = ref(''), message = ref('')
const api = () => window.shellApi?.browser
const exportHelp = ref(false)
const selectedSource = computed(() => sources.value[Number(selected.value)])
const exportSteps = computed(() => {
  const id = selectedSource.value?.browserId
  if (id === 'chrome') return t('browser.passwords.stepsChrome', 'In Chrome: menu ⋮ → Passwords and autofill → Google Password Manager → Settings. Under Export passwords, choose Download file.')
  if (id === 'edge') return t('browser.passwords.stepsEdge', 'In Edge: menu ⋯ (Alt+F) → Passwords → menu ⋯ → Export passwords → Export.')
  if (id === 'vivaldi') return t('browser.passwords.stepsVivaldi', 'In Vivaldi: Vivaldi menu → File → Export → Export Passwords.')
  if (id === 'opera' || id === 'opera-gx') return t('browser.passwords.stepsOpera', 'In Opera / Opera GX: Settings → Privacy & Security → Password Manager → Settings. Under Export passwords, choose Download file.')
  if (id === 'brave') return t('browser.passwords.stepsBrave', 'In Brave, enter brave://password-manager/settings in the address bar. Find Export passwords and download the CSV file.')
  return t('browser.passwords.stepsOther', 'Open the selected browser’s settings and password manager. Look for Export passwords and choose CSV. The menu location varies by browser version.')
})
const errors = {
  'private-page-required': ['private', 'The password vault is unavailable during Live Share and in guest tabs. Stop sharing before using it.'],
  'encryption-unavailable': ['encryption', 'Secure system encryption is unavailable. No passwords were saved.'],
  'vault-unavailable': ['vault', 'The encrypted vault could not be opened.'],
  'locked': ['locked', 'The browser database is locked. Close that browser and retry, or import its CSV export.'],
  'access-denied': ['denied', 'Browser protection or permissions prevent access. Use a CSV export.'],
  'no-sqlite': ['sqlite', 'This version cannot read browser databases. Update Tessel or import a CSV export.'],
  'unreadable': ['unreadable', 'The browser database could not be read. Import a CSV export instead.'],
  'missing': ['missing', 'The browser database no longer exists. Reopen this dialog and choose a profile.'],
  'not-found': ['missing', 'The browser database no longer exists. Reopen this dialog and choose a profile.'],
  'format': ['format', 'Expected a CSV export with url, username and password columns.'],
  'no-login-form': ['form', 'No single visible password field was found. Open the login form first.'],
  'unsafe-form': ['unsafe', 'This form sends credentials to another site or cannot be verified.'],
  'ambiguous-form': ['ambiguous', 'Several possible username fields were found. Fill this form manually.'],
  'https-required': ['https', 'Open the HTTPS login page first.']
}
function error(code) { const [key, text] = errors[code] || ['failed', 'The operation could not be completed.']; return t(`browser.passwords.${key}`, text) }
async function reload() {
  const result = await api()?.passwordList()
  entries.value = result?.entries || []
  if (!result?.ok) message.value = error(result?.code)
}
async function show() {
  open.value = true; message.value = ''; exportHelp.value = false; busy.value = true
  try {
    await reload()
    const r = await api()?.passwordSources()
    sources.value = (r?.sources || []).flatMap((b) => b.profiles.map((p) => ({ browserId: b.id, profileDir: p.dir, label: `${b.name} — ${p.name}` })))
    selected.value = sources.value.length ? '0' : ''
  } catch { message.value = error() } finally { busy.value = false }
}
async function run(action, success) {
  busy.value = true; message.value = ''
  try {
    const r = await action()
    if (r?.protectedCount > 0 || ['access-denied', 'locked', 'unreadable', 'no-sqlite'].includes(r?.code)) exportHelp.value = true
    if (r?.code === 'cancelled') return
    message.value = r?.ok ? success(r) : error(r?.code)
    await reload()
  } catch { message.value = error() } finally { busy.value = false }
}
const imported = (r) => t('browser.passwords.imported', '{{count}} imported; {{skipped}} skipped; {{protected}} protected (use CSV export).', { count: r.imported, skipped: r.skipped, protected: r.protectedCount || 0 })
const changed = () => t('browser.passwords.updated', 'Updated.')
function importSelectedProfile() {
  const source = sources.value[Number(selected.value)]
  if (!source) return
  // Vue proxies cannot be cloned across Electron IPC. Send only plain strings.
  return run(() => api().passwordImportProfile({ browserId: source.browserId, profileDir: source.profileDir }), imported)
}
watch(() => props.guestId, () => { open.value = false; entries.value = [] })
</script>

<template>
  <button type="button" class="bp-btn" :title="t('browser.passwords.title', 'Saved passwords')" :aria-label="t('browser.passwords.title', 'Saved passwords')" data-test="browser-passwords" @click="show"><KeyRound :size="16" /></button>
  <Teleport to="body">
    <div v-if="open" class="help-backdrop" @pointerdown.self="open = false" @keydown.esc="open = false">
      <section class="help-card passwords-card" role="dialog" aria-modal="true" :aria-label="t('browser.passwords.title', 'Saved passwords')">
        <header><h2>{{ t('browser.passwords.title', 'Saved passwords') }}</h2><button type="button" :aria-label="t('browser.passwords.close', 'Close')" @click="open = false"><X :size="18" /></button></header>
        <p>{{ t('browser.passwords.local', 'Encrypted on this computer, outside your projects. Never sent through Live Share. Agent access is off for every imported account until you enable it.') }}</p>
        <div class="password-actions">
          <select v-model="selected" :disabled="busy || !sources.length" :aria-label="t('browser.passwords.profile', 'Browser profile')"><option v-for="(source, i) in sources" :key="i" :value="String(i)">{{ source.label }}</option></select>
          <button type="button" :disabled="busy || selected === ''" @click="importSelectedProfile">{{ t('browser.passwords.importBrowser', 'Import from browser') }}</button>
          <button type="button" :disabled="busy" @click="run(() => api().passwordImportCsv(), imported)">{{ t('browser.passwords.importCsv', 'Import CSV…') }}</button>
        </div>
        <p class="password-hint">{{ t('browser.passwords.csvHint', 'If browser protection blocks import, export passwords from its password manager and select that CSV here. The export contains readable passwords; remove it after import when no longer needed. Passkeys and verification codes are not imported.') }}</p>
        <p v-if="message" role="status">{{ message }}</p>
        <details :open="exportHelp" class="password-export" @toggle="exportHelp = $event.target.open">
          <summary>{{ t('browser.passwords.exportHelp', 'How to export passwords for this browser') }}</summary>
          <ol>
            <li>{{ t('browser.passwords.sameProfile', 'Open the original browser (not Tessel) and select this same profile:') }} <strong>{{ selectedSource?.label || t('browser.passwords.profile', 'Browser profile') }}</strong></li>
            <li>{{ exportSteps }}</li>
            <li>{{ t('browser.passwords.saveCsv', 'Confirm with your device password or Windows Hello if requested, then save the CSV on this computer, outside any shared project.') }}</li>
            <li>{{ t('browser.passwords.returnCsv', 'Return here, click Import CSV, and select the file you just saved.') }}</li>
            <li>{{ t('browser.passwords.removeCsv', 'After confirming the import, delete the CSV when no longer needed: it contains readable passwords. Do not send it in chat or through Live Share.') }}</li>
          </ol>
          <button type="button" :disabled="busy" @click="run(() => api().passwordImportCsv(), imported)">{{ t('browser.passwords.importCsv', 'Import CSV…') }}</button>
        </details>
        <div class="password-entries">
          <article v-for="entry in entries" :key="entry.id">
            <strong>{{ entry.origin }}</strong><span>{{ entry.username }}</span>
            <label><input type="checkbox" :checked="entry.allowAgents" :disabled="busy" @change="run(() => api().passwordChange({ id: entry.id, action: 'allow', allowAgents: $event.target.checked }), changed)" />{{ t('browser.passwords.allowAgents', 'Allow my local agents to use this account') }}</label>
            <div class="password-actions">
              <button type="button" :disabled="busy || guestId == null" @click="run(() => api().passwordFill(guestId, entry.id), () => t('browser.passwords.filled', 'Login filled. The form was not submitted.'))">{{ t('browser.passwords.fill', 'Fill on this page') }}</button>
              <button type="button" :disabled="busy" @click="run(() => api().passwordChange({ id: entry.id, action: 'delete' }), changed)">{{ t('browser.passwords.delete', 'Remove from Tessel') }}</button>
            </div>
          </article>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.passwords-card { width: min(660px, 92vw); max-height: 85vh; overflow: auto; padding: 22px; }
header, .password-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
header { justify-content: space-between; } h2 { font-size: 17px; margin: 0; }
p { font-size: 13px; line-height: 1.5; } .password-hint { opacity: .75; }
.password-entries article { border-top: 1px solid var(--border, #444); padding: 12px 0; display: grid; gap: 8px; overflow-wrap: anywhere; }
.password-export { border-top: 1px solid var(--border, #444); padding: 12px 0; font-size: 13px; line-height: 1.5; }
.password-export summary { cursor: pointer; font-weight: 600; }
.password-export li { margin: 8px 0; }
button, select { color: inherit; background: var(--bg-secondary, #242830); border: 1px solid var(--border, #444); border-radius: 5px; padding: 6px 9px; }
button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; } label { font-size: 12px; }
</style>
