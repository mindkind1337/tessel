<script setup>
// Creating or editing a scheduled automation, after Orca's editor
// (src/renderer/src/components/automations/AutomationEditorDialog.tsx,
// AutomationSchedulePicker.tsx, AutomationCustomCronPanel.tsx,
// AutomationMissedRunGraceField.tsx, MIT, Copyright (c) 2026 Lovecast Inc.):
// name, project, agent (and its model), prompt, where it works, schedule
// (hourly, daily, weekdays, weekly or a custom cron), missed-run grace and
// what happens after each run. It shows what the agent may do unattended
// (Yolo or not, from Settings > Agents). The page saves it.
import { ref, computed, watch } from 'vue'
import { t } from '../i18n'
import {
  SCHEDULE_PRESETS,
  GRACE_MINUTES,
  DEFAULT_GRACE_MINUTES,
  MAX_PROMPT,
  MAX_REMOTE_PROMPT,
  MAX_NAME,
  scheduleToDraft,
  draftToSchedule,
  isValidSchedule,
  nextOccurrenceAfter
} from '../../../shared/automations'
import { getAgentSessionOptionCatalog, modelOptions } from '../../../shared/agentSessionOptions'
import { modelsFor } from '../agentModels'
import { sessionChoiceLabel } from '../sessionOptionLabels'
import { presetLabel, graceLabel, scheduleLabel, weekdayNames, formatDateTime, automationTemplates } from '../automationLabels'

const props = defineProps({
  // The automation edited, or null for a new one.
  automation: { type: Object, default: null },
  projects: { type: Array, default: () => [] },
  agents: { type: Array, default: () => [] },
  // agentId -> { yolo, args, ownArgs, mode } | null
  permissions: { type: Function, default: () => null },
  error: { type: String, default: '' },
  busy: { type: Boolean, default: false }
})
const emit = defineEmits(['save', 'cancel', 'agent-settings'])

const a = props.automation
const firstAgent = props.agents.find((x) => x.available) || props.agents[0]
const name = ref(a ? a.name : '')
const prompt = ref(a ? a.prompt : '')
const wsId = ref(a ? a.wsId : props.projects[0] ? props.projects[0].wsId : '')
const agentId = ref(a ? a.agentId : firstAgent ? firstAgent.id : '')
const model = ref(a ? a.model || '' : '')
const effort = ref(a ? a.effort || '' : '')
const isolation = ref(a ? a.isolation : 'worktree')
const draft = ref(a ? scheduleToDraft(a.schedule) : { preset: 'daily', time: '09:00', dayOfWeek: 1, custom: '' })
const grace = ref(a ? a.missedRunGraceMinutes : DEFAULT_GRACE_MINUTES)
const notify = ref(a ? a.after?.notify !== false : true)
const closePane = ref(a ? a.after?.closePane === true : false)
const enabled = ref(a ? a.enabled : true)
const templateId = ref('')

const templates = computed(() => automationTemplates())
function useTemplate(id) {
  const tpl = templates.value.find((x) => x.id === id)
  if (!tpl) return
  name.value = tpl.name
  prompt.value = tpl.prompt
  draft.value = { preset: tpl.preset, time: tpl.time || '09:00', dayOfWeek: tpl.dayOfWeek ?? 1, custom: '' }
  grace.value = tpl.grace
}
watch(templateId, useTemplate)

const project = computed(() => props.projects.find((p) => p.wsId === wsId.value) || null)
// The project an automation was saved for, even if it is gone now.
const projectMissing = computed(() => !!a && !project.value)
const remote = computed(() => !!(project.value && project.value.remote))
watch(remote, (r) => {
  if (r) isolation.value = 'project'
})

// Model and effort: the agent's catalog (Settings > Agents lists the same).
const models = computed(() => (agentId.value ? modelsFor(agentId.value) : []))
const effortChoices = computed(() => {
  const catalog = getAgentSessionOptionCatalog(agentId.value)
  if (!catalog || !model.value) return []
  const opt = modelOptions(catalog, models.value, model.value).find((o) => o.id === 'effort')
  return opt && opt.kind && Array.isArray(opt.kind.choices) ? opt.kind.choices : []
})
watch(agentId, () => {
  model.value = ''
  effort.value = ''
})
watch(model, () => {
  if (!effortChoices.value.some((c) => c.value === effort.value)) effort.value = ''
})

