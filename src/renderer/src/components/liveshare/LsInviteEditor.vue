<script setup>
// Live Share: an invitation's settings, to make one or change one (and, with
// `embedded`, the first invitation's settings before you start sharing). A
// label, the shared projects it offers (and whether projects shared later
// are added), the rights it offers, how long it lasts (1 hour by default,
// 1 day, 7 days, or no expiry, which says what it means), and how many
// people may join with it. There is no "let them in without asking": every
// new guest waits for your yes (only trusted people get in without it).
//
// Changing an invitation that people joined with asks what happens to them
// before it is saved: what it no longer gives is taken from them (ticked),
// what it now gives is given only if you tick it. Each person stays
// editable on their own (People).
import { ref, reactive, computed, watch, nextTick, onMounted, useId } from 'vue'
import RightsChecks from './RightsChecks.vue'
import ProjectChecks from './ProjectChecks.vue'
import LsAgents from './LsAgents.vue'
import { cleanRights, setRight, sameRights, withAgents } from '../../../../shared/liveShareRights'
import { grantDiff, inviteExpiry, inviteName } from '../../liveShareAccess'
import { rightWords, rightsShort, presetRights, rightsPreset } from '../../liveShareRights'
import { t } from '../../i18n'

const MAX_LABEL = 40
const MAX_USES = 1000

const props = defineProps({
  // The invitation changed (null: a new one).
  invite: { type: Object, default: null },
  // The projects shared now ({ id, name }).
  projects: { type: Array, default: () => [] },
  // The first invitation, set before sharing starts: no projects (it offers
  // every shared project), no buttons, each change emitted.
  embedded: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  now: { type: Number, default: () => Date.now() }
})
// submit({ spec, applyRemovals, applyAdditions }) (a new invitation: spec is
// the whole thing; a change: only what changed), cancel, update (embedded:
// the spec as it is now).
const emit = defineEmits(['submit', 'cancel', 'update'])

const LIFETIMES = computed(() => [
  { id: 'hour', label: t('liveShare.invite.lifetimeHour', '1 hour') },
  { id: 'day', label: t('liveShare.invite.lifetimeDay', '1 day') },
  { id: 'week', label: t('liveShare.invite.lifetimeWeek', '7 days') },
  { id: 'never', label: t('liveShare.invite.lifetimeNever', 'No expiry') }
])

const editing = computed(() => !!props.invite)
const start = () => {
  const inv = props.invite
  return {
    label: inv ? inv.label || '' : '',
    projects: inv ? [...(inv.projects || [])] : props.projects.map((p) => p.id),
    later: inv ? !!inv.later : false,
    rights: cleanRights(inv ? inv.rights : null),
    lifetime: inv ? inv.lifetime || 'hour' : 'hour',
    maxUses: inv ? String(inv.maxUses || 0) : '0'
  }
}
const form = reactive(start())
// The first step (the form) or the second (what happens to its people).
const step = ref('form')
const applyRemovals = ref(true)
const applyAdditions = ref(false)
const labelEl = ref(null)

watch(
  () => props.invite && props.invite.id,
  () => {
    Object.assign(form, start())
    step.value = 'form'
    customOpen.value = rightsPreset(form.rights) === 'custom'
  }
)

const usesNumber = computed(() => {
  const text = String(form.maxUses).trim()
  if (text === '') return 0
  return /^\d+$/.test(text) ? Number(text) : NaN
})
const usesError = computed(() =>
  Number.isInteger(usesNumber.value) && usesNumber.value >= 0 && usesNumber.value <= MAX_USES ? '' : t('liveShare.invite.usesError', 'Use a whole number from 0 (no limit) to 1000.')
)
const valid = computed(() => !usesError.value && form.label.length <= MAX_LABEL)

function toggleProject(id, on) {
  const rest = form.projects.filter((x) => x !== id)
  form.projects = on ? [...rest, id] : rest
}
function toggleRight(id, on) {
  form.rights = setRight(form.rights, id, on)
}
// The agents its people may use (null: the share's setting).
function setAgents(rule) {
  form.rights = withAgents(form.rights, rule)
}

