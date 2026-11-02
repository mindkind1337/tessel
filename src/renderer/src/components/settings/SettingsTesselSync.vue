<script setup>
// Settings > Tessel account > Your settings everywhere (main's settingsSync.js). The phrase is
// typed here, goes to the main process in the one call that uses it, and is forgotten here at
// that moment: this page never holds it longer, and never gets a key or a token.
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../../i18n'
import { useSettingsShell } from './settingsShell'

const { shown } = useSettingsShell()
const askConfirm = inject('askConfirm', null)
const saveBeforeBackup = inject('saveBeforeBackup', null)
const restartApp = inject('restartApp', null)

const MIN_PHRASE = 12
const api = () => window.shellApi?.tesselSync

const state = ref(null) // main's view()
const working = ref(false)
const error = ref('')
const form = ref(null) // the phrase form: { copy: { device, at } | null, startOver: boolean }
const phrase = ref('')
const again = ref('')
const turningOff = ref(false)
const eraseToo = ref(false)
const restarting = ref(false)

const when = (at) => (at ? new Date(at).toLocaleString() : t('settings.tesselAccount.sync.unknownTime', 'at an unknown time'))
const busy = computed(() => working.value || !!state.value?.busy)
const choosing = computed(() => !!form.value && (!form.value.copy || form.value.startOver))

const errorText = (code) =>
  ({
    shortPhrase: () => t('settings.tesselAccount.sync.error.shortPhrase', 'Choose a phrase of at least {{count}} characters.', { count: MIN_PHRASE }),
    mismatch: () => t('settings.tesselAccount.sync.error.mismatch', 'The two phrases are not the same.'),
    wrongPhrase: () => t('settings.tesselAccount.sync.error.wrongPhrase', 'This phrase does not open your copy on the server, or the copy was damaged. Nothing changed.'),
    tampered: () => t('settings.tesselAccount.sync.error.tampered', 'The copy on the server could not be opened: it was changed or damaged. Nothing changed here.'),
    newerApp: () => t('settings.tesselAccount.sync.error.newerApp', 'This copy comes from a newer Tessel. Update Tessel first. Nothing changed here.'),
    changedAgain: () => t('settings.tesselAccount.sync.error.changedAgain', 'The copy on the server changed again. Look at it below and choose again.'),
    tooBig: () => t('settings.tesselAccount.sync.error.tooBig', 'Your setup is too big to sync, even compressed. Nothing was sent. It starts again once it is smaller: your task board is usually what grows.'),
    offline: () => t('settings.tesselAccount.sync.error.offline', 'Tessel could not reach its server. Nothing changed. Check your connection and try again.'),
    signedOut: () => t('settings.tesselAccount.error.signedOut', 'Your session ended. Sign in again.'),
    rateLimited: () => t('settings.tesselAccount.error.rateLimited', 'Too many tries. Wait a minute, then try again.'),
    noSecureStorage: () => t('settings.tesselAccount.sync.error.noSecureStorage', 'Secure storage is not available on this computer, so Tessel cannot keep your key here.'),
    restart: () => t('settings.tesselAccount.sync.error.restart', 'Tessel could not restart by itself. Close it and open it again to apply them.'),
    failed: () => t('settings.tesselAccount.sync.error.failed', 'That did not work. Nothing changed. Try again.')
  }[code] || (() => ''))()

// What went wrong by itself, in the background: said quietly, and it tries again.
const problemText = computed(() => {
  const code = state.value?.problem
  if (!code || code === 'signedOut' || error.value === code) return ''
  // The row of a damaged copy already says it.
  if (code === 'tampered' && state.value.remote?.unreadable) return ''
  return (
    {
      offline: t('settings.tesselAccount.sync.problem.offline', 'Tessel cannot reach its server right now. It tries again by itself.'),
      failed: t('settings.tesselAccount.sync.problem.failed', 'The last sync did not work. It tries again by itself.'),
      rateLimited: t('settings.tesselAccount.sync.problem.rateLimited', 'Too many saves on the server for now. It tries again by itself later.')
    }[code] || errorText(code)
  )
})

const stateLabel = computed(() => {
  const s = state.value
  if (!s) return ''
  if (s.state === 'staged') return t('settings.tesselAccount.sync.state.staged', 'Waiting for a restart')
  if (s.state === 'newer') return t('settings.tesselAccount.sync.state.newer', 'Waiting for your choice')
  if (s.state === 'needsPhrase') return t('settings.tesselAccount.sync.state.needsPhrase', 'Needs your phrase')
  return t('settings.tesselAccount.sync.state.on', 'On')
})

