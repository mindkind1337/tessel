<script setup>
// Settings > MCP servers > Installed: one row per server (never one per
// server and agent), with the agents that have it and the dot of its last
// test; its details under it: what it runs, its variables (names only), one
// line per agent (scope, Test, Remove) and one "Add to…" menu for the others.
import { ref, computed } from 'vue'
import { ChevronRight, Copy, Check, RefreshCw, X } from 'lucide-vue-next'
import BrandIcon from '../BrandIcon.vue'
import PanelState from '../ui/PanelState.vue'
import McpAddToMenu from './McpAddToMenu.vue'
import McpTokenTag from './McpTokenTag.vue'
import { t } from '../../i18n'
import { AGENT_NAME, agentList, scopeLabel, testState, testLabel, testTitle, shortTarget, copyText } from './mcpShared'

const props = defineProps({
  m: { type: Object, required: true }, // useMcpState()
  cwd: { type: String, default: null }
})
const emit = defineEmits(['browse', 'orchestration'])

// Text with {{placeholders}} is built here: in the template, "}}" would end
// the interpolation.
const serversLabel = (count) =>
  count === 1 ? t('mcp.installed.servers', '{{count}} server', { count }) : t('mcp.installed.servers', '{{count}} servers', { count })
const shownLabel = (shown, count) => t('mcp.installed.shown', '{{shown}} of {{count}}', { shown, count })
const readErrorLabel = (agent) => t('mcp.installed.readError', "{{agent}}: its MCP settings could not be read, so its servers are missing here.", { agent: AGENT_NAME[agent] })
const removeFromLabel = (agent) => t('mcp.installed.removeFrom', 'Remove from {{agent}}', { agent: AGENT_NAME[agent] })
const testOnLabel = (agent) => t('mcp.installed.testOn', 'Test with {{agent}}', { agent: AGENT_NAME[agent] })
const copyLabel = (name) => t('mcp.installed.copyTarget', 'Copy what {{name}} runs', { name })

const query = ref('')
// 'all', 'attention' or an agent id.
const filter = ref('all')
const openName = ref(null)
const copied = ref('')

const needsAttention = (row) => ['error', 'auth'].includes(props.m.rowState(row))
const agentsWithServers = computed(() => props.m.AGENTS.filter((a) => props.m.listOf(a).length))
const attentionCount = computed(() => props.m.rows.filter(needsAttention).length)

const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return props.m.rows.filter((row) => {
    if (filter.value === 'attention' && !needsAttention(row)) return false
    if (filter.value !== 'all' && filter.value !== 'attention' && !row.by[filter.value]) return false
    if (!q) return true
    const desc = row.entry ? row.entry.desc : ''
    return `${row.name} ${row.target} ${desc}`.toLowerCase().includes(q)
  })
})
// Read errors of the agents installed here (an agent that is not installed
// has nothing to read: "Codex is not installed" is not news).
const readErrors = computed(() => Object.keys(props.m.listErrors).filter((a) => props.m.installed[a]))

function toggle(name) {
  openName.value = openName.value === name ? null : name
}
// Up and Down move between the rows; the row's own button opens it.
function rowKeys(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const all = [...e.currentTarget.closest('.sl-list').querySelectorAll(':scope > .sl-item > .sl-row')]
  const i = all.indexOf(e.currentTarget)
  const next = all[i + (e.key === 'ArrowDown' ? 1 : -1)]
  if (next) {
    e.preventDefault()
    next.focus()
  }
}

const desc = (row) => (row.entry ? row.entry.desc : '')
// The one-line description under the name: what it does, else what it runs.
const rowDesc = (row) => desc(row) || shortTarget(row.target)
const others = (row) => props.m.writable.filter((a) => !row.by[a])
const offEverywhere = (row) => row.agents.every((a) => row.by[a].enabled === false)

