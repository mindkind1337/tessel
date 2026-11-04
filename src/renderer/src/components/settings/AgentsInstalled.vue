<script setup>
// Settings > Agents > Installed: the agents found on this computer, one row
// each (the Settings > Skills look): its version, an update waiting, whether
// the menus offer it; its details hold its default model and effort, how it
// starts (command, arguments, variables), its last update with the raw error
// behind a disclosure, View log and Docs. Above the list: the updates
// toolbar; under it the agents not found, folded, each with Install; then
// your own agents and the detection rules (Advanced).
import { ref, computed, inject, watch, nextTick } from 'vue'
import { LoaderCircle } from 'lucide-vue-next'
import { t, intlLocale } from '../../i18n'
import { settings } from '../../settings'
import BrandIcon from '../BrandIcon.vue'
import AgentModelDefaults from './AgentModelDefaults.vue'
import AgentCustomForm from './AgentCustomForm.vue'
import { describeWaitingText } from '../../agentUpdateWhy'
import { updateFailureText, updateKindLabel } from '../../agentUpdateErrors'
import { parseEnvText, YOLO_ARGS, YOLO_ENV, agentEnabled } from '../../../../shared/agentPrefs'
import { AGENT_DOCS } from '../../../../shared/agentDocs'
import {
  getAgentSessionOptionCatalog,
  valuesOnListedRow,
  modelOptions,
  resolveSessionOptionDefaults
} from '../../../../shared/agentSessionOptions'
import { modelsFor } from '../../agentModels'
import { sessionChoiceLabel } from '../../sessionOptionLabels'
import { agentRulesReason, agentRulesStatus } from '../../agentStateRules'
import { useSettingsShell } from './settingsShell'

const props = defineProps({
  // Built-in and your own agents, with `available` (found on the PATH).
  agents: { type: Array, default: () => [] },
  // Agent CLI updates: { checkedAt, agents: { id: { installed, latest,
  // update, source, note } } }, the updates running (agentId -> job), the
  // ones waiting their turn, and the history ({ entries, last }).
  agentUpdates: { type: Object, default: null },
  agentUpdateJobs: { type: Object, default: () => ({}) },
  agentUpdateQueue: { type: Array, default: () => [] },
  agentUpdateHistory: { type: Object, default: () => ({ entries: [], last: {} }) }
})
const { searching, anchor, emit } = useSettingsShell()
const askConfirm = inject('askConfirm', null)

const installed = computed(() => props.agents.filter((a) => a.available))
const missing = computed(() => props.agents.filter((a) => !a.available))

// One agent's details open at a time.
const openId = ref(null)
function toggle(id) {
  openId.value = openId.value === id ? null : id
}
const rowId = (a) => `agent-row-${a.id}` // i18n-ignore
const detailsId = (a) => `agent-details-${a.id}` // i18n-ignore
// Escape in an agent's details folds them (and not Settings).
function onItemEscape(e, a) {
  if (openId.value !== a.id) return
  e.preventDefault()
  e.stopPropagation()
  openId.value = null
  nextTick(() => document.getElementById(rowId(a))?.focus())
}

// The agents not found: folded, open by itself when none is installed, or
// when Settings was opened on them (the New menu's "Install agents…").
const missingOpen = ref(false)
// (Text with {{placeholders}} is built here: in the template, "}}" would end
// the interpolation.)
const missingTitle = computed(() => t('settings.agents.notInstalledCount', 'Not installed ({{count}})', { count: missing.value.length }))
watch(
  () => installed.value.length === 0 && missing.value.length > 0,
  (none) => {
    if (none) missingOpen.value = true
  },
  { immediate: true }
)
watch(
  () => anchor && anchor.value,
  (id) => {
    if (id === 'set-agents-missing' || id === 'set-agents-add') missingOpen.value = true
  },
  { immediate: true }
)

