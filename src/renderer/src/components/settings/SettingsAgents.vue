<script setup>
// Settings > Agents, in three tabs: Installed (the agents found, their
// updates, defaults and how they start: AgentsInstalled.vue), Permissions
// (what agents may do without asking) and Behavior (what starts, and what
// happens while agents work). Every tab renders all the time, hidden by CSS
// only, so the search reads them all and shows its matches from any tab.
import { ref, computed, watch, nextTick } from 'vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { t } from '../../i18n'
import AgentTerminalSettings from '../AgentTerminalSettings.vue'
import SettingsToolRows from '../SettingsToolRows.vue'
import AgentsInstalled from './AgentsInstalled.vue'
import { settings, clamp } from '../../settings'
import { agentEnabled } from '../../../../shared/agentPrefs'
import { CACHE_TTLS } from '../../promptCache'
import { PAGES } from './settingsPages'
import { useSettingsShell } from './settingsShell'

const props = defineProps({
  shells: { type: Array, default: () => [] },
  // Built-in and your own agents, with `available` (found on the PATH).
  agents: { type: Array, default: () => [] },
  // Agent CLI updates (AgentsInstalled.vue says what each holds).
  agentUpdates: { type: Object, default: null },
  agentUpdateJobs: { type: Object, default: () => ({}) },
  agentUpdateQueue: { type: Array, default: () => [] },
  agentUpdateHistory: { type: Object, default: () => ({ entries: [], last: {} }) }
})
const { shown, searching, anchor, emit } = useSettingsShell()

// The tabs. Settings opened on a part of the page (an anchor) shows its tab.
const TABS = ['installed', 'permissions', 'behavior']
const tab = ref('installed')
const ANCHOR_TABS = {
  'set-agents-permissions': 'permissions',
  'set-agent-terminal': 'permissions',
  'set-agents-behavior': 'behavior',
  'set-agents-missing': 'installed',
  'set-agents-add': 'installed'
}
watch(
  () => anchor && anchor.value,
  (id) => {
    if (id && ANCHOR_TABS[id]) tab.value = ANCHOR_TABS[id]
  },
  { immediate: true }
)
const installedCount = computed(() => props.agents.filter((a) => a.available).length)
const tabLabel = (id) =>
  id === 'installed'
    ? t('settings.agents.tabInstalled', 'Installed')
    : id === 'permissions'
      ? t('settings.agents.tabPermissions', 'Permissions')
      : t('settings.agents.tabBehavior', 'Behavior')
// Left / Right (Home / End) move between the tabs, as in any tab list.
function tabKeys(event) {
  const keys = { ArrowRight: 1, ArrowLeft: -1 }
  let i = TABS.indexOf(tab.value)
  if (event.key in keys) i = (i + keys[event.key] + TABS.length) % TABS.length
  else if (event.key === 'Home') i = 0
  else if (event.key === 'End') i = TABS.length - 1
  else return
  event.preventDefault()
  tab.value = TABS[i]
  const list = event.currentTarget
  nextTick(() => list?.querySelector('[aria-selected="true"]')?.focus())
}

// The agents a new pane or project can start: installed and turned on.
const offered = computed(() => props.agents.filter((x) => x.available && agentEnabled(settings.agentPrefs, x.id)))
// "When a project opens" (projectLauncher.js): its choices.
const projectOpenShellLabel = (shell) => t('settings.agents.projectOpenShell', 'Open a terminal: {{shell}}', { shell })
const projectOpenAgentLabel = (agent) => t('settings.agents.projectOpenAgent', 'Start {{agent}}', { agent })

// Minutes idle before a chat's process stops (0: never), and before an idle
// agent sleeps.
function setChatIdleMinutes(e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings.chatIdleMinutes = clamp(n, 0, 1440)
  e.target.value = settings.chatIdleMinutes
}
function setSleepMinutes(e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings.agentSleepMinutes = clamp(n, 1, 1440)
  e.target.value = settings.agentSleepMinutes
}

