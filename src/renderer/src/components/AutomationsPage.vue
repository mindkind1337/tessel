<script setup>
// Settings > Automations: scheduled agent tasks, after Orca's Automations
// page (src/renderer/src/components/automations/AutomationsPage*.tsx,
// AutomationDetail.tsx, AutomationRunHistory.tsx and
// settings/AutomationsSettingsPane.tsx, MIT, Copyright (c) 2026 Lovecast
// Inc.): how they work, the list (schedule, project, agent, next and last
// run, on or paused), Run Now, edit, delete, and each one's run history with
// a link to its pane and its card. They run only while Tessel is open.
import { ref, computed, inject, onMounted, onUnmounted } from 'vue'
import { t } from '../i18n'
import BrandIcon from './BrandIcon.vue'
import AutomationEditor from './AutomationEditor.vue'
import { MAX_CONCURRENT_LIMIT } from '../../../shared/automations'
import {
  automationsState,
  loadAutomations,
  createAutomation,
  updateAutomation,
  setAutomationEnabled,
  removeAutomation,
  runAutomationNow,
  setAutomationSettings,
  runsOf
} from '../automationsStore'
import { scheduleLabel, graceLabel, statusLabel, statusTone, runReason, triggerLabel, formatDateTime, relativeTime } from '../automationLabels'

const empty = { value: [] }
const ctx = inject('automations', null) || {
  projects: empty,
  agents: empty,
  permissions: () => null,
  paneOpen: () => false,
  cardOpen: () => false,
  showPane: () => {},
  showCard: () => {},
  openAgentSettings: () => {}
}
const askConfirm = inject('askConfirm', null)

const editing = ref(null) // null | 'new' | automation id
const selectedId = ref(null)
const editorError = ref('')
const busy = ref(false)
const notice = ref('')
const historyLimit = ref(20)
const now = ref(Date.now())
let clock = 0
onMounted(() => {
  loadAutomations()
  clock = setInterval(() => (now.value = Date.now()), 30000)
})
onUnmounted(() => clearInterval(clock))

const projects = computed(() => ctx.projects.value || [])
const agents = computed(() => ctx.agents.value || [])
const list = computed(() => automationsState.automations)
const editingAutomation = computed(() => (editing.value && editing.value !== 'new' ? list.value.find((a) => a.id === editing.value) || null : null))
const selected = computed(() => list.value.find((a) => a.id === selectedId.value) || null)
const selectedRuns = computed(() => (selected.value ? runsOf(selected.value.id) : []))

function agentName(id) {
  return (agents.value.find((a) => a.id === id) || {}).name || id
}
function projectName(a) {
  const p = projects.value.find((x) => x.wsId === a.wsId)
  return p ? p.name : t('automations.page.projectMissing', '{{name}} (not open)', { name: a.projectName || '?' })
}
function lastRun(a) {
  return runsOf(a.id)[0] || null
}
function activeRun(a) {
  return runsOf(a.id).find((r) => ['pending', 'dispatching', 'dispatched'].includes(r.status)) || null
}

function permissionText(agentId) {
  const p = ctx.permissions(agentId)
  if (!p) return ''
  if (p.yolo) return t('automations.perms.yolo', 'Yolo is on for it ({{args}}): it acts without asking you, running commands and changing files while you may be away.', { args: p.args })
  if (p.ownArgs) return t('automations.perms.ownArgs', 'It starts with your own arguments for it: {{args}}', { args: p.args })
  return t('automations.perms.manual', 'Manual: it asks before acting. An unattended run stops at each approval until you answer it in its pane (you are notified).')
}

// The first time an automation may run on its own: said plainly, confirmed.
async function confirmUnattended(a) {
  if (!askConfirm) return false
  return await askConfirm({
    title: t('automations.confirm.title', 'Let "{{name}}" run unattended?', { name: a.name }),
    text:
      t('automations.confirm.text', 'Tessel will start {{agent}} in {{project}} on this schedule while it is open, even when you are away.', {
        agent: agentName(a.agentId),
        project: a.projectName || projectName(a)
      }) +
      ' ' +
      permissionText(a.agentId),
    confirmLabel: t('automations.confirm.ok', 'Allow')
  })
}

function openNew() {
  editorError.value = ''
  editing.value = 'new'
}
function openEdit(a) {
  editorError.value = ''
  editing.value = a.id
}