// The rights as a preset (one click), each box behind Customize: open by
// itself for rights that match no preset.
const PRESETS = computed(() => [
  { id: 'view', label: t('liveShare.invite.presetView', 'View only') },
  { id: 'collaborate', label: t('liveShare.invite.presetCollaborate', 'Collaborate') },
  { id: 'full', label: t('liveShare.invite.presetFull', 'Full control') }
])
const preset = computed(() => rightsPreset(form.rights))
const customOpen = ref(rightsPreset(form.rights) === 'custom')
const showRightBoxes = computed(() => customOpen.value || preset.value === 'custom')
const presetHint = computed(() => {
  if (preset.value === 'view') return t('liveShare.invite.presetViewHint', 'They watch the shared panes and files, nothing else.')
  if (preset.value === 'collaborate') return t('liveShare.invite.presetCollaborateHint', 'They open terminals and agents, edit files, commit and manage tasks. They never type in your terminals.')
  if (preset.value === 'full') return t('liveShare.invite.presetFullHint', 'Every right, typing included: they can run any command on this PC as you. Only for people you trust.')
  return t('liveShare.invite.presetCustomHint', 'Custom: {{rights}}', { rights: rightsShort(form.rights) })
})
// (A preset keeps the agents chosen.)
function choosePreset(id) {
  form.rights = withAgents(presetRights(id), form.rights.agents || null)
}

// The whole invitation as asked for.
const spec = computed(() => {
  const out = { label: form.label.trim(), lifetime: form.lifetime, maxUses: Number.isInteger(usesNumber.value) ? usesNumber.value : 0, rights: { ...form.rights } }
  if (!props.embedded) {
    out.projects = props.projects.map((p) => p.id).filter((id) => form.projects.includes(id))
    out.later = !!form.later
  }
  return out
})
watch(spec, (s) => props.embedded && emit('update', s), { immediate: true, deep: true })

// Only what changed (a lifetime given restarts it from now: kept unless you
// pick another one).
const patch = computed(() => {
  const inv = props.invite
  if (!inv) return spec.value
  const s = spec.value
  const out = {}
  if (s.label !== (inv.label || '')) out.label = s.label
  if (s.lifetime !== inv.lifetime) out.lifetime = s.lifetime
  if (s.maxUses !== (inv.maxUses || 0)) out.maxUses = s.maxUses
  const before = new Set(inv.projects || [])
  if (s.projects.length !== before.size || s.projects.some((id) => !before.has(id))) out.projects = s.projects
  if (s.later !== !!inv.later) out.later = s.later
  if (!sameRights(s.rights, cleanRights(inv.rights))) out.rights = s.rights
  return out
})
const changed = computed(() => !editing.value || Object.keys(patch.value).length > 0)

const diff = computed(() => (props.invite ? grantDiff(props.invite, { projects: spec.value.projects, rights: spec.value.rights }) : null))
const hasRemovals = computed(() => !!diff.value && (diff.value.removedProjects.length > 0 || diff.value.removedRights.length > 0))
const hasAdditions = computed(() => !!diff.value && (diff.value.addedProjects.length > 0 || diff.value.addedRights.length > 0))
const joined = computed(() => (props.invite && Number.isInteger(props.invite.joined) ? props.invite.joined : 0))
const nameOf = (id) => (props.projects.find((p) => p.id === id) || {}).name || id
const rightName = (id) => (id === 'agents' ? t('liveShare.agents.changed', 'the agents they may use (the new list)') : (rightWords(id) || { short: id }).short)
const removalsText = computed(() => (diff.value ? [...diff.value.removedProjects.map(nameOf), ...diff.value.removedRights.map(rightName)].join(', ') : ''))
const additionsText = computed(() => (diff.value ? [...diff.value.addedProjects.map(nameOf), ...diff.value.addedRights.map(rightName)].join(', ') : ''))

function submit() {
  if (!valid.value || props.busy || !changed.value) return
  if (editing.value && joined.value > 0 && (hasRemovals.value || hasAdditions.value) && step.value === 'form') {
    applyRemovals.value = true
    applyAdditions.value = false
    step.value = 'apply'
    return
  }
  emit('submit', { spec: patch.value, applyRemovals: applyRemovals.value, applyAdditions: applyAdditions.value })
}
function back() {
  step.value = 'form'
  nextTick(() => labelEl.value?.focus())
}

const neverNote = computed(() => form.lifetime === 'never')
const currentExpiry = computed(() => (props.invite ? inviteExpiry(props.invite, props.now).text : ''))
const joinedText = computed(() =>
  joined.value === 1 ? t('liveShare.invite.applyLead', '{{count}} person joined with “{{label}}”. What happens to them?', { count: 1, label: inviteName(props.invite) }) : t('liveShare.invite.applyLead', '{{count}} people joined with “{{label}}”. What happens to them?', { count: joined.value, label: inviteName(props.invite) })
)
const title = computed(() => (editing.value ? t('liveShare.invite.editTitle', 'Change “{{label}}”', { label: inviteName(props.invite) }) : t('liveShare.invite.newTitle', 'New invitation')))