const DOT_LABEL = {
  ok: () => t('mcp.installed.dotOk', 'Last test: connected'),
  auth: () => t('mcp.installed.dotAuth', 'Last test: signs in from the agent'),
  error: () => t('mcp.installed.dotError', 'Last test: failed'),
  testing: () => t('mcp.test.testing', 'Testing…')
}
const dotLabel = (row) => {
  const s = props.m.rowState(row)
  return s ? DOT_LABEL[s]() : t('mcp.installed.dotNone', 'Not tested yet')
}
const tagClass = (res) => ({ ok: 'tag-ok', auth: 'tag-warn', error: 'tag-danger', testing: '' })[testState(res)] || ''

async function copyTarget(row) {
  if (await copyText(row.target)) {
    copied.value = row.name
    setTimeout(() => {
      if (copied.value === row.name) copied.value = ''
    }, 1500)
  }
}

function browse() {
  emit('browse')
}
function clearFilters() {
  query.value = ''
  filter.value = 'all'
}
</script>

<template>
  <div class="mcpi">
    <div v-if="m.rows.length || !m.loaded" class="mcpi-toolbar">
      <input
        v-model="query"
        type="search"
        class="set-number mcpi-search"
        :placeholder="t('mcp.installed.search', 'Search servers')"
        :aria-label="t('mcp.installed.search', 'Search servers')"
        spellcheck="false"
      />
      <span class="set-hint mcpi-count" aria-live="polite">
        <template v-if="m.loaded">{{ shown.length === m.rows.length ? serversLabel(m.rows.length) : shownLabel(shown.length, m.rows.length) }}</template>
      </span>
      <span class="mcpi-spacer"></span>
      <button type="button" class="exit-btn" :disabled="m.loading" @click="m.refresh()">
        <RefreshCw :size="12" aria-hidden="true" :class="{ 'mcpi-spin': m.loading }" />
        {{ t('mcp.installed.refresh', 'Refresh') }}
      </button>
      <button type="button" class="exit-btn" :disabled="!m.rows.length" @click="m.testAll()">{{ t('mcp.installed.testAll', 'Test all') }}</button>
    </div>

    <div v-if="m.rows.length" class="mcpi-filters" role="group" :aria-label="t('mcp.installed.filter', 'Show')">
      <button type="button" class="chip" :class="{ on: filter === 'all' }" :aria-pressed="filter === 'all' ? 'true' : 'false'" @click="filter = 'all'">
        {{ t('mcp.installed.all', 'All') }}<span class="chip-count">{{ m.rows.length }}</span>
      </button>
      <button
        v-for="a in agentsWithServers"
        :key="a"
        type="button"
        class="chip"
        :class="{ on: filter === a }"
        :aria-pressed="filter === a ? 'true' : 'false'"
        :data-agent="a"
        @click="filter = filter === a ? 'all' : a"
      >
        <BrandIcon :kind="a" :size="12" />{{ AGENT_NAME[a] }}<span class="chip-count">{{ m.listOf(a).length }}</span>
      </button>
      <button
        v-if="attentionCount || filter === 'attention'"
        type="button"
        class="chip mcpi-attention"
        :class="{ on: filter === 'attention' }"
        :aria-pressed="filter === 'attention' ? 'true' : 'false'"
        @click="filter = filter === 'attention' ? 'all' : 'attention'"
      >
        {{ t('mcp.installed.attention', 'Needs attention') }}<span class="chip-count">{{ attentionCount }}</span>
      </button>
    </div>

    <div v-for="a in readErrors" :key="a" class="set-callout warn mcpi-read-error" :data-agent="a">
      <span class="set-callout-text">{{ readErrorLabel(a) }}</span>
      <details class="set-more mcpi-raw">
        <summary>{{ t('mcp.details', 'Details') }}</summary>
        <p>{{ m.listErrors[a] }}</p>
      </details>
    </div>

    <div v-if="m.loadError" class="mcpi-error">
      <PanelState kind="error" :text="t('mcp.installed.loadFailed', 'The servers could not be read.')" :busy="m.loading" @retry="m.refresh()" />
      <details class="set-more mcpi-raw">
        <summary>{{ t('mcp.details', 'Details') }}</summary>
        <p>{{ m.loadError }}</p>
      </details>
    </div>

    <ul v-else-if="!m.loaded" class="sl-list" role="status" aria-busy="true" :aria-label="t('mcp.loading', 'Loading…')">
      <li v-for="i in 4" :key="i" class="sl-item sl-skeleton">
        <span class="sl-skel-icon"></span>
        <span class="sl-skel-lines"><span></span><span></span></span>
      </li>
    </ul>

    <div v-else-if="!m.rows.length" class="mcpi-empty">
      <p>{{ t('mcp.installed.emptyOne', 'No MCP servers yet: add one from the catalog to give your agents new tools.') }}</p>
      <button type="button" class="exit-btn primary" @click="browse">{{ t('mcp.installed.browse', 'Browse the catalog') }}</button>
    </div>

    <p v-else-if="!shown.length" class="mcpi-empty">
      {{ t('mcp.installed.noMatch', 'No servers match.') }}
      <button type="button" class="sl-link" @click="clearFilters">{{ t('mcp.installed.showAll', 'Show all') }}</button>
    </p>

    <ul v-else class="sl-list">
      <li v-for="row in shown" :key="row.name" class="sl-item" :class="{ open: openName === row.name }" :data-server="row.name">
        <button
          type="button"
          class="sl-row"
          :aria-expanded="openName === row.name ? 'true' : 'false'"
          :aria-controls="'mcpi-d-' + row.name"
          @click="toggle(row.name)"
          @keydown="rowKeys"
        >
          <span class="sl-row-icon">
            <BrandIcon :kind="'mcp-' + row.name" :accent="(row.entry && row.entry.accent) || '#8a93a6'" :label="row.name" :size="20" />
          </span>
          <span class="sl-row-main">
            <span class="sl-row-top">
              <span class="sl-row-name">{{ row.name }}</span>
              <span v-for="ty in row.types" :key="ty" class="tag tag-scope mcpi-transport">{{ ty }}</span>
              <span v-if="offEverywhere(row)" class="tag tag-off">{{ t('mcp.installed.turnedOff', 'Turned off') }}</span>
            </span>
            <span class="sl-row-desc">{{ rowDesc(row) }}</span>
          </span>
          <span class="sl-row-meta">
            <McpTokenTag :server="row.name" :agent="row.agents[0]" :scope="row.by[row.agents[0]].scope" :cwd="cwd" variant="row" />
            <span class="sl-icons" role="img" :aria-label="agentList(row.agents.map((a) => AGENT_NAME[a]))" :title="agentList(row.agents.map((a) => AGENT_NAME[a]))">
              <BrandIcon v-for="a in row.agents" :key="a" :kind="a" :size="14" />
            </span>
            <span class="mcpi-dot" :class="m.rowState(row) || 'none'" role="img" :aria-label="dotLabel(row)" :title="dotLabel(row)"></span>
          </span>
          <ChevronRight class="sl-chevron" :size="14" aria-hidden="true" />
        </button>

        <div v-if="openName === row.name" :id="'mcpi-d-' + row.name" class="sl-details">
          <p v-if="row.name === 'tessel_team' || row.name === 'tessel-team'" class="sl-details-desc">
            {{ t('mcp.teamServer.short', 'Added by Tessel: agents in the same team use it to message each other and share the task board. It does nothing for an agent outside a team.') }}
          </p>
          <p v-else-if="desc(row)" class="sl-details-desc">{{ desc(row) }}</p>

          <dl class="mcpi-facts">
            <dt>{{ row.type === 'stdio' ? t('mcp.installed.runs', 'Runs') : t('mcp.installed.connects', 'Connects to') }}</dt>
            <dd class="mcpi-target">
              <span class="sl-path" :title="row.target">{{ shortTarget(row.target) }}</span>
              <button type="button" class="tb-icon mcpi-copy" :aria-label="copyLabel(row.name)" :title="copyLabel(row.name)" @click="copyTarget(row)">
                <Check v-if="copied === row.name" :size="12" aria-hidden="true" />
                <Copy v-else :size="12" aria-hidden="true" />
              </button>
            </dd>
            <template v-if="row.envKeys.length">
              <dt>{{ t('mcp.installed.env', 'Variables') }}</dt>
              <dd class="mcpi-secrets">
                <span v-for="k in row.envKeys" :key="k" class="mcpi-secret"><code>{{ k }}</code><span class="mcpi-mask" :aria-label="t('mcp.installed.hidden', 'value hidden')">••••••</span></span>
              </dd>
            </template>
            <template v-if="row.headerKeys.length">
              <dt>{{ t('mcp.installed.headers', 'Headers') }}</dt>
              <dd class="mcpi-secrets">
                <span v-for="k in row.headerKeys" :key="k" class="mcpi-secret"><code>{{ k }}</code><span class="mcpi-mask" :aria-label="t('mcp.installed.hidden', 'value hidden')">••••••</span></span>
              </dd>
            </template>
          </dl>

          <div class="sl-section-head">
            <span>{{ t('mcp.installed.usedBy', 'Used by') }}</span>
            <span class="sl-actions">
              <!-- One Sign in for the whole card: each agent's own sign-in, in turn. -->
              <button
                v-if="m.isRemote(row) && m.needsSignIn(row)"
                type="button"
                class="exit-btn small mcpi-signin"
                :title="t('mcp.installed.signInAllHint', 'Each agent signs in on its own: a pane opens for those with a command, the card says how for the others.')"
                @click="m.signInAll(row)"
              >
                {{ t('mcp.installed.signIn', 'Sign in') }}
              </button>
              <button type="button" class="exit-btn small" @click="m.testServer(row)">{{ t('mcp.installed.test', 'Test') }}</button>
              <McpAddToMenu :agents="others(row)" :disabled="!!m.busy" @pick="(a) => m.copyTo(row, a)" />
            </span>
          </div>
          <div v-if="m.cardMessage[row.name]" class="set-callout mcpi-card-message" :class="m.cardMessage[row.name].kind === 'error' ? 'danger' : 'info'" role="status">
            <span class="set-callout-text">{{ m.cardMessage[row.name].text }}</span>
            <button type="button" class="tb-icon mcpi-dismiss" :aria-label="t('mcp.dismiss', 'Dismiss')" :title="t('mcp.dismiss', 'Dismiss')" @click="m.sayCard(row.name, '')">
              <X :size="12" aria-hidden="true" />
            </button>
            <details v-if="m.cardMessage[row.name].detail" class="set-more mcpi-raw">
              <summary>{{ t('mcp.details', 'Details') }}</summary>
              <p>{{ m.cardMessage[row.name].detail }}</p>
            </details>
          </div>
          <ul class="sl-subs">
            <li v-for="agent in row.agents" :key="agent" class="sl-sub" :data-agent="agent">
              <div class="sl-sub-line">
                <BrandIcon :kind="agent" :size="14" />
                <span class="mcpi-agent-name">{{ AGENT_NAME[agent] }}</span>
                <span class="tag tag-scope">{{ scopeLabel(row.by[agent].scope) }}</span>
                <!-- Kept but turned off (codex mcp disable, agy mcp disable). -->
                <span v-if="row.by[agent].enabled === false" class="tag tag-off">{{ t('mcp.installed.turnedOff', 'Turned off') }}</span>
                <span
                  v-if="m.testOf(agent, row.by[agent])"
                  class="tag mcpi-test"
                  :class="tagClass(m.testOf(agent, row.by[agent]))"
                  :title="testTitle(m.testOf(agent, row.by[agent]))"
                  >{{ testLabel(m.testOf(agent, row.by[agent])) }}</span
                >
                <McpTokenTag :server="row.name" :agent="agent" :scope="row.by[agent].scope" :cwd="cwd" variant="details" />
                <span class="sl-actions">
                  <!-- Sign in is the card's one button above (every agent at once). -->
                  <button type="button" class="exit-btn small" :title="testOnLabel(agent)" @click="m.test(agent, row.by[agent])">
                    {{ t('mcp.installed.test', 'Test') }}
                  </button>
                  <button
                    type="button"
                    class="exit-btn small danger"
                    :title="removeFromLabel(agent)"
                    :aria-label="removeFromLabel(agent)"
                    :disabled="!!m.busy"
                    @click="m.remove(agent, row.by[agent])"
                  >
                    {{ t('mcp.remove.button', 'Remove') }}
                  </button>
                </span>
              </div>
              <div v-if="row.by[agent].target !== row.target" class="sl-sub-foot">
                <span class="sl-sub-path"><span class="sl-path" :title="row.by[agent].target">{{ shortTarget(row.by[agent].target) }}</span></span>
              </div>
              <details v-if="testState(m.testOf(agent, row.by[agent])) === 'error'" class="set-more mcpi-raw">
                <summary>{{ t('mcp.details', 'Details') }}</summary>
                <p>{{ testTitle(m.testOf(agent, row.by[agent])) }}</p>
              </details>
            </li>
          </ul>
        </div>
      </li>
    </ul>

    <p class="mcpi-foot">
      <button type="button" class="sl-link mcp-orchestration-link" @click="emit('orchestration')">
        {{ t('mcp.installed.teamLink', 'Team tools connection status → Orchestration') }}
      </button>
    </p>
  </div>
