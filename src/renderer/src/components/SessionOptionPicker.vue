<script setup>
// Choosing an agent's model, effort and fast mode, after Orca's per-session
// pickers (src/renderer/src/components/native-chat/
// NativeChatSessionOptionPickers.tsx, MIT, Copyright (c) 2026 Lovecast Inc.):
// the model as radio rows (name and description), then the chosen model's
// options. A flip-only option (Claude's /fast) is an action, never On/Off;
// an agent whose running session changes model in its own picker (Codex)
// offers "Choose in agent picker…". Used by the new pane menu and a pane's
// … menu; the caller decides what a pick does.
import { computed, onMounted } from 'vue'
import { refreshIfStale } from '../agentModels'
import { getAgentSessionOptionCatalog, modelOptions } from '../../../shared/agentSessionOptions'
import { sessionOptionLabel, sessionChoiceLabel, modelDescription } from '../sessionOptionLabels'
import { t } from '../i18n'
import { modelLabel } from '../../../shared/modelLabel'

const props = defineProps({
  agentId: { type: String, required: true },
  models: { type: Array, default: () => [] },
  // The values chosen now ({ model, effort?, fastMode? }), null = none.
  values: { type: Object, default: null },
  // The row for "no model chosen" (the agent's own or Settings' default).
  defaultLabel: { type: String, default: '' },
  defaultHint: { type: String, default: '' },
  // The pane runs this agent now (a pick may apply at once).
  live: { type: Boolean, default: false },
  // The model the agent runs with when none is chosen: its options (effort)
  // are offered too, a choice then keeps that model.
  fallbackModel: { type: String, default: null },
  // Why picks cannot be applied now (e.g. while it works), or ''.
  disabledReason: { type: String, default: '' },
  // A line under the title (e.g. "Applies when the agent restarts").
  note: { type: String, default: '' },
  pending: { type: Boolean, default: false }
})
const emit = defineEmits(['set', 'action'])

const catalog = computed(() => getAgentSessionOptionCatalog(props.agentId))
// Shown: a missing or old model list is refreshed in the background.
onMounted(() => refreshIfStale(props.agentId))
// The agent may report its full id (claude-fable-5-1, opus[1m]) where the
// list has the alias it was chosen by ("Fable 5.1"): that row is the current
// one, never a second row with the raw id.
const chosenModel = computed(() => {
  const model = (props.values && props.values.model) || null
  if (!model || props.models.some((m) => m.id === model)) return model
  const name = modelLabel(model)
  const plain = name.replace(/ \(1M\)$/, '')
  const same =
    props.models.find((m) => m.label && (m.label === name || m.label === plain)) ||
    props.models.find((m) => m.id === model.replace(/\[1m\]$/i, ''))
  return same ? same.id : model
})
const optionsModel = computed(() => chosenModel.value || props.fallbackModel || null)
const options = computed(() => (catalog.value && optionsModel.value ? modelOptions(catalog.value, props.models, optionsModel.value) : []))
// The chosen model is listed even when the list does not have it (a model
// chosen before, or one the CLI no longer lists).
const rows = computed(() => {
  const list = props.models.slice()
  if (chosenModel.value && !list.some((m) => m.id === chosenModel.value)) list.push({ id: chosenModel.value, label: modelLabel(chosenModel.value) || chosenModel.value, options: [] })
  return list
})
const modelPicker = computed(() => {
  const mid = catalog.value && catalog.value.modelApply.midSession
  return props.live && mid && mid.kind === 'agent-picker'
})
const disabled = computed(() => props.pending || !!props.disabledReason)

// An option row: its kind and how it applies in a running session.
function optionMode(option) {
  const mid = option.apply.midSession
  if (props.live && mid && mid.kind === 'toggle-command') return 'toggle'
  if (props.live && mid && mid.kind === 'agent-picker') return 'agent-picker'
  if (option.kind.type === 'boolean') {
    // A value only a running session takes (Claude's fast mode): nothing to
    // choose before it starts.
    if (!option.apply.launchArgs && !option.apply.composedIntoModel) return 'hidden'
    return 'switch'
  }
  return 'select'
}
const shownOptions = computed(() => options.value.filter((o) => optionMode(o) !== 'hidden'))

function toggleText(option) {
  return t('pane.sessionOptions.toggleOption', 'Toggle {{option}}', { option: sessionOptionLabel(option).toLowerCase() })
}
function value(option) {
  return props.values ? props.values[option.id] : undefined
}
function set(optionId, v) {
  if (disabled.value) return
  emit('set', { optionId, value: v })
}
function action(optionId) {
  if (disabled.value) return
  emit('action', { optionId })
}
</script>