const perms = computed(() => (agentId.value ? props.permissions(agentId.value) : null))
const agentName = computed(() => (props.agents.find((x) => x.id === agentId.value) || {}).name || agentId.value)

// Schedule
const schedule = computed(() => draftToSchedule(draft.value))
const scheduleValid = computed(() => isValidSchedule(schedule.value))
const cronInvalid = computed(() => draft.value.preset === 'custom' && !!draft.value.custom.trim() && !scheduleValid.value)
const nextRun = computed(() => {
  if (!scheduleValid.value) return null
  try {
    const now = Date.now()
    return nextOccurrenceAfter(schedule.value, now, now)
  } catch {
    return null
  }
})
const days = computed(() => weekdayNames())
const minute = computed({
  get: () => Number(String(draft.value.time || '00:00').split(':')[1] || 0),
  set: (v) => {
    const m = Math.max(0, Math.min(59, Math.floor(Number(v) || 0)))
    draft.value = { ...draft.value, time: `00:${String(m).padStart(2, '0')}` }
  }
})
function setPreset(preset) {
  const d = { ...draft.value, preset }
  // Orca seeds a custom cron from the preset it replaces.
  if (preset === 'custom' && !d.custom.trim() && draft.value.preset !== 'custom') {
    const [h, m] = String(draft.value.time || '09:00').split(':').map(Number)
    const dow = draft.value.dayOfWeek
    d.custom =
      draft.value.preset === 'hourly'
        ? `${m} * * * *`
        : draft.value.preset === 'weekdays'
          ? `${m} ${h} * * 1-5`
          : draft.value.preset === 'weekly'
            ? `${m} ${h} * * ${dow}`
            : `${m} ${h} * * *`
  }
  draft.value = d
}

const promptMax = computed(() => (remote.value ? MAX_REMOTE_PROMPT : MAX_PROMPT))
const missing = computed(() => {
  if (!name.value.trim()) return t('automations.editor.needName', 'Give the automation a name.')
  if (!project.value) return t('automations.editor.needProject', 'Choose a project.')
  if (!agentId.value) return t('automations.editor.needAgent', 'Choose an agent before saving.')
  if (!prompt.value.trim()) return t('automations.editor.needPrompt', 'Enter a prompt before saving.')
  if (prompt.value.length > promptMax.value) return t('automations.editor.promptTooLong', 'The prompt is too long (at most {{max}} characters here).', { max: promptMax.value })
  if (!scheduleValid.value) return t('automations.editor.needSchedule', 'Enter a valid schedule before saving.')
  return ''
})

// Texts with placeholders (kept out of the template's own {{ }}).
function goneLabel() {
  return t('automations.editor.projectGone', '{{name}} (no longer open)', { name: (a && a.projectName) || wsId.value })
}
function projectLabel(p) {
  return p.remote ? t('automations.editor.remoteProject', '{{name}} (on {{host}})', { name: p.name, host: p.hostLabel || p.remote.hostId }) : p.name
}
function agentLabel(ag) {
  return ag.available ? ag.name : t('automations.editor.agentMissing', '{{name}} (not installed)', { name: ag.name })
}
function promptHint() {
  return remote.value
    ? t('automations.editor.promptRemoteHint', "On a remote project the prompt goes on the agent's command line, as one line (at most {{max}} characters).", { max: MAX_REMOTE_PROMPT })
    : t('automations.editor.promptHint', 'Each run starts the agent with this prompt (kept in a file it reads; nothing is typed into its terminal).')
}
function nextRunText() {
  return t('automations.editor.nextRun', '{{schedule}} · next run {{when}}', { schedule: scheduleLabel(schedule.value), when: formatDateTime(nextRun.value) })
}
function permsTitle() {
  return t('automations.perms.title', 'What {{agent}} may do, unattended', { agent: agentName.value })
}
function yoloText() {
  return t('automations.perms.yolo', 'Yolo is on for it ({{args}}): it acts without asking you, running commands and changing files while you may be away.', { args: perms.value.args })
}
function ownArgsText() {
  return t('automations.perms.ownArgs', 'It starts with your own arguments for it: {{args}}', { args: perms.value.args })
}

