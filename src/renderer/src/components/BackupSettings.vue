<script setup>
// Settings > General > Backup: export Tessel's settings to one file, and import
// them back (src/main/settingsBackup.js). Nothing secret is in the file: sign-ins
// and saved passwords are not exported. An import is staged and put in place when
// Tessel starts again (the data folder is not rewritten while Tessel uses it).
import { computed, inject, ref } from 'vue'
import { t } from '../i18n'

const askConfirm = inject('askConfirm', null)
const saveBeforeBackup = inject('saveBeforeBackup', null)
const restartApp = inject('restartApp', null)
const isDev = !!window.shellApi.isDev

const CATEGORY_IDS = ['settings', 'hosts', 'board', 'liveshare', 'activity', 'security']
const label = (id) =>
  ({
    settings: t('settings.backup.cat.settings', 'Settings, projects and their layout'),
    hosts: t('settings.backup.cat.hosts', 'SSH hosts and their known keys'),
    board: t('settings.backup.cat.board', 'Task board'),
    liveshare: t('settings.backup.cat.liveshare', 'Live Share settings'),
    activity: t('settings.backup.cat.activity', 'Activity history'),
    security: t('settings.backup.cat.security', 'Commands and permissions: agent commands and rules, Yolo, SSH proxy commands and host keys, trusted guests and folders')
  })[id] || id

const exportChoice = ref(Object.fromEntries(CATEGORY_IDS.map((id) => [id, true])))
const busy = ref(false)
const exportNote = ref('')
const exportFailed = ref('')

const why = (code) =>
  ({
    'not-a-backup': t('settings.backup.err.notBackup', 'This file is not a Tessel settings file.'),
    newer: t('settings.backup.err.newer', 'This file comes from a newer Tessel. Update Tessel first.'),
    empty: t('settings.backup.err.empty', 'This file holds nothing Tessel can restore.'),
    'too-big': t('settings.backup.err.tooBig', 'This file is too big.'),
    'nothing-chosen': t('settings.backup.err.nothing', 'Choose at least one part to restore.')
  })[code] || t('settings.backup.err.failed', 'It did not work. Nothing was changed.')

async function doExport() {
  if (busy.value) return
  busy.value = true
  exportNote.value = ''
  exportFailed.value = ''
  try {
    const chosen = CATEGORY_IDS.filter((id) => exportChoice.value[id])
    if (!chosen.length) {
      exportFailed.value = why('nothing-chosen')
      return
    }
    // What is on disk is what is saved: write the latest first.
    if (saveBeforeBackup) await saveBeforeBackup()
    const r = await window.shellApi.backup.export(chosen)
    if (r && r.ok) exportNote.value = t('settings.backup.saved', 'Saved to {{path}}. Sign-ins and saved passwords are not in it.', { path: r.path })
    else if (r && r.code !== 'cancelled') exportFailed.value = why(r.code)
  } catch {
    exportFailed.value = why('')
  } finally {
    busy.value = false
  }
}

// --- import
const inspected = ref(null) // { token, summary }
const importChoice = ref({})
const importFailed = ref('')
const staged = ref(0)

const summaryDate = computed(() => {
  const at = inspected.value && inspected.value.summary.createdAt
  return at ? new Date(at).toLocaleString() : ''
})
const summaryWhat = computed(() => {
  const s = inspected.value && inspected.value.summary
  if (!s) return ''
  const from = [s.appVersion, s.build].filter(Boolean).join(' ')
  return from ? t('settings.backup.from', 'Made {{date}} by Tessel {{version}}', { date: summaryDate.value, version: from }) : t('settings.backup.fromDate', 'Made {{date}}', { date: summaryDate.value })
})

async function pick() {
  if (busy.value) return
  busy.value = true
  importFailed.value = ''
  staged.value = 0
  try {
    const r = await window.shellApi.backup.inspect()
    if (r && r.ok) {
      inspected.value = { token: r.token, summary: r.summary }
      // What decides what agents may do is only restored if the user ticks it: a file from
      // someone else must not decide that. Without it, those settings stay as they are here.
      importChoice.value = Object.fromEntries(r.summary.categories.map((c) => [c.id, c.id !== 'security']))
    } else if (r && r.code !== 'cancelled') {
      inspected.value = null
      importFailed.value = why(r.code)
    }
  } catch {
    importFailed.value = why('')
  } finally {
    busy.value = false
  }
}