// --- Each agent's own command, arguments and variables ---------------------
function agentPref(id) {
  return settings.agentPrefs[id] || {}
}
function setAgentPref(id, field, value) {
  const next = { ...agentPref(id), [field]: value }
  settings.agentPrefs = { ...settings.agentPrefs, [id]: next }
}
function resetAgent(id) {
  const next = { ...settings.agentPrefs }
  const keepOff = next[id] && next[id].enabled === false
  delete next[id]
  if (keepOff) next[id] = { enabled: false }
  settings.agentPrefs = next
}
// Read from the saved text, not from the last edit: the variables of an agent
// whose text is wrong are all ignored at launch, so the warning must stay as
// long as the text does (Settings closed and reopened, Tessel restarted).
function envError(id) {
  const raw = agentPref(id).env
  return raw ? parseEnvText(raw).error || '' : ''
}
function customized(id) {
  const p = agentPref(id)
  return !!((p.command && p.command.trim()) || (p.args && p.args.trim()) || (p.env && p.env.trim()))
}
// What the arguments and variables fields say about Yolo (in their
// placeholder and title, so a search for "yolo" finds the Yolo settings and
// not every agent): Yolo's own option, replaced by arguments set here, and
// the variables it sets.
function argsNote(id) {
  return YOLO_ARGS[id]
    ? t('settings.agents.yoloAddsReplaced', 'Yolo adds {{args}}; arguments set here replace it', { args: YOLO_ARGS[id] })
    : t('settings.agents.argsExample', 'e.g. --model …')
}
function envNote(id) {
  return YOLO_ENV[id] ? t('settings.agents.yoloSets', 'Yolo sets {{names}}', { names: Object.keys(YOLO_ENV[id]).join(', ') }) : 'NAME=value' // i18n-ignore
}
function openDocs(id) {
  if (AGENT_DOCS[id] && window.shellApi.openExternal) window.shellApi.openExternal(AGENT_DOCS[id])
}

// --- The row's one line: an update under way, else the default model chosen
// for it, else the command it runs -----------------------------------------
function modelSummary(a) {
  const catalog = getAgentSessionOptionCatalog(a.id)
  if (!catalog) return ''
  const d = valuesOnListedRow(modelsFor(a.id), resolveSessionOptionDefaults(settings.agentSessionOptions, a.id))
  if (!d) return ''
  const m = modelsFor(a.id).find((x) => x.id === d.model)
  let text = m ? m.label : d.model
  const effort = d.effort !== undefined ? modelOptions(catalog, modelsFor(a.id), d.model).find((o) => o.id === 'effort') : null
  const choice = effort && effort.kind && Array.isArray(effort.kind.choices) ? effort.kind.choices.find((c) => c.value === d.effort) : null
  if (choice) text += ` · ${t('settings.agents.effortIs', 'effort {{effort}}', { effort: sessionChoiceLabel(choice) })}`
  return t('settings.agents.modelIs', 'Model: {{model}}', { model: text })
}
function rowDesc(a) {
  if (jobActive(a.id)) return jobText(a.id)
  return modelSummary(a) || agentPref(a.id).command || a.command || ''
}

