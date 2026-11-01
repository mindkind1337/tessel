<script setup>
// Settings > MCP servers: the MCP servers window (McpDialog.vue) in the page.
import { t } from '../../i18n'
import McpDialog from '../McpDialog.vue'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

defineProps({
  // Built-in and your own agents, with `available` (found on the PATH).
  agents: { type: Array, default: () => [] },
  // The current workspace's project folder (the Skills and MCP servers pages).
  projectCwd: { type: String, default: null }
})
const { page, searching, shown, go, mcpTab, emit } = useSettingsShell()
</script>

<template>
  <section id="set-mcp" class="set-page" data-page="mcp" :hidden="!shown('mcp')" aria-labelledby="set-mcp-title">
    <header class="set-page-head">
      <h2 id="set-mcp-title">{{ PAGES.mcp.title }}</h2>
      <p class="set-page-desc">{{ PAGES.mcp.desc }}</p>
    </header>
    <div class="set-group">
      <div v-if="page === 'mcp' && !searching" class="set-card set-card-pad">
        <McpDialog
          embedded
          :cwd="projectCwd"
          :agents="agents"
          :initial-tab="mcpTab"
          @run="emit('run-job', $event)"
          @tools="go('devtools')"
          @skills="go('skills')"
          @orchestration="go('orchestration')"
          @connections="go('connections')"
        />
      </div>
      <div v-else class="set-row">
        <div class="set-label">{{ t('settings.mcp.installed', 'Installed servers') }}
          <span class="set-hint">{{ t('settings.mcp.installedHint', 'Every MCP server of your agents, the catalog and your own servers.') }}</span>
        </div>
        <button type="button" class="exit-btn" @click="go('mcp')">{{ t('settings.mcp.open', 'Open MCP servers') }}</button>
      </div>
    </div>
  </section>
</template>
