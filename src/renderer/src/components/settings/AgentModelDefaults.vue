<script setup>
// Settings > Agents > an agent's details: its default model and effort (the
// shared session-option catalogs and the agent's own model list). Nothing
// chosen: the agent's own default, and Tessel adds no flag. What is chosen
// here is what a new pane starts with (agentSessionOptions), so the header,
// team messages and conversations read it as before.
import { t, intlLocale } from '../../i18n'
import { settings } from '../../settings'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { LoaderCircle } from 'lucide-vue-next'
import {
  getAgentSessionOptionCatalog,
  valuesOnListedRow,
  modelOptions,
  resolveSessionOptionDefaults,
  updateSessionOptionDefaults,
  clearSessionOptionModel,
  clearSessionOptionValue
} from '../../../../shared/agentSessionOptions'
import { modelsFor, modelLists, modelProbes, refreshModels, canProbeModels } from '../../agentModels'
import { sessionOptionLabel, sessionChoiceLabel, probeErrorText } from '../../sessionOptionLabels'

const props = defineProps({
  // { id, name } of an installed agent that has a catalog.
  agent: { type: Object, required: true },
  // Its own command (Settings > Agents), for asking it its models.
  command: { type: String, default: '' }
})

function modelDefaults() {
  // A Cursor variant id saved before its list was grouped: its row, with
  // the effort / Fast / Thinking it stands for.
  return valuesOnListedRow(modelsFor(props.agent.id), resolveSessionOptionDefaults(settings.agentSessionOptions, props.agent.id)) || null
}
// The models offered, with the chosen one even when the list lacks it.
function defaultModelRows() {
  const list = modelsFor(props.agent.id)
  const d = modelDefaults()
  return d && !list.some((m) => m.id === d.model) ? [...list, { id: d.model, label: d.model, options: [] }] : list
}
function setDefaultModel(modelId) {
  const id = props.agent.id
  settings.agentSessionOptions = modelId
    ? updateSessionOptionDefaults({ persisted: settings.agentSessionOptions, agent: id, modelId, optionId: 'model', value: modelId })
    : clearSessionOptionModel(settings.agentSessionOptions, id)
}
// The chosen model's options a launch can set (effort; Cursor's thinking and
// fast mode, which go into its model name).
function defaultOptionRows() {
  const d = modelDefaults()
  if (!d) return []
  return modelOptions(getAgentSessionOptionCatalog(props.agent.id), modelsFor(props.agent.id), d.model).filter(
    (o) => o.apply.launchArgs || o.apply.composedIntoModel
  )
}
// A fast mode only a running session takes (Claude Code's /fast).
function defaultHasLiveFast() {
  const d = modelDefaults()
  return !!d && modelOptions(getAgentSessionOptionCatalog(props.agent.id), modelsFor(props.agent.id), d.model).some(
    (o) => o.id === 'fastMode' && !o.apply.launchArgs && !o.apply.composedIntoModel
  )
}
function setDefaultOption(optionId, value) {
  const id = props.agent.id
  const d = modelDefaults()
  if (!d) return
  let persisted = settings.agentSessionOptions
  // A saved Cursor variant id becomes its row: the values it stood for are
  // kept with the one changed now.
  const stored = resolveSessionOptionDefaults(persisted, id)
  if (stored && stored.model !== d.model) {
    persisted = updateSessionOptionDefaults({ persisted, agent: id, modelId: d.model, optionId: 'model', value: d.model })
    for (const [k, v] of Object.entries(d)) if (k !== 'model') persisted = updateSessionOptionDefaults({ persisted, agent: id, modelId: d.model, optionId: k, value: v })
  }
  settings.agentSessionOptions =
    value === '' || value === null
      ? clearSessionOptionValue({ persisted, agent: id, modelId: d.model, optionId })
      : updateSessionOptionDefaults({ persisted, agent: id, modelId: d.model, optionId, value })
}
function probe() {
  return modelProbes[props.agent.id] || { busy: false, error: null }
}
function modelListText() {
  const a = props.agent
  const list = modelLists[a.id]
  const p = probe()
  if (p.busy) return t('settings.agents.modelsListing', 'Asking {{name}} for its models…', { name: a.name })
  if (p.error) return probeErrorText(p.error, a.name)
  if (!canProbeModels(a.id) && !list) return t('settings.agents.modelsBuiltInOnly', 'Built-in model list. The agent may also offer other models in its own settings.')
  // No built-in list (OpenCode: its providers are the account's own).
  if (!list && !modelsFor(a.id).length) return t('settings.agents.modelsNone', 'No list yet. Refresh asks {{name}} for the models it offers.', { name: a.name })
  if (!list) return t('settings.agents.modelsBuiltIn', 'Built-in list. Refresh asks {{name}} for the models your account has.', { name: a.name })
  // One model: the singular (English here, French through its _one key).
  const count = list.models.length
  return t('settings.agents.modelsListed', count === 1 ? '{{count}} model listed by {{name}} on {{date}}.' : '{{count}} models listed by {{name}} on {{date}}.', {
    count,
    name: a.name,
    date: new Date(list.fetchedAt).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
  })
}
</script>