</template>

<style scoped>
.mcpi-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin: 10px 0 8px;
}
.mcpi-search {
  flex: 1 1 140px;
  min-width: 120px;
  max-width: 260px;
  height: 28px;
  text-align: left;
}
.mcpi-count {
  white-space: nowrap;
}
.mcpi-spacer {
  flex: 1 1 auto;
}
.mcpi-toolbar .exit-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.mcpi-spin {
  animation: mcpi-spin 0.9s linear infinite;
}
@keyframes mcpi-spin {
  to {
    transform: rotate(360deg);
  }
}
.mcpi-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 0 0 10px;
}
.mcpi-raw {
  flex-basis: 100%;
}
/* The raw message in line with PanelState's text. */
.mcpi-error .mcpi-raw {
  margin: -4px 12px 0;
}
.mcpi-raw p {
  margin: 4px 0 0;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.mcpi-empty {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 8px 0;
  padding: 14px 0;
  color: var(--text-dim);
  font-size: 12.5px;
}
.mcpi-empty p {
  margin: 0;
}
.mcpi-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.mcpi-dot.none {
  box-shadow: inset 0 0 0 1px var(--border-strong);
}
.mcpi-dot.ok {
  background: #3fb950;
}
.mcpi-dot.auth {
  background: #d29922;
}
.mcpi-dot.error {
  background: var(--danger);
}
.mcpi-dot.testing {
  background: var(--accent);
  animation: mcpi-pulse 1s ease-in-out infinite alternate;
}
@keyframes mcpi-pulse {
  from {
    opacity: 0.35;
  }
}
.mcpi-facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 4px 12px;
  margin: 0 0 6px;
  font-size: 11.5px;
}
.mcpi-facts dt {
  color: var(--text-dim);
  white-space: nowrap;
}
.mcpi-facts dd {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
  margin: 0;
}
.mcpi-target {
  flex-wrap: nowrap !important;
}
.mcpi-copy {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
}
.mcpi-secret {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.mcpi-secret code {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
}
.mcpi-mask {
  color: var(--text-dim);
  letter-spacing: 1px;
}
.mcpi-agent-name {
  color: var(--text-strong);
}
.mcpi-card-message {
  position: relative;
  margin: 6px 0 8px;
}
.mcpi-card-message .set-callout-text {
  white-space: pre-line;
}
.mcpi-dismiss {
  width: 22px;
  height: 22px;
}
.mcpi-foot {
  margin: 12px 0 0;
  font-size: 12px;
}
</style>