const newerText = computed(() => {
  const remote = state.value?.remote
  if (!remote) return ''
  const words = { device: remote.device, date: when(remote.at) }
  if (remote.unreadable) return t('settings.tesselAccount.sync.unreadable', 'A copy from {{device}}, saved {{date}}, could not be opened: it was changed or damaged. Nothing changed here. You can replace it with this computer\'s setup.', words)
  if (remote.older) return t('settings.tesselAccount.sync.older', 'The copy on the server, from {{device}}, saved {{date}}, is older than the one this computer last saw. If you did not expect that, keep this computer\'s.', words)
  if (remote.first) return t('settings.tesselAccount.sync.first', 'A copy from {{device}}, saved {{date}}, is on the server. Use it here, or keep this computer\'s setup, which replaces it.', words)
  return t('settings.tesselAccount.sync.newer', 'Newer settings from {{device}}, saved {{date}}.', words)
})

// Words with values in them: a template's own braces would end at theirs.
const lastText = computed(() => (state.value?.lastSyncAt ? t('settings.tesselAccount.sync.last', 'Last synced {{date}}', { date: when(state.value.lastSyncAt) }) : t('settings.tesselAccount.sync.never', 'Not synced yet')))
const deviceText = computed(() => t('settings.tesselAccount.sync.thisComputer', 'This computer: {{device}}', { device: state.value?.device || '' }))
const stagedText = computed(() => t('settings.tesselAccount.sync.staged', 'The settings from {{device}} are ready. They apply when Tessel next starts, and Tessel does not restart by itself.', { device: state.value?.staged?.device || '' }))
const missingText = computed(() => t('settings.tesselAccount.sync.missingFolders', 'Not on this computer: {{folders}}. Those projects stay in the list and their terminals start in your home folder.', { folders: (state.value?.staged?.missing || []).join(', ') }))
const enterHint = computed(() => t('settings.tesselAccount.sync.enterHint', 'A copy from {{device}}, saved {{date}}, is on the server. Enter the phrase you chose for it. Nothing changes on this computer until you say so.', { device: form.value?.copy?.device || '', date: when(form.value?.copy?.at) }))
const chooseHint = computed(() => t('settings.tesselAccount.sync.chooseHint', 'At least {{count}} characters. It never leaves this computer, and it is asked once on each of your computers. Write it down: if you lose it, nobody can recover it, not even Tessel, and starting over erases the copy on the server.', { count: MIN_PHRASE }))

const clearPhrase = () => {
  phrase.value = ''
  again.value = ''
}

async function refresh(check = false) {
  if (!api()) return
  try {
    const res = await api().status({ check })
    if (res && res.state) state.value = res
  } catch {
    /* shown as it was */
  }
}

async function act(run) {
  working.value = true
  error.value = ''
  try {
    const res = await run()
    if (res) {
      if (res.state) state.value = res
      if (res.error) error.value = res.error
    }
    return res
  } catch {
    error.value = 'failed'
    return null
  } finally {
    working.value = false
  }
}

async function confirm(message) {
  return askConfirm ? askConfirm(message) : window.confirm(message.title)
}

// What is on disk is what is sent: the window writes its latest state first.
async function saveFirst() {
  try {
    if (saveBeforeBackup) await saveBeforeBackup()
  } catch {
    /* what is on disk is sent */
  }
}

async function openForm() {
  const res = await act(() => api().peek())
  if (!res || res.error) return
  clearPhrase()
  form.value = { copy: res.copy || null, startOver: false }
}
function closeForm() {
  clearPhrase()
  form.value = null
  error.value = ''
}