<template>
  <div class="agent-models" :data-test="`agent-models-${agent.id}`">
    <label class="agent-model-field">
      <span class="set-hint">{{ t('settings.agents.defaultModel', 'Model') }}</span>
      <ThemedSelect class="set-select" :data-test="`agent-model-${agent.id}`" @change="setDefaultModel($event.target.value)">
        <option value="" :selected="!modelDefaults()">{{ t('pane.sessionOptions.agentDefault', "Agent's own default") }}</option>
        <option v-for="m in defaultModelRows()" :key="m.id" :value="m.id" :selected="!!modelDefaults() && modelDefaults().model === m.id">
          {{ m.label }}
        </option>
      </ThemedSelect>
    </label>
    <template v-for="o in defaultOptionRows()" :key="o.id">
      <label v-if="o.kind.type === 'select'" class="agent-model-field">
        <span class="set-hint">{{ sessionOptionLabel(o) }}</span>
        <ThemedSelect class="set-select" :data-test="`agent-option-${agent.id}-${o.id}`" @change="setDefaultOption(o.id, $event.target.value)">
          <option value="" :selected="modelDefaults()[o.id] === undefined">{{ t('pane.sessionOptions.valueIsDefault', 'Default') }}</option>
          <option v-for="c in o.kind.choices" :key="c.value" :value="c.value" :selected="modelDefaults()[o.id] === c.value">
            {{ sessionChoiceLabel(c) }}
          </option>
        </ThemedSelect>
      </label>
      <label v-else class="agent-model-field agent-model-switch">
        <span class="set-hint">{{ sessionOptionLabel(o) }}</span>
        <input
          type="checkbox"
          class="set-switch"
          :data-test="`agent-option-${agent.id}-${o.id}`"
          :checked="modelDefaults()[o.id] === undefined ? o.kind.defaultValue : modelDefaults()[o.id] === true"
          @change="setDefaultOption(o.id, $event.target.checked)"
        />
      </label>
    </template>
    <button
      v-if="canProbeModels(agent.id)"
      class="exit-btn small"
      type="button"
      :data-test="`agent-models-refresh-${agent.id}`"
      :disabled="probe().busy"
      :title="t('settings.agents.refreshModelsHint', 'Ask {{name}} which models it offers (it may use its sign-in and the network; no prompt is sent)', { name: agent.name })"
      @click="refreshModels(agent.id, command)"
    >
      <LoaderCircle v-if="probe().busy" :size="11" class="sb-spin" aria-hidden="true" />
      {{ t('settings.agents.refreshModels', 'Refresh models') }}
    </button>
    <div class="set-hint agent-models-status" :class="{ 'agent-models-failed': !!probe().error }" :data-test="`agent-models-status-${agent.id}`">
      {{ modelListText() }}
      <template v-if="defaultHasLiveFast()"> {{ t('settings.agents.fastModeLive', 'Fast mode is switched in a running pane (pane menu > Model).') }}</template>
      {{ modelDefaults() ? t('settings.agents.modelApplies', 'Applies to panes you start from now on; running ones show Restart to apply.') : '' }}
    </div>
  </div>
</template>

<style scoped>
.agent-models {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 6px 12px;
  margin-bottom: 6px;
}
.agent-model-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 220px;
  max-width: 100%;
  min-width: 0;
}
.agent-model-field .set-select {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}
.agent-model-switch {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  width: auto;
}
.agent-models-status {
  flex: 1 1 100%;
  line-height: 1.45;
}
.agent-models-failed {
  color: var(--warn);
}
</style>