// --- Versions and updates ---------------------------------------------------
const checkingAgentUpdates = ref(false)
async function checkAgentUpdates() {
  checkingAgentUpdates.value = true
  try {
    await new Promise((resolve) => emit('check-agent-updates', resolve))
  } finally {
    checkingAgentUpdates.value = false
  }
}
const detecting = ref(false)
async function detectAgents() {
  detecting.value = true
  try {
    await new Promise((resolve) => emit('detect-agents', resolve))
  } finally {
    detecting.value = false
  }
}
function updateRow(id) {
  return (props.agentUpdates && props.agentUpdates.agents && props.agentUpdates.agents[id]) || null
}
const updatableCount = computed(() =>
  props.agentUpdates && props.agentUpdates.agents ? Object.values(props.agentUpdates.agents).filter((r) => r.update).length : 0
)
const updatesSummary = computed(() => {
  const u = props.agentUpdates
  if (!u) return t('settings.agents.notChecked', 'Not checked yet')
  const when = new Date(u.checkedAt).toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' })
  const n = updatableCount.value
  return n
    ? n === 1
      ? t('settings.agents.updatesSummary', '{{count}} update available · checked {{when}}', { count: n, when })
      : t('settings.agents.updatesSummary', '{{count}} updates available · checked {{when}}', { count: n, when })
    : t('settings.agents.upToDate', 'All up to date · checked {{when}}', { when })
})
const updateAllText = computed(() => t('settings.agents.updateAllCount', 'Update all ({{count}})', { count: updatableCount.value }))
function versionText(a) {
  const r = updateRow(a.id)
  if (!r) return ''
  if (r.update)
    return t('settings.agents.updateAvailable', 'Update available: {{installed}} → {{latest}}', {
      installed: r.installed,
      latest: r.latest
    })
  if (r.installed)
    return r.latest
      ? t('settings.agents.versionLatest', 'Version {{version}} (latest)', { version: r.installed })
      : t('settings.agents.version', 'Version {{version}}', { version: r.installed })
  return r.note || ''
}
// An update in progress, in words.
function jobText(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  if (!j) return props.agentUpdateQueue.includes(id) ? t('settings.agents.jobQueued', 'Waiting for the other updates') : ''
  const waiting = describeWaitingText(j.waiting)
  switch (j.phase) {
    case 'updating':
      return j.via === 'background'
        ? t('settings.agents.jobUpdatingBackground', 'Updating in the background…')
        : t('settings.agents.jobUpdating', 'Updating in a pane below…')
    case 'waiting-stop':
      return t('settings.agents.jobWaitingStop', 'Its files are in use: waiting to stop {{panes}} safely, then updating and resuming them', {
        panes: waiting || t('settings.agents.jobItsPanes', 'its panes')
      })
    case 'retrying':
      return t('settings.agents.jobRetrying', 'Stopped its panes; updating again…')
    case 'restarting':
      return t('settings.agents.jobRestarting', 'Updated to {{version}}. Waiting to restart: {{panes}}', {
        version: j.version,
        panes: waiting || '…'
      })
    case 'done':
      // The report comes from the updater, as it is.
      return t('settings.agents.jobDone', 'Updated to {{version}}.', { version: j.version || j.target }) + (j.report ? ` ${j.report}` : '')
    case 'failed':
      // Told by the last result line (the history) when it has it.
      if (lastUpdate(id) && lastUpdate(id).at >= (j.startedAt || 0) && !j.inUse) return ''
      return j.error
        ? t('settings.agents.jobFailedWith', 'Not updated: {{error}}.', { error: j.error })
        : t('settings.agents.jobFailed', 'Not updated.')
    default:
      return ''
  }
}
function jobRunning(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  return !!(j && ['updating', 'retrying'].includes(j.phase))
}
function jobActive(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  return props.agentUpdateQueue.includes(id) || !!(j && !['done', 'failed'].includes(j.phase))
}
function jobWaiting(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  return !!(j && ['waiting-stop', 'restarting'].includes(j.phase))
}
// Files in use by its own panes: Tessel can close and reopen them.
function jobInUse(id) {
  const j = props.agentUpdateJobs && props.agentUpdateJobs[id]
  return !!(j && j.phase === 'failed' && j.inUse)
}
// The update history (the last attempts) and each agent's last result.
function lastUpdate(id) {
  const h = props.agentUpdateHistory
  return (h && h.last && h.last[id]) || null
}
// The last attempt failed and nothing newer runs: a warning on the row.
function lastFailed(a) {
  const e = lastUpdate(a.id)
  return !!(e && !e.ok && !jobActive(a.id))
}
const updateHistory = computed(() => {
  const h = props.agentUpdateHistory
  return h && Array.isArray(h.entries) ? h.entries : []
})
const historyOpen = ref(false)
const historyTitle = computed(() => t('settings.agents.history', 'Update history ({{count}})', { count: updateHistory.value.length }))
function whenText(at) {
  return new Date(at).toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' })
}
function versionsText(e) {
  const to = e.ok ? e.version || e.to : e.to
  return e.from && to ? `${e.from} → ${to}` : to || e.from || ''
}
function lastUpdateText(id) {
  const e = lastUpdate(id)
  if (!e) return ''
  const vars = { when: whenText(e.at), versions: versionsText(e) }
  return e.ok
    ? t('settings.agents.lastOk', 'Last update {{when}}: {{versions}}, succeeded', vars)
    : t('settings.agents.lastFailed', 'Last update {{when}}: {{versions}}, failed ({{kind}})', { ...vars, kind: updateKindLabel(e.kind) })
}
// Why the last attempt failed, in plain words.
function lastUpdateWhy(a) {
  const e = lastUpdate(a.id)
  if (!e || e.ok) return ''
  // Files in use by its own panes: the job's line says it, with its button.
  if (jobInUse(a.id)) return updateFailureText('in-use', a.name, { panes: 1 })
  return updateFailureText(e.kind, a.name)
}
function hasUpdateInfo(a) {
  return !!(jobText(a.id) || versionText(a) || lastUpdate(a.id) || jobWaiting(a.id))
}