// "Keep computer awake": On, Agent, Off. Computed so the labels follow the
// interface's language.
const AWAKE_MODES = computed(() => [
  { id: 'on', label: t('settings.common.on', 'On'), title: t('settings.agents.awakeOnTitle', 'Keep this computer awake continuously') },
  { id: 'agents', label: t('settings.agents.awakeAgent', 'Agent'), title: t('settings.agents.awakeAgentTitle', 'Stay awake while an agent is working') },
  { id: 'off', label: t('settings.common.off', 'Off'), title: t('settings.agents.awakeOffTitle', 'Allow normal system sleep behavior') }
])
</script>

<template>
  <section
    id="set-agents"
    class="set-page"
    data-page="agents"
    :data-tab="searching ? null : tab"
    :hidden="!shown('agents')"
    aria-labelledby="set-agents-title"
  >
    <header class="set-page-head">
      <h2 id="set-agents-title">{{ PAGES.agents.title }}</h2>
      <p class="set-page-desc">{{ PAGES.agents.desc }}</p>
    </header>

    <div v-show="!searching" class="launch-seg agents-tabs" role="tablist" :aria-label="PAGES.agents.title" @keydown="tabKeys">
      <button
        v-for="id in TABS"
        :id="`agents-tab-${id}`"
        :key="id"
        type="button"
        role="tab"
        class="launch-seg-btn"
        :class="{ on: tab === id }"
        :aria-selected="tab === id"
        :tabindex="tab === id ? 0 : -1"
        :data-agents-tab="id"
        @click="tab = id"
      >
        {{ tabLabel(id) }}<span v-if="id === 'installed' && installedCount" class="agents-tab-count">{{ installedCount }}</span>
      </button>
    </div>

    <!-- ================= Installed ================= -->
    <AgentsInstalled
      :agents="agents"
      :agent-updates="agentUpdates"
      :agent-update-jobs="agentUpdateJobs"
      :agent-update-queue="agentUpdateQueue"
      :agent-update-history="agentUpdateHistory"
    />

    <!-- ================= Permissions ================= -->
    <div id="set-agents-permissions" class="set-group" data-tab="permissions">
      <h3 class="set-group-title">{{ t('settings.agents.approvals', 'Approvals') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div id="settings-perm-label" class="set-label">
            {{ t('settings.agents.startMode', 'Start agents in') }}
            <span class="set-hint">{{ t('settings.agents.startModeHint', 'Manual: they ask before commands and edits. Yolo: they never ask') }}</span>
          </div>
          <div class="launch-seg set-seg set-seg-small" role="group" aria-labelledby="settings-perm-label" data-setting="agentPermissions">
            <button
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.agentPermissions === 'manual' }"
              :aria-pressed="settings.agentPermissions === 'manual'"
              @click="settings.agentPermissions = 'manual'"
            >
              {{ t('settings.agents.manual', 'Manual') }}
            </button>
            <button
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.agentPermissions === 'yolo' }"
              :aria-pressed="settings.agentPermissions === 'yolo'"
              @click="settings.agentPermissions = 'yolo'"
            >
              Yolo
            </button>
          </div>
        </div>
        <p v-if="settings.agentPermissions === 'yolo'" class="set-callout warn agents-warn" role="note">
          <span class="set-callout-text">{{ t('settings.agents.yoloWarningShort', 'Agents run commands and change files without asking you first. Use Yolo only in projects you can restore.') }}</span>
        </p>
        <!-- Folders where agents always start in Yolo (pane menu > Yolo in this folder). -->
        <div v-if="(settings.yoloFolders || []).length" class="set-row agents-folders" data-test="settings-yolo-folders">
          <div class="set-label">
            {{ t('settings.agents.yoloFolders', 'Yolo folders') }}
            <span class="set-hint">{{ t('settings.agents.yoloFoldersShort', 'Agents started here always start in Yolo (pane menu)') }}</span>
            <ul class="agents-folder-list">
              <li v-for="f in settings.yoloFolders || []" :key="f">
                <span class="sl-path" :title="f">{{ f }}</span>
                <button
                  type="button"
                  class="exit-btn small"
                  :title="t('settings.agents.yoloFolderRemoveHint', 'Agents started here ask first again (unless Yolo is on above)')"
                  @click="settings.yoloFolders = settings.yoloFolders.filter((x) => x !== f)"
                >
                  {{ t('settings.agents.yoloFolderRemove', 'Remove') }}
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <div class="set-group" data-tab="permissions">
      <h3 class="set-group-title">{{ t('settings.agents.access', 'Folders and browser') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div class="set-label">
            <label for="settings-agent-folder-trust">{{ t('settings.agents.folderTrust', 'Trust the folder when Tessel starts an agent') }}</label>
            <span class="set-hint">{{ t('settings.agents.folderTrustShort', 'Skips "Do you trust this folder?" in your projects, so their hooks apply at once') }}</span>
            <details class="set-more">
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('settings.agents.folderTrustHint', 'Agents Tessel starts in a project you added, in a folder you trusted for chats, or in a copy Tessel made from one, skip their "Do you trust this folder?" question (Claude Code, Codex, Cursor, Copilot, Antigravity), so the project\'s agent settings and hooks apply right away. A pull request\'s copy, your home folder and remote hosts still ask. Off: each agent asks the first time it runs in a folder, and workers or automations wait at that question until you answer it. Folders already trusted stay trusted.') }}</p>
            </details>
          </div>
          <input id="settings-agent-folder-trust" v-model="settings.agentFolderTrust" type="checkbox" class="set-switch" data-setting="agentFolderTrust" />
        </div>
        <div class="set-row">
          <div class="set-label">
            <label for="settings-agent-browser">{{ t('settings.agents.browser', 'Let agents use the browser') }}</label>
            <span class="set-hint">{{ t('settings.agents.browserShort', 'Their project\'s pages in the built-in browser, with the sites you are signed into') }}</span>
            <details class="set-more">
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('settings.agents.browserHint', 'Agents can read, click and type in the built-in browser\'s pages of their own project (never other projects\' pages, never password fields, no downloads). All pages share the browser\'s cookies: agents can use the sites you are signed into in Tessel\'s browser. A page an agent drives shows an Agent badge; its Stop button takes the page back.') }}</p>
            </details>
          </div>
          <input id="settings-agent-browser" v-model="settings.agentBrowser" type="checkbox" class="set-switch" data-setting="agentBrowser" />
        </div>
        <div class="set-row">
          <div class="set-label">
            <label for="settings-agent-accounts">{{ t('settings.agents.accounts', 'Let agents move panes to another account') }}</label>
            <span class="set-hint">{{ t('settings.agents.accountsShort', 'Restart panes on another sign-in, as Switch panes does; you allow each switch') }}</span>
            <details class="set-more">
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('settings.agents.accountsHint', 'Agents can list the sign-in accounts Tessel knows (emails, plans, the panes on each; never a token) and ask to restart panes on another one, for example when a subscription ended. Each switch shows a card naming the panes, their projects and the account: nothing restarts before you choose Allow, and no answer in 2 minutes counts as Refuse. An agent on an SSH host sees only that host\'s sign-ins and the panes of its own project there. Off: agents get neither the list nor the switch.') }}</p>
            </details>
          </div>
          <input id="settings-agent-accounts" v-model="settings.agentAccounts" type="checkbox" class="set-switch" data-setting="agentAccounts" />
        </div>
      </div>
    </div>

    <AgentTerminalSettings id="set-agent-terminal" data-tab="permissions" />

    <!-- ================= Behavior ================= -->
    <div id="set-agents-behavior" class="set-group" data-tab="behavior">
      <h3 class="set-group-title">{{ t('settings.agents.newAgents', 'New agents') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <label class="set-label" for="settings-default-agent">
            {{ t('settings.agents.defaultAgent', 'Default agent') }}
            <span class="set-hint">{{ t('settings.agents.defaultAgentHint', 'What a new pane starts (Ctrl+Shift+T)') }}</span>
          </label>
          <ThemedSelect id="settings-default-agent" v-model="settings.defaultAgent" class="set-select">
            <option value="">{{ t('settings.agents.defaultShell', 'The default shell') }}</option>
            <option v-for="a in offered" :key="a.id" :value="a.id">{{ a.name }}</option>
          </ThemedSelect>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-project-open">
            {{ t('settings.agents.projectOpen', 'When a project opens') }}
            <span class="set-hint">{{ t('settings.agents.projectOpenShort', 'What a new project starts, here or on an SSH host. Ask lets you choose') }}</span>
          </label>
          <ThemedSelect id="settings-project-open" v-model="settings.projectOpen" class="set-select" data-setting="projectOpen">
            <option value="ask">{{ t('settings.agents.projectOpenAsk', 'Ask') }}</option>
            <option value="terminal">{{ t('settings.agents.projectOpenTerminal', 'Open a terminal') }}</option>
            <option v-for="s in shells" :key="'terminal:' + s.id" :value="'terminal:' + s.id">{{ projectOpenShellLabel(s.name) }}</option>
            <option v-for="a in offered" :key="'agent:' + a.id" :value="'agent:' + a.id">{{ projectOpenAgentLabel(a.name) }}</option>
          </ThemedSelect>
        </div>
      </div>
    </div>

    <div class="set-group" data-tab="behavior">
      <h3 class="set-group-title">{{ t('settings.agents.conversations', 'Conversations') }}</h3>
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.agents.resume', 'Resume conversations when panes reopen') }}
            <span class="set-hint">{{ t('settings.agents.resumeShort', 'Claude Code and Codex continue where they left off after a restart') }}</span>
          </div>
          <input v-model="settings.resumeAgents" type="checkbox" class="set-switch" data-setting="resumeAgents" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.agents.autoTitles', 'Show the conversation\'s title') }}
            <span class="set-hint">{{ t('settings.agents.autoTitlesShort', 'Under the agent in the sidebar and in the pane\'s hover card (Claude Code, Codex)') }}</span>
          </div>
          <input v-model="settings.autoTitles" type="checkbox" class="set-switch" data-setting="autoTitles" />
        </label>
        <div class="set-row">
          <label class="set-label" for="settings-chat-idle">
            {{ t('settings.agents.chatIdle', 'Stop an idle chat agent after') }}
            <span class="set-hint">{{ t('settings.agents.chatIdleShort', 'Minutes without a turn (0: never). Its next message starts it again') }}</span>
          </label>
          <input
            id="settings-chat-idle"
            class="set-number set-number-short"
            type="number"
            min="0"
            max="1440"
            data-setting="chatIdleMinutes"
            :value="settings.chatIdleMinutes"
            @change="setChatIdleMinutes"
          />
        </div>
      </div>
    </div>

    <div class="set-group" data-tab="behavior">
      <h3 class="set-group-title">{{ t('settings.agents.whileWorking', 'While agents work') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div id="settings-awake-label" class="set-label">
            {{ t('settings.agents.keepAwake', 'Keep computer awake') }}
            <span class="set-hint">{{ t('settings.agents.keepAwakeShort', 'Agent: only while an agent works. Closing the lid follows Windows') }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-awake-label" data-setting="keepAwake">
            <button
              v-for="m in AWAKE_MODES"
              :key="m.id"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.keepAwake === m.id }"
              :aria-pressed="settings.keepAwake === m.id"
              :title="m.title"
              @click="settings.keepAwake = m.id"
            >
              {{ m.label }}
            </button>
          </div>
        </div>
        <div class="set-row">
          <div class="set-label">
            <label for="settings-cache-timer">{{ t('settings.agents.cacheTimer', 'Prompt cache timer') }}</label>
            <span class="set-hint">{{ t('settings.agents.cacheTimerShort', 'A countdown in Claude\'s panes until its conversation leaves the cache') }}</span>
            <details class="set-more">
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('settings.agents.cacheTimerHint', 'Claude keeps your conversation cached for a while after it answers. A message sent later re-sends it all uncached (slower, costs more). Shows a countdown in Claude\'s panes') }}</p>
            </details>
          </div>
          <input id="settings-cache-timer" v-model="settings.promptCacheTimer" type="checkbox" class="set-switch" data-setting="promptCacheTimer" />
        </div>
        <div v-if="settings.promptCacheTimer" class="set-row set-child">
          <label class="set-label" for="settings-cache-ttl">
            {{ t('settings.agents.cacheDuration', 'Cache duration') }}
            <span class="set-hint">{{ t('settings.agents.cacheDurationHint', 'Match your provider\'s cache. The default is 5 minutes') }}</span>
          </label>
          <ThemedSelect id="settings-cache-ttl" v-model.number="settings.promptCacheTtlMs" class="set-select">
            <option v-for="ttl in CACHE_TTLS" :key="ttl.ms" :value="ttl.ms">{{ ttl.label }}</option>
          </ThemedSelect>
        </div>
        <div class="set-row">
          <div class="set-label">
            <label for="settings-agent-sleep">{{ t('settings.agents.sleep', 'Put idle agents to sleep') }}</label>
            <span class="set-hint">{{ t('settings.agents.sleepShort', 'An idle agent\'s terminal stops to free memory; opening its pane resumes it') }}</span>
            <details class="set-more">
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('settings.agents.sleepHint', 'An agent idle for a while stops its terminal to free memory; its pane stays and opening it resumes the conversation. Only agents whose conversation Tessel can resume, never teammates, nor the pane you are in') }}</p>
            </details>
          </div>
          <input id="settings-agent-sleep" v-model="settings.agentSleep" type="checkbox" class="set-switch" data-setting="agentSleep" />
        </div>
        <div v-if="settings.agentSleep" class="set-row set-child">
          <label class="set-label" for="settings-sleep-min">
            {{ t('settings.agents.sleepAfter', 'Sleep after') }}
            <span class="set-hint">{{ t('settings.agents.sleepAfterHint', 'Minutes idle (1 to 1440)') }}</span>
          </label>
          <input
            id="settings-sleep-min"
            class="set-number set-number-short"
            type="number"
            min="1"
            max="1440"
            :value="settings.agentSleepMinutes"
            @change="setSleepMinutes"
          />
        </div>
      </div>
    </div>

    <SettingsToolRows page="agents" data-tab="behavior" @open="emit('open-tool', $event)" />
  </section>
</template>

<style>
/* The tab shown; the others stay in the page (the search reads them) but
   are not drawn. While searching, no data-tab: every match shows. */
#set-agents[data-tab='installed'] > [data-tab]:not([data-tab='installed']),
#set-agents[data-tab='permissions'] > [data-tab]:not([data-tab='permissions']),
#set-agents[data-tab='behavior'] > [data-tab]:not([data-tab='behavior']) {
  display: none;
}
#set-agents .agents-tabs {
  margin: -6px 0 18px;
}
#set-agents .agents-tab-count {
  color: var(--text-dim);
  font-size: 10.5px;
}
#set-agents .agents-warn {
  margin: 0 0 10px;
}
/* A setting that only counts while the one above it is on. */
#set-agents .set-row.set-child {
  padding-left: 16px;
}
#set-agents .agents-folder-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
#set-agents .agents-folder-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
#set-agents .agents-folder-list .sl-path {
  flex: 1 1 auto;
  font-size: 11px;
}
#set-agents .set-more > p {
  max-width: 62ch;
}
#set-agents .set-row:has(> .set-label > .set-more[open]) {
  align-items: flex-start;
}
</style>