async function apply() {
  if (busy.value || !inspected.value) return
  const chosen = inspected.value.summary.categories.map((c) => c.id).filter((id) => importChoice.value[id])
  if (!chosen.length) {
    importFailed.value = why('nothing-chosen')
    return
  }
  const question = {
    title: t('settings.backup.confirmTitle', 'Restore these settings?'),
    text: t('settings.backup.confirmText', 'They replace the current ones when Tessel starts again, and terminals that are not in the restored layout are closed. Only restore a file you made yourself. The files they replace are kept in the import-backups folder of Tessel’s data folder.'),
    confirmLabel: t('settings.backup.confirmApply', 'Restore'),
    danger: true
  }
  const ok = askConfirm ? await askConfirm(question) : window.confirm(question.title)
  if (!ok) return
  busy.value = true
  importFailed.value = ''
  try {
    const r = await window.shellApi.backup.apply(inspected.value.token, chosen)
    if (r && r.ok) {
      staged.value = r.count
      inspected.value = null
    } else importFailed.value = why(r && r.code)
  } catch {
    importFailed.value = why('')
  } finally {
    busy.value = false
  }
}

const stagedText = computed(() => t('settings.backup.staged', 'Ready: {{count}} file(s) will be restored when Tessel starts again.', { count: staged.value }))
const restarting = ref(false)
async function restartNow() {
  if (!restartApp || restarting.value) return
  restarting.value = true
  const r = await new Promise((resolve) => restartApp(resolve))
  if (!r || !r.ok) restarting.value = false
}
</script>

<template>
  <div class="set-group" data-group="backup" data-test="backup-settings">
    <h3 class="set-group-title">{{ t('settings.backup.title', 'Backup') }}</h3>
    <p class="set-group-desc">
      {{ t('settings.backup.intro', 'Save your settings in one file, and restore them if Tessel’s data folder is deleted or on another computer. Sign-ins (Claude, Codex…), saved passwords, keys and agents’ environment variables are never exported: you sign in again. Commands and URLs are saved as you wrote them, so keep secrets out of them.') }}
    </p>
    <div class="set-card">
      <div class="set-row set-foot">
        <div class="set-label">
          {{ t('settings.backup.export', 'Export settings') }}
          <span class="set-hint">{{ t('settings.backup.exportHint', 'Choose what goes in the file.') }}</span>
          <label v-for="id in CATEGORY_IDS" :key="id" class="set-hint backup-choice">
            <input v-model="exportChoice[id]" type="checkbox" :data-test="`backup-export-${id}`" /> {{ label(id) }}
          </label>
          <span v-if="exportNote" class="set-hint" data-test="backup-export-note">{{ exportNote }}</span>
          <span v-if="exportFailed" class="set-hint" data-test="backup-export-error">{{ exportFailed }}</span>
        </div>
        <button class="exit-btn" type="button" :disabled="busy" data-test="backup-export" @click="doExport">{{ t('settings.backup.exportButton', 'Export…') }}</button>
      </div>
      <div class="set-row set-foot">
        <div class="set-label">
          {{ t('settings.backup.import', 'Import settings') }}
          <span class="set-hint">{{ t('settings.backup.importHint', 'Pick a file made by Export. Nothing changes until you confirm, and it applies when Tessel starts again.') }}</span>
          <template v-if="inspected">
            <span class="set-hint" data-test="backup-summary">{{ summaryWhat }}</span>
            <label v-for="c in inspected.summary.categories" :key="c.id" class="set-hint backup-choice">
              <input v-model="importChoice[c.id]" type="checkbox" :data-test="`backup-import-${c.id}`" /> {{ label(c.id) }}
            </label>
          </template>
          <span v-if="importFailed" class="set-hint" data-test="backup-import-error">{{ importFailed }}</span>
          <template v-if="staged">
            <span class="set-hint" data-test="backup-staged">{{ stagedText }}</span>
            <span v-if="!isDev" class="set-hint">{{ t('settings.backup.restartManual', 'Close Tessel and open it again to apply them.') }}</span>
          </template>
        </div>
        <div class="set-inline">
          <button v-if="staged && isDev && restartApp" class="exit-btn primary" type="button" :disabled="restarting" data-test="backup-restart" @click="restartNow">
            {{ restarting ? t('app.devUpdate.restarting', 'Restarting…') : t('app.devUpdate.restartNow', 'Restart now') }}
          </button>
          <button v-if="inspected" class="exit-btn primary" type="button" :disabled="busy" data-test="backup-apply" @click="apply">{{ t('settings.backup.apply', 'Restore…') }}</button>
          <button class="exit-btn" type="button" :disabled="busy" data-test="backup-import" @click="pick">{{ t('settings.backup.importButton', 'Import…') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backup-choice {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
</style>