// Escape steps back, then cancels (the dialog stays open); the first
// invitation's settings leave Escape to the dialog.
function onEscape(event) {
  if (props.embedded) return
  event.preventDefault()
  event.stopPropagation()
  if (step.value === 'apply') back()
  else emit('cancel')
}

// Each form's own radio group.
const group = useId()

onMounted(() => {
  if (!props.embedded) nextTick(() => labelEl.value?.focus())
})
</script>

<template>
  <form class="lsi-form" :class="{ embedded }" data-test="ls-invite-editor" :aria-label="embedded ? t('liveShare.invite.firstTitle', 'First invitation') : title" @submit.prevent="submit" @keydown.escape="onEscape">
    <template v-if="step === 'form'">
      <div v-if="!embedded" class="lsi-title">{{ title }}</div>
      <label class="lsi-field">
        <span class="lsi-label">{{ t('liveShare.invite.label', 'Label (who it is for)') }}</span>
        <input ref="labelEl" v-model="form.label" class="ls-input" type="text" spellcheck="false" :maxlength="MAX_LABEL" :placeholder="t('liveShare.invite.labelPlaceholder', 'For example Simpa, or Design team')" data-test="ls-invite-label" />
      </label>

      <fieldset v-if="!embedded" class="lsi-fieldset">
        <legend class="lsi-label">{{ t('liveShare.invite.projects', 'Projects it offers') }}</legend>
        <ProjectChecks :projects="projects" :selected="form.projects" test-key="invite" :label="t('liveShare.invite.projects', 'Projects it offers')" :empty="t('liveShare.invite.noProjects', 'Share a project first.')" @toggle="toggleProject" />
        <label class="lsi-check" data-test="ls-invite-later">
          <input v-model="form.later" type="checkbox" />
          <span>{{ t('liveShare.invite.later', 'Include projects you share later') }}</span>
        </label>
      </fieldset>

      <fieldset class="lsi-fieldset">
        <legend class="lsi-label">{{ t('liveShare.invite.rights', 'What they can do (you can change it when you let them in)') }}</legend>
        <div class="lsi-seg" role="radiogroup" :aria-label="t('liveShare.invite.rights', 'What they can do (you can change it when you let them in)')">
          <label v-for="p in PRESETS" :key="p.id" class="lsi-seg-item" :class="{ on: preset === p.id }" :data-test="'ls-invite-preset-' + p.id">
            <input type="radio" :name="group + '-rights'" :value="p.id" :checked="preset === p.id" @change="choosePreset(p.id)" />
            <span>{{ p.label }}</span>
          </label>
          <button type="button" class="lsi-custom" :aria-expanded="showRightBoxes" :disabled="preset === 'custom'" data-test="ls-invite-customize" @click="customOpen = !customOpen">
            {{ t('liveShare.invite.customize', 'Customize') }}
          </button>
        </div>
        <p class="lsi-preset-hint" :class="{ warn: preset === 'full' }" data-test="ls-invite-preset-hint">{{ presetHint }}</p>
        <RightsChecks v-if="showRightBoxes" class="lsi-rights" :rights="form.rights" test-key="invite" :label="t('liveShare.invite.rights', 'What they can do (you can change it when you let them in)')" @toggle="toggleRight" />
        <LsAgents class="lsi-agents" :rule="form.rights.agents || null" :can-type="form.rights.type === true" test-key="invite" @change="setAgents" />
      </fieldset>

      <fieldset class="lsi-fieldset">
        <legend class="lsi-label">{{ t('liveShare.invite.lifetime', 'New people can use it for') }}</legend>
        <div class="lsi-seg" role="radiogroup" :aria-label="t('liveShare.invite.lifetime', 'New people can use it for')">
          <label v-for="l in LIFETIMES" :key="l.id" class="lsi-seg-item" :class="{ on: form.lifetime === l.id }" :data-test="'ls-invite-lifetime-' + l.id">
            <input v-model="form.lifetime" type="radio" :name="group" :value="l.id" />
            <span>{{ l.label }}</span>
          </label>
        </div>
        <p v-if="neverNote" class="lsi-note" role="note" data-test="ls-invite-never-note">{{ t('liveShare.invite.neverNote', 'Anyone with this code can ask to join until you revoke it.') }}</p>
        <p v-if="editing" class="lsi-hint" data-test="ls-invite-current-expiry" v-text="t('liveShare.invite.currentExpiry', 'Now: {{expiry}}. Picking another length starts it again from now.', { expiry: currentExpiry })"></p>
        <p class="lsi-hint">{{ t('liveShare.invite.askAlways', 'Every new person still waits for your yes.') }}</p>
      </fieldset>

      <label class="lsi-field lsi-uses">
        <span class="lsi-label">{{ t('liveShare.invite.maxUses', 'Max uses (0 = no limit)') }}</span>
        <input v-model="form.maxUses" class="ls-input" type="number" min="0" :max="MAX_USES" step="1" inputmode="numeric" :aria-invalid="!!usesError" data-test="ls-invite-uses" />
      </label>
      <p v-if="usesError" class="lsi-error" role="alert" data-test="ls-invite-uses-error">{{ usesError }}</p>

      <div v-if="!embedded" class="lsi-actions">
        <button type="button" class="confirm-btn" data-test="ls-invite-cancel" @click="emit('cancel')">{{ t('liveShare.cancel', 'Cancel') }}</button>
        <button type="submit" class="confirm-btn primary" :disabled="!valid || busy || !changed" data-test="ls-invite-save">
          {{ editing ? t('liveShare.invite.save', 'Save') : t('liveShare.invite.create', 'Create invitation') }}
        </button>
      </div>
    </template>

    <template v-else>
      <div class="lsi-title">{{ title }}</div>
      <p class="lsi-lead" data-test="ls-invite-apply">{{ joinedText }}</p>
      <label v-if="hasRemovals" class="lsi-check" data-test="ls-invite-apply-removals">
        <input v-model="applyRemovals" type="checkbox" />
        <span v-text="t('liveShare.invite.applyRemovals', 'Take away from them what it no longer gives: {{list}}', { list: removalsText })"></span>
      </label>
      <label v-if="hasAdditions" class="lsi-check" data-test="ls-invite-apply-additions">
        <input v-model="applyAdditions" type="checkbox" />
        <span v-text="t('liveShare.invite.applyAdditions', 'Also give them what it now gives: {{list}}', { list: additionsText })"></span>
      </label>
      <p class="lsi-hint">{{ t('liveShare.invite.applyHint', 'Trusted people keep their own settings. You can still change each person in People.') }}</p>
      <div class="lsi-actions">
        <button type="button" class="confirm-btn" data-test="ls-invite-back" @click="back">{{ t('liveShare.invite.back', 'Back') }}</button>
        <button type="submit" class="confirm-btn primary" :disabled="busy" data-test="ls-invite-confirm">{{ t('liveShare.invite.saveChanges', 'Save changes') }}</button>
      </div>
    </template>
  </form>