// --- Your own agents --------------------------------------------------------
async function removeCustom(a) {
  if (askConfirm) {
    const ok = await askConfirm({
      title: t('settings.agents.custom.removeTitle', 'Remove {{name}}?', { name: a.name }),
      text: t('settings.agents.custom.removeText', 'It leaves the New menu. Its panes keep running.'),
      confirmLabel: t('tools.custom.remove', 'Remove'),
      danger: true
    })
    if (!ok) return
  }
  const i = settings.customAgents.findIndex((x) => x.id === a.id)
  if (i >= 0) settings.customAgents.splice(i, 1)
  if (openId.value === a.id) openId.value = null
  detectAgents()
}

// --- Detection rules (Advanced) ---------------------------------------------
const agentRulesLine = computed(() => {
  // The example "Open rules file" creates changes nothing until edited.
  if (agentRulesStatus.state === 'override' && !agentRulesStatus.size)
    return t('settings.agents.rulesEmpty', 'Your rules file changes nothing yet: the built-in rules are in use. Saved changes apply at once')
  if (agentRulesStatus.state === 'override')
    return t('settings.agents.rulesOverride', 'Your rules file is in use ({{count}} change(s) over the built-in rules)', { count: agentRulesStatus.size })
  if (agentRulesStatus.state === 'invalid')
    return t('settings.agents.rulesInvalid', 'Your rules file is ignored, the built-in rules stay in use: {{reason}}', { reason: agentRulesReason(t) })
  return t('settings.agents.rulesBuiltin', 'Built-in rules in use')
})
const agentRulesError = ref('')
async function openAgentRules() {
  agentRulesError.value = ''
  const res = await window.shellApi.agentRules?.open().catch((err) => ({ ok: false, error: err?.message || String(err) }))
  if (res && !res.ok) agentRulesError.value = res.error || ''
}
</script>

