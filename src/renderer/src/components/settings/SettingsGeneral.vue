<script setup>
// Settings > General: how Tessel starts and closes, the tessel command.
import { t } from '../../i18n'
import CliSettings from '../CliSettings.vue'
import BackupSettings from '../BackupSettings.vue'
import SettingsToolRows from '../SettingsToolRows.vue'
import SetupCheck from './SetupCheck.vue'
import { settings, resetSettings } from '../../settings'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'
import { inject } from 'vue'

const { page, searching, shown, emit } = useSettingsShell()

// Reset every setting: asked first (App.vue's askConfirm, else the browser's).
const askConfirm = inject('askConfirm', null)
async function resetAll() {
  const question = {
    title: t('settings.general.resetConfirmTitle', 'Reset every setting?'),
    text: t('settings.general.resetConfirmText', 'Every setting goes back to its default. Your workspaces, accounts and agents stay as they are.'),
    confirmLabel: t('settings.general.resetToDefaults', 'Reset to defaults'),
    danger: true
  }
  const ok = askConfirm ? await askConfirm(question) : window.confirm(question.title)
  if (ok) resetSettings()
}
</script>

<template>
  <section
    id="set-general"
    class="set-page"
    data-page="general"
    :hidden="!shown('general')"
    aria-labelledby="set-general-title"
  >
    <header class="set-page-head">
      <h2 id="set-general-title">{{ PAGES.general.title }}</h2>
      <p class="set-page-desc">{{ PAGES.general.desc }}</p>
    </header>
    <!-- What Tessel needs on this computer: problems first (SetupCheck.vue). -->
    <SetupCheck />
    <div class="set-group">
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.general.restore', 'Reopen my workspaces at launch') }}
            <span class="set-hint">{{ t('settings.general.restoreHint', 'Off starts with a single terminal') }}</span>
          </div>
          <input v-model="settings.restoreWorkspaces" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.general.confirmClose', 'Confirm before closing running terminals') }}
            <span class="set-hint">{{ t('settings.general.confirmCloseHint', 'Ask before stopping a running agent or command when closing a terminal.') }}</span>
          </div>
          <input v-model="settings.confirmCloseAgent" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.general.confirmQuit', 'Ask before quitting while agents or terminals run') }}
            <span class="set-hint">{{ t('settings.general.confirmQuitHint', 'Closing the window quits Tessel and stops every agent and terminal.') }}</span>
          </div>
          <input v-model="settings.confirmQuitRunning" type="checkbox" class="set-switch" />
        </label>
      </div>
    </div>
    <!-- The tessel command (Settings > General, as Orca's CLI section). -->
    <CliSettings v-if="page === 'general' || searching" />
    <!-- Export / import the settings (BackupSettings.vue). -->
    <BackupSettings v-if="page === 'general' || searching" />
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.general.workspace', 'Workspace') }}</h3>
      <p class="set-group-desc">{{ t('settings.general.workspaceIntro', 'Where new workspaces are created, and deleting them.') }}</p>
      <div class="set-card">
        <div class="set-row">
          <div class="set-label">
            <label for="settings-workspace-dir">{{ t('settings.general.workspaceDir', 'Workspace directory') }}</label>
            <span class="set-hint">{{ t('settings.general.workspaceDirHint', 'Where workspace folders go. Empty: next to the project.') }}</span>
            <details class="set-more">
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('settings.general.workspaceDirMore', 'A relative path (like .tessel/worktrees) puts them in each project; an absolute path in one shared folder. Empty: in <project>.worktrees, next to the project.') }}</p>
            </details>
          </div>
          <div class="set-inline">
            <input
              id="settings-workspace-dir"
              class="set-number mcp-input"
              spellcheck="false"
              :placeholder="t('settings.general.workspaceDirPlaceholder', '<project>.worktrees')"
              :value="settings.workspaceDir"
              @change="settings.workspaceDir = $event.target.value.trim()"
            />
            <button
              class="exit-btn"
              type="button"
              :disabled="!settings.workspaceDir"
              @click="settings.workspaceDir = ''"
            >
              {{ t('settings.common.reset', 'Reset') }}
            </button>
          </div>
        </div>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.general.confirmDelete', 'Ask before deleting workspaces') }}
            <span class="set-hint">{{ t('settings.general.confirmDeleteHint', 'When you delete one from its menu. Unsaved files are always asked about.') }}</span>
          </div>
          <input v-model="settings.confirmDeleteWorkspace" type="checkbox" class="set-switch" />
        </label>
      </div>
    </div>
    <SettingsToolRows page="general" :ids="['help', 'resources']" @open="emit('open-tool', $event)" />
    <!-- Logs & diagnostics, and the reset: what to reach for when something is wrong. -->
    <SettingsToolRows
      page="general"
      :ids="['logs', 'diagnostics']"
      :title="t('settings.general.troubleshooting', 'Troubleshooting')"
      data-group="troubleshooting"
      @open="emit('open-tool', $event)"
    >
      <div class="set-row set-foot">
        <div class="set-label">
          {{ t('settings.general.resetAll', 'Reset every setting') }}
          <span class="set-hint">{{ t('settings.general.resetAllHint', 'Puts every setting back to its default.') }}</span>
        </div>
        <button class="exit-btn danger" type="button" data-test="reset-settings" @click="resetAll">{{ t('settings.general.resetToDefaults', 'Reset to defaults') }}</button>
      </div>
    </SettingsToolRows>
  </section>
</template>