</template>

<style scoped>
.lsi-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface-2);
}
.lsi-form.embedded {
  padding: 0;
  border: 0;
  background: transparent;
}
.lsi-title {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.lsi-field {
  display: block;
}
.lsi-fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.lsi-fieldset legend {
  padding: 0;
}
.lsi-label {
  display: block;
  margin-bottom: 5px;
  color: var(--text-dim);
  font-size: 12px;
}
.lsi-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 6px;
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.35;
  cursor: pointer;
}
.lsi-check input {
  flex: none;
  margin: 2px 0 0;
  accent-color: var(--accent);
}
.lsi-check span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.lsi-seg {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.lsi-seg-item {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.lsi-custom {
  height: 26px;
  margin-left: 4px;
  padding: 0 6px;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.lsi-custom:hover:not(:disabled) {
  text-decoration: underline;
}
.lsi-custom:disabled {
  color: var(--text-dim);
  cursor: default;
}
.lsi-custom:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-radius: 4px;
}
.lsi-preset-hint {
  margin: 6px 0 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.4;
}
.lsi-preset-hint.warn {
  color: var(--warn);
}
.lsi-rights {
  margin-top: 8px;
}
.lsi-seg-item input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.lsi-seg-item:hover {
  background: var(--surface-3);
  color: var(--text);
}
.lsi-seg-item.on {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--text-strong);
}
.lsi-seg-item:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lsi-note {
  margin: 8px 0 0;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--warn) 50%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  color: var(--text);
  font-size: 12px;
  line-height: 1.4;
}
.lsi-hint {
  margin: 6px 0 0;
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.4;
}
.lsi-uses .ls-input {
  max-width: 120px;
}
.lsi-error {
  margin: -6px 0 0;
  color: var(--danger);
  font-size: 12px;
}
.lsi-lead {
  margin: 0;
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.lsi-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
</style>