<template>
  <div class="set-group agents-installed" data-tab="installed">
    <div class="set-card set-card-pad agents-card">
      <!-- The updates toolbar. -->
      <div class="agents-toolbar" data-test="agent-updates">
        <div class="agents-toolbar-main">
          <span class="agents-toolbar-title">{{ t('settings.agents.updates', 'Agent updates') }}</span>
          <span class="set-hint agent-updates-summary">{{ updatesSummary }}</span>
        </div>
        <span class="agents-toolbar-actions">
          <button class="exit-btn small" type="button" data-test="check-agent-updates" :disabled="checkingAgentUpdates" @click="checkAgentUpdates">
            <LoaderCircle v-if="checkingAgentUpdates" :size="11" class="sb-spin" aria-hidden="true" />
            {{ checkingAgentUpdates ? t('settings.agents.checking', 'Checking…') : t('settings.agents.checkUpdatesShort', 'Check for updates') }}
          </button>
          <button v-if="updatableCount" class="exit-btn small primary" type="button" data-test="update-all-agents" @click="emit('update-all-agents')">
            {{ updateAllText }}
          </button>
          <button class="exit-btn small" type="button" data-test="detect-agents" :disabled="detecting" @click="detectAgents">
            {{ detecting ? t('settings.agents.detecting', 'Detecting…') : t('settings.agents.detectAgain', 'Detect again') }}
          </button>
        </span>
        <label class="agents-auto" :title="t('settings.agents.autoUpdateHint', 'When a newer version is found, update it by itself at a safe moment: panes running it are idle, nothing typed in them. They restart in place and resume their conversation')">
          <input v-model="settings.autoUpdateAgents" type="checkbox" class="set-switch" data-setting="autoUpdateAgents" />
          <span class="agents-auto-text">
            {{ t('settings.agents.autoUpdate', 'Update agents automatically') }}
            <span class="set-hint">{{ t('settings.agents.autoUpdateShort', 'At a safe moment: their panes restart in place and resume') }}</span>
          </span>
        </label>
      </div>

      <!-- Installed agents. -->
      <ul v-if="installed.length" class="sl-list agents-list" :aria-label="t('settings.agents.installed', 'Installed agents')">
        <li
          v-for="a in installed"
          :key="a.id"
          class="sl-item agent-set"
          :class="{ open: openId === a.id, off: !agentEnabled(settings.agentPrefs, a.id) }"
          :data-agent="a.id"
          @keydown.escape="onItemEscape($event, a)"
        >
          <div class="agent-row">
            <button
              :id="rowId(a)"
              type="button"
              class="sl-row"
              :aria-expanded="openId === a.id"
              :aria-controls="detailsId(a)"
              @click="toggle(a.id)"
            >
              <BrandIcon class="sl-row-icon" :kind="a.id" :accent="a.accent" :label="a.name" :size="20" />
              <span class="sl-row-main">
                <span class="sl-row-top">
                  <span class="sl-row-name">{{ a.name }}</span>
                  <span v-if="updateRow(a.id) && updateRow(a.id).installed" class="tag tag-scope" :data-test="`agent-version-tag-${a.id}`">{{ updateRow(a.id).installed }}</span>
                  <span v-if="jobActive(a.id)" class="tag tag-info agent-tag-busy">
                    <LoaderCircle v-if="jobRunning(a.id)" :size="10" class="sb-spin" aria-hidden="true" />{{ t('settings.agents.updating', 'Updating…') }}
                  </span>
                  <span v-else-if="updateRow(a.id) && updateRow(a.id).update" class="tag tag-update" :title="versionText(a)">{{ t('settings.agents.updateBadge', 'Update available') }}</span>
                  <span v-if="lastFailed(a)" class="tag tag-warn" :title="lastUpdateWhy(a)">{{ t('settings.agents.updateFailedBadge', 'Update failed') }}</span>
                  <span v-if="a.custom" class="tag tag-purple">{{ t('settings.agents.yours', 'Yours') }}</span>
                  <span v-if="customized(a.id)" class="tag">{{ t('settings.agents.customizedBadge', 'Customized') }}</span>
                </span>
                <span class="sl-row-desc" :title="rowDesc(a) || undefined">{{ rowDesc(a) }}</span>
              </span>
            </button>
            <input
              type="checkbox"
              class="set-switch"
              :aria-label="t('settings.agents.offerInMenus', 'Offer {{name}} in menus', { name: a.name })"
              :title="agentEnabled(settings.agentPrefs, a.id) ? t('settings.agents.shownInMenus', 'Shown in menus') : t('settings.agents.hiddenFromMenus', 'Hidden from menus')"
              :checked="agentEnabled(settings.agentPrefs, a.id)"
              @change="setAgentPref(a.id, 'enabled', $event.target.checked)"
            />
            <svg class="sl-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" @click="toggle(a.id)">
              <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>

          <!-- Its details (rendered always, so the search reads them). -->
          <div v-show="openId === a.id" :id="detailsId(a)" class="sl-details agent-details" role="region" :aria-labelledby="rowId(a)">
            <template v-if="hasUpdateInfo(a)">
              <div class="sl-section-head">
                <span>{{ t('settings.agents.updatesSection', 'Updates') }}</span>
              </div>
              <div class="agent-update">
                <p
                  v-if="versionText(a)"
                  class="agent-version"
                  :class="{ 'agent-update-available': updateRow(a.id) && updateRow(a.id).update }"
                  :data-test="`agent-version-${a.id}`"
                >
                  {{ versionText(a) }}
                </p>
                <p v-if="jobText(a.id)" class="set-hint agent-update-job" :data-test="`agent-update-job-${a.id}`">
                  <LoaderCircle v-if="jobRunning(a.id)" :size="11" class="sb-spin" aria-hidden="true" />
                  {{ jobText(a.id) }}
                </p>
                <div
                  v-if="lastUpdate(a.id)"
                  class="agent-update-last"
                  :class="{ failed: !lastUpdate(a.id).ok }"
                  :data-test="`agent-update-last-${a.id}`"
                >
                  <span class="agent-update-result">{{ lastUpdateText(a.id) }}</span>
                  <span v-if="lastUpdateWhy(a)" class="agent-update-why">{{ lastUpdateWhy(a) }}</span>
                  <details v-if="!lastUpdate(a.id).ok && lastUpdate(a.id).detail" class="set-more agent-update-raw">
                    <summary>{{ t('settings.common.details', 'Details') }}</summary>
                    <code class="agent-update-detail">{{ lastUpdate(a.id).detail }}</code>
                  </details>
                </div>
                <div class="agent-update-actions">
                  <button
                    v-if="updateRow(a.id) && updateRow(a.id).update"
                    class="exit-btn small"
                    type="button"
                    :data-test="`update-agent-${a.id}`"
                    :disabled="jobActive(a.id)"
                    @click="emit('update-agent', a.id)"
                  >
                    <LoaderCircle v-if="jobRunning(a.id)" :size="11" class="sb-spin" aria-hidden="true" />
                    {{ jobActive(a.id) ? t('settings.agents.updating', 'Updating…') : t('settings.agents.update', 'Update') }}
                  </button>
                  <button
                    v-if="updateRow(a.id) && updateRow(a.id).update && !jobActive(a.id)"
                    class="exit-btn small"
                    type="button"
                    :data-test="`update-agent-pane-${a.id}`"
                    :title="t('settings.agents.runInTerminalTitle', 'Run the update in a terminal pane, to see its output as it goes')"
                    @click="emit('update-agent-in-pane', a.id)"
                  >
                    {{ t('settings.agents.runInTerminal', 'Run in a terminal') }}
                  </button>
                  <button
                    v-if="jobWaiting(a.id)"
                    class="exit-btn small"
                    type="button"
                    :title="t('settings.agents.stopWaitingTitle', 'Stop waiting for its panes (they keep running as they are)')"
                    @click="emit('cancel-agent-update', a.id)"
                  >
                    {{ t('settings.agents.stopWaiting', 'Stop waiting') }}
                  </button>
                  <button v-if="jobInUse(a.id)" class="exit-btn small" type="button" :data-test="`close-reopen-${a.id}`" @click="emit('close-reopen-agent-update', a.id)">
                    {{ t('settings.agents.closeReopen', 'Close and reopen them') }}
                  </button>
                  <button
                    v-if="lastUpdate(a.id) && lastUpdate(a.id).file"
                    class="exit-btn small"
                    type="button"
                    :data-test="`view-update-log-${a.id}`"
                    @click="emit('open-update-log', lastUpdate(a.id).file)"
                  >
                    {{ t('settings.agents.viewLog', 'View log') }}
                  </button>
                </div>
              </div>
            </template>

            <template v-if="getAgentSessionOptionCatalog(a.id)">
              <div class="sl-section-head">
                <span>{{ t('settings.agents.defaultsSection', 'Default model') }}</span>
              </div>
              <AgentModelDefaults :agent="a" :command="agentPref(a.id).command || ''" />
            </template>

            <div class="sl-section-head">
              <span>{{ t('settings.agents.startsSection', 'How it starts') }}</span>
              <button class="exit-btn small" type="button" :disabled="!customized(a.id)" @click="resetAgent(a.id)">
                {{ t('settings.agents.reset', 'Reset') }}
              </button>
            </div>
            <div class="agent-custom">
              <label class="agent-field">
                <span class="set-hint">{{ t('settings.agents.command', 'Command') }}</span>
                <input
                  class="set-number agent-input"
                  spellcheck="false"
                  :placeholder="a.command"
                  :value="agentPref(a.id).command || ''"
                  @change="setAgentPref(a.id, 'command', $event.target.value)"
                />
              </label>
              <label class="agent-field">
                <span class="set-hint">{{ t('settings.agents.argumentsLabel', 'Arguments') }}</span>
                <input
                  class="set-number agent-input"
                  spellcheck="false"
                  :placeholder="argsNote(a.id)"
                  :title="argsNote(a.id)"
                  :value="agentPref(a.id).args || ''"
                  @change="setAgentPref(a.id, 'args', $event.target.value)"
                />
              </label>
              <label class="agent-field">
                <span class="set-hint">{{ t('settings.agents.variables', 'Variables, one NAME=value per line') }}</span>
                <textarea
                  class="set-number agent-input agent-env"
                  rows="2"
                  spellcheck="false"
                  :placeholder="envNote(a.id)"
                  :value="agentPref(a.id).env || ''"
                  @change="setAgentPref(a.id, 'env', $event.target.value)"
                ></textarea>
              </label>
              <p v-if="envError(a.id)" class="set-callout warn agent-env-error" role="alert">
                <span class="set-callout-text">{{ envError(a.id) }} {{ t('settings.agents.notUsedUntilFixed', 'Not used until fixed.') }}</span>
              </p>
              <span class="set-hint">{{ t('settings.agents.appliesFromNow', 'Applies to panes you start from now on') }}</span>
            </div>

            <div class="agent-details-foot">
              <button v-if="AGENT_DOCS[a.id]" class="exit-btn small" type="button" @click="openDocs(a.id)">
                {{ t('settings.agents.docs', 'Docs') }}
              </button>
              <button v-if="a.custom" class="exit-btn small danger" type="button" data-test="custom-agent-remove" @click="removeCustom(a)">
                {{ t('tools.custom.remove', 'Remove') }}
              </button>
            </div>
          </div>
        </li>
      </ul>
      <div v-else-if="detecting" class="agents-state" role="status" aria-busy="true">
        <LoaderCircle :size="13" class="sb-spin" aria-hidden="true" />
        {{ t('settings.agents.detecting', 'Detecting…') }}
      </div>
      <div v-else class="agents-state" data-test="agents-empty">
        {{ t('settings.agents.noneInstalled', 'No agent found on this computer yet. Install one below, then Detect again.') }}
      </div>

      <!-- The agents not on this computer: folded, Install on each. -->
      <div v-if="missing.length" id="set-agents-missing" class="agents-missing">
        <button
          type="button"
          class="agents-missing-toggle"
          :aria-expanded="missingOpen || searching"
          aria-controls="agents-missing-list"
          data-test="agents-missing-toggle"
          @click="missingOpen = !missingOpen"
        >
          <svg class="sl-chevron" :class="{ open: missingOpen || searching }" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {{ missingTitle }}
        </button>
        <ul v-show="missingOpen || searching" id="agents-missing-list" class="agents-missing-list">
          <li v-for="a in missing" :key="a.id" class="agent-set agents-missing-row" :data-agent="a.id">
            <BrandIcon :kind="a.id" :accent="a.accent" :label="a.name" :size="16" />
            <span class="agents-missing-name">{{ a.name }}</span>
            <span v-if="a.custom" class="tag tag-purple">{{ t('settings.agents.yours', 'Yours') }}</span>
            <span v-if="a.custom" class="set-hint agents-missing-why">{{ t('tools.custom.notFound', 'Not found on PATH') }}</span>
            <span class="agents-missing-actions">
              <!-- The launch menu's way: the exact command is shown and
                   confirmed first when it runs a vendor script. -->
              <button v-if="a.install" class="exit-btn small" type="button" data-test="agent-install" @click="emit('install-agent', a)">
                {{ t('settings.agents.install', 'Install') }}
              </button>
              <button
                v-else-if="a.docsUrl"
                class="exit-btn small"
                type="button"
                data-test="agent-install-page"
                :title="a.docsUrl"
                @click="emit('agent-install-page', a)"
              >
                {{ t('settings.agents.installPage', 'Install page') }}
              </button>
              <button v-else-if="AGENT_DOCS[a.id]" class="exit-btn small" type="button" @click="openDocs(a.id)">
                {{ t('settings.agents.docs', 'Docs') }}
              </button>
              <button v-if="a.custom" class="exit-btn small danger" type="button" data-test="custom-agent-remove" @click="removeCustom(a)">
                {{ t('tools.custom.remove', 'Remove') }}
              </button>
            </span>
          </li>
        </ul>
      </div>
    </div>
  </div>

  <!-- Your own agents: the form that adds one (it joins the list above). -->
  <div id="set-agents-add" class="set-group" data-tab="installed">
    <h3 class="set-group-title">{{ t('tools.custom.title', 'Your own agents') }}</h3>
    <p class="set-group-desc">{{ t('settings.agents.custom.desc', 'Any command-line agent: it shows in the New menu and runs in the default shell.') }}</p>
    <div class="set-card set-card-pad">
      <AgentCustomForm @added="detectAgents" />
    </div>
  </div>

  <div class="set-group" data-tab="installed">
    <h3 class="set-group-title">{{ t('settings.agents.advanced', 'Advanced') }}</h3>
    <div class="set-card">
      <!-- The texts that tell an agent works, waits for an approval or hit
           its limit: the built-in rules, or the user's rules file over them
           (agentStateRules.js). -->
      <div class="set-row" data-test="agent-rules">
        <div class="set-label">
          {{ t('settings.agents.rules', 'Detection rules') }}
          <span class="set-hint">{{ t('settings.agents.rulesHint', 'How Tessel tells an agent works, waits for your approval or hit its limit') }}</span>
          <span class="set-hint" :class="{ 'set-error': agentRulesStatus.state === 'invalid' }" data-test="agent-rules-status">{{ agentRulesLine }}</span>
          <span v-if="agentRulesError" class="set-hint set-error">{{ agentRulesError }}</span>
        </div>
        <button class="exit-btn" type="button" data-test="agent-rules-open" :title="t('settings.agents.rulesOpenHint', 'Saved changes apply at once')" @click="openAgentRules">
          {{ t('settings.agents.rulesOpen', 'Open rules file') }}
        </button>
      </div>
      <!-- The last update attempts (kept by Tessel, at most 20). -->
      <div v-if="updateHistory.length" class="set-row agent-history" data-test="agent-update-history">
        <div class="set-label">
          <button class="agent-history-toggle" type="button" :aria-expanded="historyOpen" @click="historyOpen = !historyOpen">
            <svg class="sl-chevron" :class="{ open: historyOpen }" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {{ historyTitle }}
          </button>
          <ul v-if="historyOpen" class="agent-history-list">
            <li v-for="(e, i) in updateHistory" :key="`${e.agentId}-${e.at}-${i}`" :class="{ failed: !e.ok }" data-test="agent-update-history-entry">
              <span class="set-hint">{{ whenText(e.at) }}</span>
              <span>{{ e.name }}</span>
              <span class="set-hint">{{ versionsText(e) }}</span>
              <span class="agent-history-kind">{{ updateKindLabel(e.kind) }}</span>
              <span v-if="e.via === 'pane'" class="set-hint">{{ t('settings.agents.viaPane', 'in a terminal') }}</span>
              <span v-else-if="e.auto" class="set-hint">{{ t('settings.agents.viaAuto', 'automatic') }}</span>
              <button v-if="e.file" class="exit-btn small" type="button" @click="emit('open-update-log', e.file)">
                {{ t('settings.agents.viewLog', 'View log') }}
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The updates toolbar: the summary and its buttons on one line while they
   fit, the automatic updates under them. */