function save() {
  if (missing.value || props.busy) return
  const p = project.value
  emit('save', {
    name: name.value.trim(),
    prompt: prompt.value,
    agentId: agentId.value,
    model: model.value || null,
    effort: model.value && effort.value ? effort.value : null,
    wsId: p.wsId,
    projectName: p.name,
    projectCwd: p.cwd,
    remote: p.remote,
    isolation: remote.value ? 'project' : isolation.value,
    schedule: schedule.value,
    missedRunGraceMinutes: grace.value,
    after: { notify: notify.value, closePane: closePane.value },
    enabled: enabled.value
  })
}
</script>

<template>
  <form class="au-editor" data-test="automation-editor" @submit.prevent="save" @keydown.escape.stop.prevent="emit('cancel')">
    <header class="au-editor-head">
      <h3>{{ automation ? t('automations.editor.editTitle', 'Edit automation') : t('automations.editor.createTitle', 'Create automation') }}</h3>
      <p class="set-hint">{{ t('automations.editor.subtitle', 'A recurring agent task') }}</p>
    </header>

    <label v-if="!automation" class="au-field">
      <span class="au-label">{{ t('automations.editor.useTemplate', 'Use template') }}</span>
      <select v-model="templateId" class="set-select" data-test="au-template">
        <option value="">{{ t('automations.editor.noTemplate', 'None') }}</option>
        <option v-for="tpl in templates" :key="tpl.id" :value="tpl.id" :title="tpl.description">{{ tpl.label }}</option>
      </select>
    </label>

    <label class="au-field">
      <span class="au-label">{{ t('automations.editor.name', 'Automation name') }}</span>
      <input v-model="name" class="nt-input" data-test="au-name" :maxlength="MAX_NAME" :placeholder="t('automations.editor.namePlaceholder', 'Weekday repo audit')" />
    </label>

    <div class="au-grid">
      <label class="au-field">
        <span class="au-label">{{ t('automations.editor.project', 'Project') }}</span>
        <select v-model="wsId" class="set-select" data-test="au-project">
          <option v-if="projectMissing" :value="wsId" disabled>{{ goneLabel() }}</option>
          <option v-for="p in projects" :key="p.wsId" :value="p.wsId">{{ projectLabel(p) }}</option>
        </select>
        <span v-if="!projects.length" class="set-hint set-warn">{{ t('automations.editor.noProjects', 'Open a project first: an automation runs in one of your projects.') }}</span>
      </label>
      <label class="au-field">
        <span class="au-label">{{ t('automations.editor.agent', 'Agent') }}</span>
        <select v-model="agentId" class="set-select" data-test="au-agent">
          <option v-for="ag in agents" :key="ag.id" :value="ag.id" :disabled="!ag.available">{{ agentLabel(ag) }}</option>
        </select>
        <span v-if="!agents.length" class="set-hint set-warn">{{ t('automations.editor.noAgents', 'No agent that can run automations is on (Claude Code, Codex, Gemini or Qwen).') }}</span>
      </label>
    </div>

    <div v-if="models.length" class="au-grid">
      <label class="au-field">
        <span class="au-label">{{ t('automations.editor.model', 'Model') }}</span>
        <select v-model="model" class="set-select" data-test="au-model">
          <option value="">{{ t('automations.editor.defaultModel', "The agent's default (Settings > Agents)") }}</option>
          <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label || m.id }}</option>
        </select>
      </label>
      <label v-if="effortChoices.length" class="au-field">
        <span class="au-label">{{ t('automations.editor.effort', 'Effort') }}</span>
        <select v-model="effort" class="set-select" data-test="au-effort">
          <option value="">{{ t('automations.editor.defaultEffort', 'Default') }}</option>
          <option v-for="c in effortChoices" :key="c.value" :value="c.value">{{ sessionChoiceLabel(c) }}</option>
        </select>
      </label>
    </div>

    <label class="au-field">
      <span class="au-label">{{ t('automations.editor.prompt', 'Prompt') }}</span>
      <textarea
        v-model="prompt"
        class="nt-input nt-brief"
        rows="5"
        data-test="au-prompt"
        :placeholder="t('automations.editor.promptPlaceholder', 'Run the weekly dependency audit and summarize risky changes.')"
      ></textarea>
      <span class="set-hint">{{ promptHint() }}</span>
    </label>

    <fieldset class="au-field au-where">
      <legend class="au-label">{{ t('automations.editor.where', 'Where it works') }}</legend>
      <label class="nt-where" :class="{ on: isolation === 'worktree' && !remote, off: remote }">
        <input v-model="isolation" type="radio" value="worktree" :disabled="remote" data-test="au-worktree" />
        <span class="nt-where-body">
          <span class="nt-where-name">{{ t('automations.editor.ownCopy', 'In its own copy, new for each run') }}</span>
          <span class="nt-where-sub">{{
            remote
              ? t('automations.editor.ownCopyRemote', 'Not for a remote project: it runs in the project folder.')
              : t('automations.editor.ownCopyHint', 'A new git branch in a separate folder each run; you review and merge its work.')
          }}</span>
        </span>
      </label>
      <label class="nt-where" :class="{ on: isolation === 'project' || remote }">
        <input v-model="isolation" type="radio" value="project" data-test="au-project-folder" />
        <span class="nt-where-body">
          <span class="nt-where-name">{{ t('automations.editor.direct', 'Directly in the project folder') }}</span>
          <span class="nt-where-sub">{{ t('automations.editor.directHint', 'Its edits land in the project right away. Best for reports and checks.') }}</span>
        </span>
      </label>
    </fieldset>

    <fieldset class="au-field">
      <legend class="au-label">{{ t('automations.editor.schedule', 'Schedule') }}</legend>
      <div class="au-sched">
        <select :value="draft.preset" class="set-select" :aria-label="t('automations.editor.cadence', 'Cadence')" data-test="au-preset" @change="setPreset($event.target.value)">
          <option v-for="p in SCHEDULE_PRESETS" :key="p" :value="p">{{ presetLabel(p) }}</option>
        </select>
        <select v-if="draft.preset === 'weekly'" v-model.number="draft.dayOfWeek" class="set-select" :aria-label="t('automations.editor.day', 'Day')" data-test="au-day">
          <option v-for="(d, i) in days" :key="i" :value="i">{{ d }}</option>
        </select>
        <label v-if="draft.preset === 'hourly'" class="au-inline">
          <span>{{ t('automations.editor.minute', 'Minute') }}</span>
          <input v-model.number="minute" type="number" min="0" max="59" class="set-number au-minute" data-test="au-minute" />
        </label>
        <label v-else-if="draft.preset !== 'custom'" class="au-inline">
          <span>{{ t('automations.editor.time', 'Time') }}</span>
          <input v-model="draft.time" type="time" class="set-number au-time" data-test="au-time" />
        </label>
      </div>
      <div v-if="draft.preset === 'custom'" class="au-cron">
        <input
          v-model="draft.custom"
          class="nt-input au-cron-input"
          spellcheck="false"
          data-test="au-cron"
          :aria-label="t('automations.editor.cron', 'Cron expression')"
          :placeholder="'0 9 * * 1-5'"
        />
        <span class="set-hint au-cron-fields">{{ t('automations.editor.cronFields', 'Minute · Hour · Day · Month · Weekday') }}</span>
        <span v-if="cronInvalid" class="set-hint set-warn" data-test="au-cron-invalid">{{ t('automations.editor.cronInvalid', 'Enter a valid five-field cron before saving.') }}</span>
        <span v-else-if="!draft.custom.trim()" class="set-hint">{{ t('automations.editor.cronEmpty', 'Enter a five-field cron.') }}</span>
      </div>
      <span v-if="scheduleValid" class="set-hint" data-test="au-next">{{ nextRunText() }}</span>
    </fieldset>

    <div class="au-grid">
      <label class="au-field">
        <span class="au-label">{{ t('automations.editor.grace', 'Grace') }}</span>
        <select v-model.number="grace" class="set-select" data-test="au-grace">
          <option v-for="g in GRACE_MINUTES" :key="g" :value="g">{{ graceLabel(g) }}</option>
        </select>
        <span class="set-hint">{{
          t(
            'automations.editor.graceHint',
            'If Tessel was closed (or the computer asleep) at the scheduled time, it runs one missed occurrence when it is back within this window. Older missed runs are skipped.'
          )
        }}</span>
      </label>
      <fieldset class="au-field">
        <legend class="au-label">{{ t('automations.editor.after', 'After each run') }}</legend>
        <label class="au-check"><input v-model="notify" type="checkbox" data-test="au-notify" /> {{ t('automations.editor.notify', 'Notify me') }}</label>
        <label class="au-check"><input v-model="closePane" type="checkbox" data-test="au-close" /> {{ t('automations.editor.closePane', 'Close its pane') }}</label>
        <span class="set-hint">{{ t('automations.editor.cardHint', 'Each run is a card on the project\'s board: in Review when it worked in its own copy, else in Done.') }}</span>
      </fieldset>
    </div>

    <div class="au-perms" :class="{ warn: perms && perms.yolo }" data-test="au-perms">
      <strong>{{ permsTitle() }}</strong>
      <p v-if="!perms">{{ t('automations.perms.unknown', 'Choose an agent to see its permissions.') }}</p>
      <template v-else>
        <p v-if="perms.yolo" data-test="au-yolo">{{ yoloText() }}</p>
        <p v-else-if="perms.ownArgs">{{ ownArgsText() }}</p>
        <p v-else>{{ t('automations.perms.manual', 'Manual: it asks before acting. An unattended run stops at each approval until you answer it in its pane (you are notified).') }}</p>
        <p>{{ t('automations.perms.account', 'It uses the account chosen for it in Settings > AI provider accounts, and your settings for it in Settings > Agents.') }}</p>
        <button type="button" class="exit-btn" @click="emit('agent-settings')">{{ t('automations.perms.change', 'Change in Settings > Agents') }}</button>
      </template>
    </div>

    <label class="au-check">
      <input v-model="enabled" type="checkbox" data-test="au-enabled" />
      {{ t('automations.editor.enabled', 'Run on its schedule') }}
    </label>
    <p class="set-hint">{{ t('automations.editor.onceSaved', 'Once saved, runs automatically until paused, only while Tessel is open.') }}</p>

    <p v-if="error || missing" class="set-hint set-warn" role="alert" data-test="au-error">{{ error || missing }}</p>
    <footer class="nt-actions">
      <button type="button" class="nt-btn" @click="emit('cancel')">{{ t('automations.editor.cancel', 'Cancel') }}</button>
      <button type="submit" class="nt-btn primary" data-test="au-save" :disabled="!!missing || busy">
        {{ automation ? t('automations.editor.saveChanges', 'Save Changes') : t('automations.editor.create', 'Create') }}
      </button>
    </footer>
  </form>
</template>

<style scoped>
.au-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface);
}
.au-editor-head h3 {
  margin: 0;
  color: var(--text-strong);
  font-size: 14px;
}
.au-editor-head p {
  margin: 2px 0 0;
}
.au-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.au-label {
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.au-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.au-where {
  gap: 6px;
}
.au-sched {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.au-inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  font-size: 12px;
}
.au-minute {
  min-width: 70px;
  width: 70px;
}
.au-time {
  min-width: 110px;
  width: 110px;
}
.au-cron {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 6px;
}
.au-cron-input {
  font-family: var(--mono, 'Cascadia Mono', Consolas, monospace);
}
.au-check {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  font-size: 12.5px;
}
.au-perms {
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 12px;
}
.au-perms.warn {
  border-color: var(--warn);
}
.au-perms p {
  margin: 4px 0;
}
</style>
