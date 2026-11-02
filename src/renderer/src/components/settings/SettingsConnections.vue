<script setup>
// Settings > Connections: your accounts for the agents (ConnectionsPanel.vue),
// loaded only while the page shows: it reads every agent's servers.
import { t } from '../../i18n'
import ConnectionsPanel from './ConnectionsPanel.vue'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

defineProps({
  agents: { type: Array, default: () => [] },
  projectCwd: { type: String, default: null }
})
const { page, searching, shown, go, emit } = useSettingsShell()
</script>

<template>
  <section id="set-connections" class="set-page" data-page="connections" :hidden="!shown('connections')" aria-labelledby="set-connections-title">
    <header class="set-page-head">
      <h2 id="set-connections-title">{{ PAGES.connections.title }}</h2>
      <p class="set-page-desc">{{ PAGES.connections.desc }}</p>
    </header>
    <div class="set-group">
      <div v-if="page === 'connections' && !searching" class="set-card set-card-pad">
        <ConnectionsPanel :agents="agents" :cwd="projectCwd" @run="emit('run-job', $event)" @open-account="go('tessel-account')" @open-mcp="go('mcp')" />
      </div>
      <div v-else class="set-row">
        <div class="set-label">{{ t('settings.connections.services', 'Gmail, Outlook, Dropbox and other accounts') }}
          <span class="set-hint">{{ t('settings.connections.servicesHint', 'Connect them once, for all your agents.') }}</span>
        </div>
        <button type="button" class="exit-btn" @click="go('connections')">{{ t('settings.connections.open', 'Open Connections') }}</button>
      </div>
    </div>
  </section>
</template>