.agents-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding-bottom: 12px;
}
.agents-toolbar-main {
  display: flex;
  flex: 1 1 200px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.agents-toolbar-title {
  color: var(--text-strong);
  font-size: 13px;
}
.agents-toolbar-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
.agents-auto {
  display: flex;
  flex: 1 1 100%;
  align-items: center;
  gap: 10px;
  color: var(--text-strong);
  font-size: 12.5px;
  cursor: pointer;
}
.agents-auto-text {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 8px;
  min-width: 0;
}

/* A row: the button that opens the details, then the switch (a control of
   its own, not inside the button) and the chevron. */
.agent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-right: 8px;
  border-radius: 6px;
}
.agent-row:hover,
.sl-item.open > .agent-row {
  background: var(--surface-3);
}
.agent-row > .sl-row {
  flex: 1 1 auto;
  min-width: 0;
}
.agent-row > .sl-row:hover {
  background: transparent;
}
.agent-row > .sl-chevron {
  cursor: pointer;
}
.sl-item.off .sl-row-name,
.sl-item.off .sl-row-icon {
  opacity: 0.55;
}
.agent-tag-busy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* The details. */
.agent-details {
  text-align: left;
}
.agent-details > .sl-section-head:not(:first-child) {
  margin-top: 12px;
}
.agent-update {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  margin-bottom: 6px;
  font-size: 12px;
}
.agent-update p {
  margin: 0;
}
.agent-version.agent-update-available {
  color: var(--accent);
}
.agent-update-job {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.agent-update-last {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--text);
}
.agent-update-last.failed .agent-update-result {
  color: var(--warn);
}
.agent-update-why {
  color: var(--text-dim);
}
.agent-update-detail {
  display: block;
  color: var(--text-dim);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.agent-update-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.agent-update-actions:empty {
  display: none;
}
.agent-custom {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 6px;
}
.agent-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.agent-input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  font-family: 'Cascadia Mono', Consolas, monospace;
}
.agent-env {
  height: auto;
  padding: 5px 8px;
  resize: vertical;
}
.agent-env-error {
  margin: 0;
}
.agent-details-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.agent-details-foot:empty {
  display: none;
}

/* Empty and detecting. */
.agents-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 12px;
}

/* The agents not installed: one compact line each. */
.agents-missing {
  padding-top: 8px;
}
.agents-missing-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 2px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.agents-missing-toggle:focus-visible,
.agent-history-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.sl-chevron.open {
  transform: rotate(90deg);
}
.agents-missing-list {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.agents-missing-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 3px 8px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.agents-missing-name {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agents-missing-why {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agents-missing-actions {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 6px;
  margin-left: auto;
}

/* Advanced > Update history. */
.agent-history .set-label {
  gap: 6px;
}
.agent-history-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 2px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.agent-history-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.agent-history-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 12px;
  font-weight: 400;
}
.agent-history-list li.failed .agent-history-kind {
  color: var(--warn);
}
</style>
