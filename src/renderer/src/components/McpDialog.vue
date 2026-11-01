<script setup>
// MCP servers for every agent CLI (Claude Code, Codex, Gemini CLI, Qwen Code,
// Copilot CLI, OpenCode, Cline, Kimi Code, Cursor CLI, Antigravity CLI, Muse
// Code), in one place (components/mcp):
//   Installed - one row per server, the agents that have it and its last
//               test; its details: what it runs, each agent's copy (Test,
//               Remove, sign-in help) and "Add to…" the others.
//   Catalog   - popular servers in two panes, searchable, added one or
//               several at a time (asks only for what a server needs).
//   Custom    - any other server, by command or URL, tested before adding.
// The team connections (each agent's hooks for team messages) are not here:
// Settings > Orchestration shows them (mcp/McpTeamConnections.vue), and
// Installed links there. Only the agents installed here (or that already
// have servers) are shown. Running agents load changes when restarted.
import { ref, onMounted } from 'vue'
import { X } from 'lucide-vue-next'
import McpInstalled from './mcp/McpInstalled.vue'
import McpCatalog from './mcp/McpCatalog.vue'
import McpCustom from './mcp/McpCustom.vue'
import { useMcpState } from './mcp/mcpState'
import { tabKeys } from './mcp/mcpShared'
import { t } from '../i18n'

const props = defineProps({
  cwd: { type: String, default: null }, // current workspace's project folder
  agents: { type: Array, default: () => [] },
  // Open on this tab: 'installed', 'catalog' or 'custom' (anything else,
  // the old 'connections' included, opens Installed).
  initialTab: { type: String, default: 'installed' },
  // Shown as a Settings page: no backdrop, card, title bar or Escape to close.
  embedded: { type: Boolean, default: false }
})
const emit = defineEmits(['close', 'run', 'tools', 'skills', 'orchestration', 'connections'])

const TABS = ['installed', 'catalog', 'custom']
const m = useMcpState(props, emit)
const cardEl = ref(null)
const tab = ref(TABS.includes(props.initialTab) ? props.initialTab : 'installed')
const tabLabel = (id) =>
  id === 'installed' ? t('mcp.tab.installed', 'Installed') : id === 'catalog' ? t('mcp.tab.catalog', 'Catalog') : t('mcp.tab.custom', 'Custom')

// Escape closes the window; embedded in Settings, Settings handles it.
function onEscape(e) {
  if (props.embedded) return
  e.preventDefault()
  e.stopPropagation()
  emit('close')
}

onMounted(() => {
  if (cardEl.value && !props.embedded) cardEl.value.focus()
  m.refresh()
  m.checkTools()
})
</script>

<template>
  <div :class="embedded ? 'mcp-embedded' : 'help-backdrop'" @pointerdown.self="embedded || emit('close')">
    <div
      ref="cardEl"
      class="mcpd"
      :class="embedded ? 'mcp-embedded-body' : 'help-card mcp-card'"
      :role="embedded ? undefined : 'dialog'"
      :aria-label="embedded ? undefined : t('mcp.title', 'MCP servers')"
      :tabindex="embedded ? undefined : -1"
      @keydown.escape="onEscape"
    >
      <div v-if="!embedded" class="help-head">
        <span>{{ t('mcp.title', 'MCP servers') }}</span>
        <button class="tb-icon" :title="t('mcp.close', 'Close (Esc)')" :aria-label="t('mcp.close', 'Close (Esc)')" @click="emit('close')">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>

      <p class="mcp-intro">
        {{
          t('mcp.intro', "MCP servers give your agents extra tools: a browser, library docs, GitHub, your issue tracker. They're added with each agent's own command, so they also work outside this app.")
        }}
      </p>

      <div class="mcp-tabbar">
        <div class="launch-seg" role="tablist" :aria-label="t('mcp.title', 'MCP servers')" @keydown="tabKeys($event, TABS, tab, (v) => (tab = v))">
          <button
            v-for="id in TABS"
            :id="'mcpd-tab-' + id"
            :key="id"
            type="button"
            role="tab"
            class="launch-seg-btn"
            :class="{ on: tab === id }"
            :aria-selected="tab === id ? 'true' : 'false'"
            :aria-controls="'mcpd-panel'"
            :tabindex="tab === id ? 0 : -1"
            @click="tab = id"
          >
            {{ tabLabel(id) }}<span v-if="id === 'installed' && m.rows.length" class="mcp-count">{{ m.rows.length }}</span>
          </button>
        </div>
        <button
          type="button"
          class="exit-btn mcp-skills-link"
          :title="t('mcp.skillsHint', 'Agent skills: instructions and files agents load when a task needs them')"
          @click="emit('skills')"
        >
          {{ t('mcp.skills', 'Skills') }}
        </button>
      </div>

      <div v-if="m.message.text" class="set-callout mcpd-message" :class="m.message.kind === 'error' ? 'danger' : 'info'" role="status">
        <span class="set-callout-text">{{ m.message.text }}</span>
        <button type="button" class="tb-icon mcpd-dismiss" :aria-label="t('mcp.dismiss', 'Dismiss')" :title="t('mcp.dismiss', 'Dismiss')" @click="m.say('')">
          <X :size="12" aria-hidden="true" />
        </button>
        <details v-if="m.message.detail" class="set-more mcpd-raw">
          <summary>{{ t('mcp.details', 'Details') }}</summary>
          <p>{{ m.message.detail }}</p>
        </details>
      </div>

      <div id="mcpd-panel" role="tabpanel" :aria-labelledby="'mcpd-tab-' + tab">
        <McpInstalled v-if="tab === 'installed'" :m="m" :cwd="cwd" @browse="tab = 'catalog'" @orchestration="emit('orchestration')" />
        <McpCatalog v-else-if="tab === 'catalog'" :m="m" :cwd="cwd" @tools="emit('tools')" @connections="emit('connections')" />
        <McpCustom v-else :m="m" :cwd="cwd" @added="tab = 'installed'" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The card's padding, for the add bar that runs edge to edge (Settings'
   .set-card-pad, or the window's .help-card). */
.mcpd {
  --mcp-pad-x: 18px;
  --mcp-pad-b: 14px;
}
.mcpd.help-card {
  --mcp-pad-x: 20px;
  --mcp-pad-b: 18px;
}
.mcpd-message {
  position: relative;
}
.mcpd-dismiss {
  width: 22px;
  height: 22px;
}
.mcpd-raw {
  flex-basis: 100%;
}
.mcpd-raw p {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
</style>