async function save(input) {
  busy.value = true
  editorError.value = ''
  try {
    const current = editingAutomation.value
    let confirmed = false
    if (input.enabled && !(current && current.confirmedAt)) {
      confirmed = await confirmUnattended({ ...input, projectName: input.projectName })
      if (!confirmed) {
        editorError.value = t('automations.page.notConfirmed', 'Not saved: it needs your confirmation to run on its own. Turn off "Run on its schedule" to save it paused.')
        return
      }
    }
    const res = current ? await updateAutomation(current.id, { ...input, confirmed }) : await createAutomation({ ...input, confirmed })
    if (!res.ok) {
      editorError.value = res.error || t('automations.page.saveFailed', 'Failed to save automation.')
      return
    }
    notice.value = current ? t('automations.page.updated', 'Automation updated.') : t('automations.page.saved', 'Automation saved.')
    editing.value = null
    selectedId.value = res.automation ? res.automation.id : selectedId.value
  } finally {
    busy.value = false
  }
}

async function toggle(a) {
  let confirmed = false
  if (!a.enabled && !a.confirmedAt) {
    confirmed = await confirmUnattended(a)
    if (!confirmed) return
  }
  const res = await setAutomationEnabled(a.id, !a.enabled, confirmed)
  notice.value = res.ok ? '' : res.error
}

// The switch shows the saved state until the change is done (it may be refused).
function onToggle(e, a) {
  e.target.checked = a.enabled
  toggle(a)
}

async function runNow(a) {
  let confirmed = false
  if (!a.confirmedAt) {
    confirmed = await confirmUnattended(a)
    if (!confirmed) return
  }
  const res = await runAutomationNow(a.id, confirmed)
  notice.value = res.ok ? t('automations.page.queued', 'Automation run queued.') : res.error
  if (res.ok) selectedId.value = a.id
}

async function remove(a) {
  const ok = askConfirm
    ? await askConfirm({
        title: t('automations.delete.title', 'Delete Automation'),
        text: t('automations.delete.text', 'Delete "{{name}}" and its run history. Copies of the project and cards made by previous runs are not deleted.', { name: a.name }),
        confirmLabel: t('automations.delete.ok', 'Delete'),
        danger: true
      })
    : true
  if (!ok) return
  const res = await removeAutomation(a.id)
  notice.value = res.ok ? '' : res.error
  if (selectedId.value === a.id) selectedId.value = null
}

async function setMax(e) {
  const v = Number(e.target.value)
  await setAutomationSettings({ maxConcurrent: v })
}

function nextText(a) {
  return t('automations.page.next', 'Next run {{when}}', { when: relativeTime(a.nextRunAt, now.value) || formatDateTime(a.nextRunAt) })
}
function timesText(r) {
  return t('automations.history.times', '{{times}} times', { times: r.occurrenceCount })
}

function select(a) {
  selectedId.value = selectedId.value === a.id ? null : a.id
  historyLimit.value = 20
}
</script>