<template>
  <div class="sop" data-test="session-option-picker" role="group" :aria-label="t('pane.sessionOptions.model', 'Model')">
    <div class="sop-label">{{ t('pane.sessionOptions.model', 'Model') }}</div>
    <p v-if="note" class="sop-note" data-test="sop-note">{{ note }}</p>
    <p v-if="disabledReason" class="sop-note" data-test="sop-disabled">{{ disabledReason }}</p>
    <button
      v-if="modelPicker"
      class="sop-row"
      type="button"
      data-test="sop-agent-picker"
      :disabled="disabled"
      @click="action('model')"
    >
      {{ t('pane.sessionOptions.chooseInAgentPicker', 'Choose in agent picker…') }}
    </button>
    <button
      v-if="defaultLabel"
      class="sop-row"
      type="button"
      role="menuitemradio"
      data-test="sop-model-default"
      :aria-checked="!chosenModel"
      :class="{ on: !chosenModel }"
      :disabled="disabled"
      @click="set('model', null)"
    >
      <span class="sop-check" aria-hidden="true">{{ !chosenModel ? '●' : '' }}</span>
      <span class="sop-body">
        <span class="sop-name">{{ defaultLabel }}</span>
        <span v-if="defaultHint" class="sop-desc">{{ defaultHint }}</span>
      </span>
    </button>
    <button
      v-for="m in rows"
      :key="m.id"
      class="sop-row"
      type="button"
      role="menuitemradio"
      data-test="sop-model"
      :data-model="m.id"
      :aria-checked="chosenModel === m.id"
      :class="{ on: chosenModel === m.id }"
      :disabled="disabled"
      @click="set('model', m.id)"
    >
      <span class="sop-check" aria-hidden="true">{{ chosenModel === m.id ? '●' : '' }}</span>
      <span class="sop-body">
        <span class="sop-name">{{ m.label }}</span>
        <span v-if="m.description" class="sop-desc">{{ modelDescription(m) }}</span>
      </span>
    </button>
    <template v-for="o in shownOptions" :key="o.id">
      <div class="sop-sep"></div>
      <template v-if="optionMode(o) === 'toggle'">
        <!-- Why (Orca): flip-only without a baseline is an action — never claim On/Off. -->
        <button class="sop-row" type="button" data-test="sop-toggle" :data-option="o.id" :disabled="disabled" @click="action(o.id)">
          {{ toggleText(o) }}
        </button>
      </template>
      <template v-else-if="optionMode(o) === 'agent-picker'">
        <div class="sop-label">{{ sessionOptionLabel(o) }}</div>
        <button class="sop-row" type="button" data-test="sop-agent-picker-option" :disabled="disabled" @click="action(o.id)">
          {{ t('pane.sessionOptions.chooseInAgentPicker', 'Choose in agent picker…') }}
        </button>
      </template>
      <template v-else-if="optionMode(o) === 'switch'">
        <label class="sop-row sop-switch">
          <span>{{ sessionOptionLabel(o) }}</span>
          <input
            type="checkbox"
            class="set-switch"
            :data-option="o.id"
            :checked="value(o) === undefined ? o.kind.defaultValue : value(o) === true"
            :disabled="disabled"
            @change="set(o.id, $event.target.checked)"
          />
        </label>
      </template>
      <template v-else>
        <div class="sop-label">{{ sessionOptionLabel(o) }}</div>
        <button
          class="sop-row"
          type="button"
          role="menuitemradio"
          data-test="sop-option-default"
          :data-option="o.id"
          :aria-checked="value(o) === undefined"
          :class="{ on: value(o) === undefined }"
          :disabled="disabled"
          @click="set(o.id, null)"
        >
          <span class="sop-check" aria-hidden="true">{{ value(o) === undefined ? '●' : '' }}</span>
          <span class="sop-body"><span class="sop-name">{{ t('pane.sessionOptions.valueIsDefault', 'Default') }}</span></span>
        </button>
        <button
          v-for="c in o.kind.choices"
          :key="c.value"
          class="sop-row"
          type="button"
          role="menuitemradio"
          data-test="sop-option"
          :data-option="o.id"
          :data-value="c.value"
          :aria-checked="value(o) === c.value"
          :class="{ on: value(o) === c.value }"
          :disabled="disabled"
          @click="set(o.id, c.value)"
        >
          <span class="sop-check" aria-hidden="true">{{ value(o) === c.value ? '●' : '' }}</span>
          <span class="sop-body"><span class="sop-name">{{ sessionChoiceLabel(c) }}</span></span>
        </button>
      </template>
    </template>
  </div>
</template>

<style scoped>
.sop {
  display: flex;
  flex-direction: column;
  min-width: 220px;
  max-width: 300px;
  max-height: min(70vh, 520px);
  overflow-y: auto;
  padding: 2px 0;
}
.sop-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim, #8a8f98);
  padding: 6px 10px 2px;
}
.sop-note {
  margin: 0;
  padding: 0 10px 4px;
  font-size: 11px;
  color: var(--text-dim, #8a8f98);
}
.sop-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  padding: 4px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  border-radius: 4px;
}
.sop-row:hover:not(:disabled),
.sop-row:focus-visible {
  background: var(--hover, rgba(127, 127, 127, 0.15));
  outline: none;
}
.sop-row:disabled {
  opacity: 0.55;
  cursor: default;
}
.sop-check {
  width: 10px;
  flex: none;
  font-size: 8px;
  line-height: 16px;
}
.sop-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.sop-desc {
  font-size: 11px;
  color: var(--text-dim, #8a8f98);
}
.sop-switch {
  justify-content: space-between;
  align-items: center;
}
.sop-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border, rgba(127, 127, 127, 0.25));
}
</style>