async function submitPhrase() {
  if (busy.value || !form.value) return
  const typed = phrase.value
  if ([...typed.normalize('NFKC').trim()].length < MIN_PHRASE && choosing.value) {
    error.value = 'shortPhrase'
    return
  }
  if (choosing.value && typed !== again.value) {
    error.value = 'mismatch'
    return
  }
  const startingOver = !!form.value.startOver
  if (startingOver) {
    const ok = await confirm({
      title: t('settings.tesselAccount.sync.startOverConfirm', 'Erase the copy on the server and start over?'),
      text: t('settings.tesselAccount.sync.startOverDetail', 'The copy on the server is erased for good: nobody can recover what your old phrase protected. A new copy is made from this computer, and your other computers ask for the new phrase.'),
      confirmLabel: t('settings.tesselAccount.sync.startOverButton', 'Erase and start over'),
      danger: true
    })
    if (!ok) return
  }
  clearPhrase()
  await saveFirst()
  const res = await act(() => (startingOver ? api().startOver(typed) : api().turnOn(typed)))
  if (res && !res.error) form.value = null
}

async function syncNow() {
  await saveFirst()
  await act(() => api().syncNow())
}

async function applyRemote() {
  const remote = state.value?.remote
  if (!remote) return
  const ok = await confirm({
    title: t('settings.tesselAccount.sync.applyConfirm', 'Use the settings from {{device}}?', { device: remote.device }),
    text: t('settings.tesselAccount.sync.applyDetail', 'They replace this computer\'s settings, projects, SSH hosts and task board when Tessel next starts. Tessel does not restart by itself. At that start, terminals and agents running here that are not in that layout are closed. What decides what agents may do stays as it is here. Agents come back asleep, and those whose folder is not on this computer come back as plain terminals. The files they replace are kept in the import-backups folder of Tessel\'s data folder.'),
    confirmLabel: t('settings.tesselAccount.sync.applyButton', 'Use them')
  })
  if (ok) await act(() => api().apply())
}

async function keepMine() {
  const remote = state.value?.remote
  if (!remote) return
  const ok = await confirm({
    title: t('settings.tesselAccount.sync.keepConfirm', 'Keep this computer\'s setup?'),
    text: t('settings.tesselAccount.sync.keepDetail', 'It replaces the copy from {{device}} on the server, and your other computers are offered it.', { device: remote.device }),
    confirmLabel: t('settings.tesselAccount.sync.keepButton', 'Keep this computer\'s')
  })
  if (!ok) return
  await saveFirst()
  await act(() => api().keepMine())
}

const cancelApply = () => act(() => api().cancelApply())

async function restartNow() {
  if (restarting.value) return
  const ok = await confirm({
    title: t('settings.tesselAccount.sync.restartConfirm', 'Restart Tessel now?'),
    text: t('settings.tesselAccount.sync.restartDetail', 'Tessel closes and opens again with these settings. Terminals and agents running here that are not in that layout are closed. Those in it keep running.'),
    confirmLabel: t('settings.tesselAccount.sync.restartButton', 'Restart now'),
    danger: true
  })
  if (!ok) return
  error.value = ''
  restarting.value = true
  const res = restartApp ? await new Promise((resolve) => restartApp(resolve)) : null
  if (!res || !res.ok) {
    restarting.value = false
    if (res?.reason !== 'cancelled') error.value = 'restart'
  }
}

function openTurnOff() {
  eraseToo.value = false
  turningOff.value = true
}

async function confirmTurnOff() {
  if (eraseToo.value) {
    const ok = await confirm({
      title: t('settings.tesselAccount.sync.eraseConfirm', 'Erase the copy on the server?'),
      text: t('settings.tesselAccount.sync.eraseDetail', 'Nothing on this computer changes. Your other computers stop syncing when they next look, and keep what they have.'),
      confirmLabel: t('settings.tesselAccount.sync.eraseButton', 'Turn off and erase'),
      danger: true
    })
    if (!ok) return
  }
  const res = await act(() => api().turnOff({ erase: eraseToo.value }))
  if (res && !res.error) turningOff.value = false
}

// Asks the server when the page opens; meanwhile, what the background part says.
watch(
  () => shown('tessel-account'),
  (open) => {
    if (open) refresh(true)
  },
  { immediate: true }
)
const stopChanged = api()?.onChanged?.((view) => {
  if (view) state.value = view
})
onBeforeUnmount(() => {
  stopChanged?.()
  clearPhrase()
})
</script>