<template>
  <div class="au-page" data-test="automations-page">
    <div class="au-how">
      <h3 class="set-group-title">{{ t('automations.how.title', 'How Automations work') }}</h3>
      <ol class="au-steps">
        <li>
          <strong>{{ t('automations.how.defineTitle', 'Describe the work') }}</strong>
          <span>{{ t('automations.how.defineText', 'Choose a project, agent, prompt, and schedule.') }}</span>
        </li>
        <li>
          <strong>{{ t('automations.how.runTitle', 'Tessel starts each run') }}</strong>
          <span>{{ t('automations.how.runText', 'When the schedule is due, the agent starts in a new pane of the project, in its own copy or in the project folder, with a card on the board.') }}</span>
        </li>
        <li>
          <strong>{{ t('automations.how.reviewTitle', 'Review the results') }}</strong>
          <span>{{ t('automations.how.reviewText', 'Inspect recent runs, open their pane or card, and continue the work whenever you need to.') }}</span>
        </li>
      </ol>
      <p class="au-closed" data-test="au-only-open">
        {{
          t(
            'automations.how.onlyOpen',
            'Automations run only while Tessel is open: nothing is scheduled in Windows. A run missed while Tessel was closed or the computer asleep runs once when Tessel is back, if it is within the automation\'s grace; older ones are skipped.'
          )
        }}
      </p>
    </div>

    <p v-if="automationsState.error" class="set-hint set-warn" role="alert">{{ automationsState.error }}</p>

    <div class="set-row">
      <div class="set-label">
        {{ t('automations.page.maxConcurrent', 'Runs at the same time') }}
        <span class="set-hint">{{ t('automations.page.maxConcurrentHint', 'All automations together; the others wait their turn. The same automation never runs twice at once.') }}</span>
      </div>
      <select class="set-select au-max" :value="automationsState.settings.maxConcurrent" data-test="au-max" @change="setMax">
        <option v-for="n in MAX_CONCURRENT_LIMIT" :key="n" :value="n">{{ n }}</option>
      </select>
    </div>

    <AutomationEditor
      v-if="editing"
      :key="editing"
      :automation="editingAutomation"
      :projects="projects"
      :agents="agents"
      :permissions="ctx.permissions"
      :error="editorError"
      :busy="busy"
      @save="save"
      @cancel="editing = null"
      @agent-settings="ctx.openAgentSettings()"
    />

    <template v-else>
      <div class="au-toolbar">
        <h3 class="set-group-title">{{ t('automations.page.title', 'Automations') }}</h3>
        <button type="button" class="nt-btn primary" data-test="au-new" @click="openNew">{{ t('automations.page.new', 'New Automation') }}</button>
      </div>
      <p v-if="notice" class="set-hint" role="status" data-test="au-notice">{{ notice }}</p>

      <p v-if="!list.length" class="au-empty" data-test="au-empty">{{ t('automations.page.empty', 'Create an automation to start scheduling agent work.') }}</p>

      <ul v-else class="au-list">
        <li v-for="a in list" :key="a.id" class="au-item" :class="{ open: selectedId === a.id, paused: !a.enabled }" :data-automation="a.id">
          <div class="au-row">
            <button type="button" class="au-main" :aria-expanded="selectedId === a.id" @click="select(a)">
              <BrandIcon :kind="a.agentId" :label="agentName(a.agentId)" :size="18" />
              <span class="au-text">
                <span class="au-name">{{ a.name }}</span>
                <span class="au-meta">
                  {{ scheduleLabel(a.schedule) }} · {{ projectName(a) }} · {{ agentName(a.agentId) }}<template v-if="a.model"> · {{ a.model }}</template>
                </span>
                <span class="au-meta">
                  <template v-if="a.enabled">{{ nextText(a) }}</template>
                  <template v-else>{{ t('automations.page.paused', 'Paused') }}</template>
                  <template v-if="lastRun(a)">
                    · {{ t('automations.page.last', 'Last run') }}:
                    <span class="au-badge" :class="statusTone(lastRun(a).status)">{{ statusLabel(lastRun(a).status) }}</span>
                  </template>
                </span>
              </span>
            </button>
            <label class="au-switch" :title="a.enabled ? t('automations.page.pause', 'Pause automation') : t('automations.page.resume', 'Resume automation')">
              <input type="checkbox" class="set-switch" :checked="a.enabled" data-test="au-toggle" @change="onToggle($event, a)" />
            </label>
            <button type="button" class="exit-btn" :disabled="!!activeRun(a)" data-test="au-run-now" @click="runNow(a)">{{ t('automations.page.runNow', 'Run Now') }}</button>
            <button type="button" class="exit-btn" data-test="au-edit" @click="openEdit(a)">{{ t('automations.page.edit', 'Edit') }}</button>
            <button type="button" class="exit-btn danger" data-test="au-delete" @click="remove(a)">{{ t('automations.page.delete', 'Delete') }}</button>
          </div>

          <div v-if="selectedId === a.id" class="au-detail">
            <dl class="au-facts">
              <dt>{{ t('automations.detail.where', 'Run location') }}</dt>
              <dd>{{ a.isolation === 'worktree' ? t('automations.detail.ownCopy', 'Its own copy, new for each run') : t('automations.detail.projectFolder', 'The project folder') }}</dd>
              <dt>{{ t('automations.detail.grace', 'Grace') }}</dt>
              <dd>{{ graceLabel(a.missedRunGraceMinutes) }}</dd>
              <dt>{{ t('automations.detail.permissions', 'Permissions') }}</dt>
              <dd>{{ permissionText(a.agentId) }}</dd>
              <dt>{{ t('automations.detail.prompt', 'Prompt') }}</dt>
              <dd class="au-prompt">{{ a.prompt }}</dd>
            </dl>
            <h4 class="au-hist-title">{{ t('automations.history.title', 'Run history') }}</h4>
            <p v-if="!selectedRuns.length" class="set-hint">{{ t('automations.history.none', 'No runs yet.') }}</p>
            <table v-else class="au-runs" data-test="au-runs">
              <thead>
                <tr>
                  <th>{{ t('automations.history.run', 'Run') }}</th>
                  <th>{{ t('automations.history.status', 'Status') }}</th>
                  <th>{{ t('automations.history.when', 'When') }}</th>
                  <th>{{ t('automations.history.links', 'Open') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in selectedRuns.slice(0, historyLimit)" :key="r.id" :data-run="r.id">
                  <td>
                    #{{ r.runNumber }}
                    <span class="set-hint">{{ triggerLabel(r.trigger) }}</span>
                  </td>
                  <td>
                    <span class="au-badge" :class="statusTone(r.status)">{{ statusLabel(r.status) }}</span>
                    <span v-if="r.occurrenceCount > 1" class="set-hint">{{ timesText(r) }}</span>
                    <div v-if="runReason(r)" class="set-hint au-reason">{{ runReason(r) }}</div>
                  </td>
                  <td>{{ formatDateTime(r.scheduledFor) }}</td>
                  <td class="au-links">
                    <button v-if="ctx.paneOpen(r.paneId)" type="button" class="exit-btn" data-test="au-show-pane" @click="ctx.showPane(r.paneId)">{{ t('automations.history.pane', 'Pane') }}</button>
                    <button v-if="ctx.cardOpen(r.taskId)" type="button" class="exit-btn" data-test="au-show-card" @click="ctx.showCard(r.taskId)">{{ t('automations.history.card', 'Card') }}</button>
                    <span v-if="r.branch" class="set-hint">{{ r.branch }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <button v-if="selectedRuns.length > historyLimit" type="button" class="exit-btn" @click="historyLimit += 20">{{ t('automations.history.more', 'Show more') }}</button>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.au-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.au-how {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
}
.au-steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  margin: 0;
  padding-left: 18px;
  color: var(--text);
  font-size: 12px;
}
.au-steps li span {
  display: block;
  color: var(--text-dim);
}
.au-closed {
  margin: 10px 0 0;
  color: var(--warn);
  font-size: 12px;
}
.au-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.au-toolbar .set-group-title {
  margin: 0;
}
.au-empty {
  color: var(--text-dim);
  font-size: 12.5px;
}
.au-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.au-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
.au-item.paused .au-name {
  color: var(--text-dim);
}
.au-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
}
.au-main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 10px;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.au-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.au-name {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 600;
}
.au-meta {
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.au-switch {
  display: inline-flex;
  align-items: center;
}
.exit-btn.danger {
  color: var(--danger);
}
.au-badge {
  display: inline-block;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--surface-3);
  color: var(--text);
  font-size: 11px;
}
.au-badge.ok {
  color: var(--accent);
}
.au-badge.running {
  color: var(--warn);
}
.au-badge.failed {
  color: var(--danger);
}
.au-detail {
  padding: 8px 12px 12px;
  border-top: 1px solid var(--border);
}
.au-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0 0 10px;
  font-size: 12px;
}
.au-facts dt {
  color: var(--text-dim);
}
.au-facts dd {
  margin: 0;
  color: var(--text);
}
.au-prompt {
  max-height: 120px;
  overflow: auto;
  white-space: pre-wrap;
}
.au-hist-title {
  margin: 6px 0;
  color: var(--text-strong);
  font-size: 12px;
}
.au-runs {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.au-runs th {
  padding: 4px 6px;
  color: var(--text-dim);
  font-weight: 500;
  text-align: left;
}
.au-runs td {
  padding: 5px 6px;
  border-top: 1px solid var(--border);
  color: var(--text);
  vertical-align: top;
}
.au-reason {
  max-width: 360px;
}
.au-links {
  white-space: nowrap;
}
.au-links .exit-btn {
  height: 22px;
  margin-right: 4px;
  padding: 0 8px;
}
</style>