<template>
  <div v-if="state && api()" class="set-group" data-sync>
    <h3 class="set-group-title">{{ t('settings.tesselAccount.itemSync', 'Your settings everywhere') }}</h3>
    <div class="set-card">
      <!-- Off -->
      <div v-if="!state.on && !form" class="set-row">
        <div class="set-label">
          {{ t('settings.tesselAccount.sync.offTitle', 'Keep your settings and projects on every computer') }}
          <span class="set-hint">{{ t('settings.tesselAccount.sync.offHint', 'Your settings, projects, SSH hosts and task board, encrypted on this computer with a phrase only you know, so Tessel\'s server cannot read them. Sign-ins, passwords and what decides what agents may do never leave this computer.') }}</span>
        </div>
        <button type="button" class="exit-btn primary tessel-sync-on" :disabled="busy || !state.canSeal" @click="openForm">{{ t('settings.tesselAccount.sync.turnOn', 'Turn on') }}</button>
      </div>

      <!-- On -->
      <div v-if="state.on" class="set-row">
        <div class="set-label">
          <span class="tessel-sync-title">{{ t('settings.tesselAccount.sync.onTitle', 'Sync') }} <span class="tag" :class="state.state === 'on' ? 'tag-ok' : 'tag-warn'" data-sync-state>{{ stateLabel }}</span></span>
          <span class="set-hint" data-sync-last>{{ lastText }}</span>
          <span class="set-hint" data-sync-device>{{ deviceText }}</span>
          <span class="set-hint">{{ t('settings.tesselAccount.sync.lostHint', 'If you lose your phrase, nobody can recover it, not even Tessel. Starting over erases the copy on the server.') }}</span>
        </div>
        <div class="set-inline">
          <button v-if="state.state === 'on'" type="button" class="exit-btn tessel-sync-now" :disabled="busy" @click="syncNow">{{ t('settings.tesselAccount.sync.now', 'Sync now') }}</button>
          <button v-if="!turningOff" type="button" class="exit-btn tessel-sync-off" :disabled="busy" @click="openTurnOff">{{ t('settings.tesselAccount.sync.turnOff', 'Turn off') }}</button>
        </div>
      </div>

      <!-- Turning off -->
      <div v-if="state.on && turningOff" class="set-row" data-sync-off-panel>
        <div class="set-label">
          <label class="tessel-sync-choice">
            <input v-model="eraseToo" type="checkbox" class="tessel-sync-erase" />
            {{ t('settings.tesselAccount.sync.eraseToo', 'Also erase the copy on the server') }}
          </label>
          <span class="set-hint">{{ t('settings.tesselAccount.sync.eraseHint', 'Your settings on this computer are not touched either way. Without erasing, the encrypted copy stays on the server for your other computers.') }}</span>
        </div>
        <div class="set-inline">
          <button type="button" class="exit-btn" :class="{ danger: eraseToo }" data-sync-off-confirm :disabled="busy" @click="confirmTurnOff">{{ t('settings.tesselAccount.sync.turnOff', 'Turn off') }}</button>
          <button type="button" class="exit-btn" data-sync-off-cancel :disabled="busy" @click="turningOff = false">{{ t('settings.tesselAccount.cancel', 'Cancel') }}</button>
        </div>
      </div>

      <!-- A copy to choose about -->
      <div v-if="state.state === 'newer' && state.remote" class="set-row" data-sync-newer>
        <div class="set-label">
          {{ newerText }}
          <span class="set-hint">{{ t('settings.tesselAccount.sync.choiceHint', 'Nothing changes and nothing is sent until you choose.') }}</span>
        </div>
        <div class="set-inline">
          <button v-if="!state.remote.unreadable" type="button" class="exit-btn primary tessel-sync-apply" :disabled="busy" @click="applyRemote">{{ t('settings.tesselAccount.sync.applyButton', 'Use them') }}</button>
          <button type="button" class="exit-btn tessel-sync-keep" :disabled="busy" @click="keepMine">{{ t('settings.tesselAccount.sync.keepButton', 'Keep this computer\'s') }}</button>
        </div>
      </div>

      <!-- Staged -->
      <div v-if="state.state === 'staged' && state.staged" class="set-row" data-sync-staged>
        <div class="set-label">
          {{ stagedText }}
          <span v-if="state.staged.missing.length" class="set-hint" data-sync-missing>
            {{ missingText }}
          </span>
        </div>
        <div class="set-inline">
          <button v-if="restartApp" type="button" class="exit-btn primary tessel-sync-restart" :disabled="restarting || busy" @click="restartNow">
            {{ restarting ? t('settings.tesselAccount.sync.restarting', 'Restarting…') : t('settings.tesselAccount.sync.restartButton', 'Restart now') }}
          </button>
          <button type="button" class="exit-btn tessel-sync-cancel-apply" :disabled="restarting || busy" @click="cancelApply">{{ t('settings.tesselAccount.cancel', 'Cancel') }}</button>
        </div>
      </div>

      <!-- Needs the phrase -->
      <div v-if="state.state === 'needsPhrase' && !form" class="set-row" data-sync-needs-phrase>
        <div class="set-label">
          {{ t('settings.tesselAccount.sync.needsPhrase', 'This computer can no longer open your copy: the phrase changed on another computer, or this computer\'s key could not be read. Enter your phrase to go on. Nothing is sent until then.') }}
        </div>
        <button type="button" class="exit-btn primary tessel-sync-enter" :disabled="busy" @click="openForm">{{ t('settings.tesselAccount.sync.enterPhrase', 'Enter your phrase') }}</button>
      </div>

      <!-- The phrase -->
      <form v-if="form" class="tessel-sync-form" data-sync-form autocomplete="off" @submit.prevent="submitPhrase">
        <div class="set-label">
          <template v-if="form.startOver">
            {{ t('settings.tesselAccount.sync.startOverTitle', 'Start over with a new phrase') }}
            <span class="set-hint">{{ t('settings.tesselAccount.sync.startOverHint', 'This erases the copy on the server and makes a new one from this computer. Your other computers ask for the new phrase. What the old phrase protected cannot be recovered.') }}</span>
          </template>
          <template v-else-if="form.copy">
            {{ t('settings.tesselAccount.sync.enterTitle', 'Enter your sync phrase') }}
            <span class="set-hint">{{ enterHint }}</span>
          </template>
          <template v-else>
            {{ t('settings.tesselAccount.sync.chooseTitle', 'Choose a sync phrase') }}
            <span class="set-hint">{{ chooseHint }}</span>
          </template>
        </div>
        <div class="tessel-sync-fields">
          <input
            v-model="phrase"
            class="set-number tessel-sync-phrase"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('settings.tesselAccount.sync.phrase', 'Sync phrase')"
            :aria-label="t('settings.tesselAccount.sync.phrase', 'Sync phrase')"
          />
          <input
            v-if="choosing"
            v-model="again"
            class="set-number tessel-sync-again"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :placeholder="t('settings.tesselAccount.sync.again', 'The same phrase again')"
            :aria-label="t('settings.tesselAccount.sync.again', 'The same phrase again')"
          />
        </div>
        <div class="tessel-sync-buttons">
          <button type="submit" class="exit-btn tessel-sync-submit" :class="form.startOver ? 'danger' : 'primary'" :disabled="busy || !phrase">
            {{ form.startOver ? t('settings.tesselAccount.sync.startOverButton', 'Erase and start over') : t('settings.tesselAccount.sync.turnOn', 'Turn on') }}
          </button>
          <button type="button" class="exit-btn tessel-sync-form-cancel" :disabled="busy" @click="closeForm">{{ t('settings.tesselAccount.cancel', 'Cancel') }}</button>
          <button v-if="form.copy && !form.startOver" type="button" class="sl-link tessel-sync-lost" :disabled="busy" @click="(form.startOver = true), clearPhrase(), (error = '')">{{ t('settings.tesselAccount.sync.lost', 'I lost my phrase') }}</button>
        </div>
      </form>
    </div>

    <p v-if="!state.canSeal && !state.on" class="set-hint tessel-sync-note">{{ errorText('noSecureStorage') }}</p>
    <p v-if="state.notice === 'erased'" class="mcp-notice tessel-sync-note" role="status" data-sync-erased>{{ t('settings.tesselAccount.sync.erasedElsewhere', 'The copy on the server was erased from another computer, so this one stopped syncing. Your settings here did not change.') }}</p>
    <p v-if="problemText" class="set-hint tessel-sync-note" data-sync-problem>{{ problemText }}</p>
    <p v-if="error" class="mcpc-invalid tessel-sync-note" role="alert" data-sync-error>{{ errorText(error) }}</p>
  </div>
</template>

<style scoped>
.tessel-sync-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.tessel-sync-choice {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tessel-sync-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 0;
}
.tessel-sync-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tessel-sync-fields input {
  flex: 1 1 220px;
  min-width: 0;
  width: auto;
}
.tessel-sync-buttons {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.tessel-sync-note {
  margin: 8px 0 0;
}
</style>
