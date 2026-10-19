<script setup>
// Live Share: "Agents guests may use" for an invitation, a person, a trusted
// person, or the whole share (its setting, for whoever has none of its own).
// A box per agent you have (installed and turned on: the ones guests could
// open), and per agent, its models when you want to allow only some; then
// "Allow agents I add later". Each change is emitted as a whole rule
// (liveShareAgents.js); the boxes follow `rule` when it comes back.
//
// `inheritable`: the subject may follow the share's setting (no rule of its
// own): "Same as the share's setting", on while it has none. Your Tessel is
// what enforces the rule (liveShare/shareHost.js); a guest's menu only lists
// what it allows.
import { ref, reactive, computed, inject, useId } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { cleanAgentRule, agentAllowed, allowedModels, setAgentAllowed, setAgentLater, setAgentModels } from '../../../../shared/liveShareAgents'
import { t } from '../../i18n'

const props = defineProps({
  // The subject's own rule (null: none).
  rule: { type: Object, default: null },
  inheritable: { type: Boolean, default: true },
  // Your agents ([{ id, name, models }]); else the dialog's (main's list).
  agents: { type: Array, default: null },
  // The share's setting, followed while the subject has no rule; else the
  // dialog's.
  shareRule: { type: Object, default: undefined },
  busy: { type: Boolean, default: false },
  // Starts open (the share's setting); else behind its summary line.
  startOpen: { type: Boolean, default: false },
  // For data-test: ls-agents-<testKey>-...
  testKey: { type: String, default: '' }
})
// change(rule | null)
const emit = defineEmits(['change'])

const ctx = inject('lsDialog', null)
const hostAgents = computed(() => {
  if (Array.isArray(props.agents)) return props.agents
  const list = ctx && ctx.host && ctx.host.value && ctx.host.value.agents
  return Array.isArray(list) ? list : []
})
const shared = computed(() => {
  if (props.shareRule !== undefined) return cleanAgentRule(props.shareRule)
  const s = ctx && ctx.host && ctx.host.value && ctx.host.value.settings
  return cleanAgentRule(s && s.agents)
})
const own = computed(() => cleanAgentRule(props.rule))
// Following the share's setting (nothing of its own to change here).
const following = computed(() => props.inheritable && !own.value)
// The rule that counts, shown in the boxes.
const shown = computed(() => (props.inheritable ? own.value || shared.value : own.value))
const hostIds = computed(() => hostAgents.value.map((a) => a.id))

const open = ref(props.startOpen)
const modelsOpen = reactive({})
const key = (part) => 'ls-agents-' + (props.testKey ? props.testKey + '-' : '') + part
const uid = useId()

// In a few words: "All agents", "2 of 5 agents", "+ some models only".
function summaryOf(rule) {
  const list = hostAgents.value
  const allowed = list.filter((a) => agentAllowed(rule, a.id))
  const limited = allowed.some((a) => allowedModels(rule, a.id))
  let text = !list.length ? t('liveShare.agents.noneInstalled', 'No agent installed') : allowed.length === list.length ? t('liveShare.agents.all', 'All agents') : allowed.length ? t('liveShare.agents.some', '{{count}} of {{total}} agents', { count: allowed.length, total: list.length }) : t('liveShare.agents.none', 'No agent')
  if (limited) text = t('liveShare.agents.someModels', '{{agents}}, some models only', { agents: text })
  const r = cleanAgentRule(rule)
  if (r && !r.later) text = t('liveShare.agents.notLater', '{{agents}}, not the ones you add later', { agents: text })
  return text
}
const summary = computed(() => (following.value ? t('liveShare.agents.following', 'As the share’s setting: {{summary}}', { summary: summaryOf(shared.value) }) : summaryOf(shown.value)))

const later = computed(() => !shown.value || shown.value.later)
const allowedNow = (id) => agentAllowed(shown.value, id)
const onlyModels = (id) => allowedModels(shown.value, id)
const modelOn = (a, m) => {
  const only = onlyModels(a.id)
  return !only || only.some((x) => x.toLowerCase() === m.id.toLowerCase())
}
function modelsText(a) {
  const only = onlyModels(a.id)
  if (!only) return t('liveShare.agents.allModels', 'All models')
  return t('liveShare.agents.someModelsOf', '{{count}} of {{total}} models', { count: only.length, total: (a.models || []).length })
}

// A change, made on the rule that counts (the share's, copied, when the
// subject followed it).
const base = () => shown.value
function setFollow(event) {
  const box = event.target
  const want = !!box.checked
  box.checked = following.value
  emit('change', want ? null : cleanAgentRule(shared.value) || setAgentLater(null, true, hostIds.value))
}
function setAgent(a, event) {
  const box = event.target
  const want = !!box.checked
  box.checked = allowedNow(a.id)
  emit('change', setAgentAllowed(base(), a.id, want, hostIds.value))
}
function setLater(event) {
  const box = event.target
  const want = !!box.checked
  box.checked = later.value
  emit('change', setAgentLater(base(), want, hostIds.value))
}
// All models (none limited), or only the ones ticked (all of them at first).
function setAllModels(a, event) {
  const box = event.target
  const want = !!box.checked
  box.checked = !onlyModels(a.id)
  emit('change', setAgentModels(base(), a.id, want ? null : (a.models || []).map((m) => m.id), hostIds.value))
}
function setModel(a, m, event) {
  const box = event.target
  const want = !!box.checked
  box.checked = modelOn(a, m)
  const only = onlyModels(a.id) || (a.models || []).map((x) => x.id)
  const next = want ? [...only, m.id] : only.filter((x) => x.toLowerCase() !== m.id.toLowerCase())
  // The last model stays: untick the agent itself to refuse it.
  if (!next.length) return
  emit('change', setAgentModels(base(), a.id, next, hostIds.value))
}
const lastModel = (a, m) => {
  const only = onlyModels(a.id)
  return !!only && only.length === 1 && modelOn(a, m)
}
</script>

<template>
  <div class="lsa" :data-test="key('root')">
    <button type="button" class="lsa-toggle" :aria-expanded="open" :aria-controls="uid + '-body'" :data-test="key('toggle')" @click="open = !open">
      <ChevronDown :size="13" :class="{ closed: !open }" aria-hidden="true" />
      <span class="lsa-title">{{ t('liveShare.agents.title', 'Agents they may use') }}</span>
      <span class="lsa-summary" :data-test="key('summary')">{{ summary }}</span>
    </button>
    <div v-show="open" :id="uid + '-body'" class="lsa-body" role="group" :aria-label="t('liveShare.agents.title', 'Agents they may use')">
      <label v-if="inheritable" class="lsa-item" :data-test="key('follow')">
        <input type="checkbox" :checked="following" :disabled="busy" @change="setFollow" />
        <span>{{ t('liveShare.agents.follow', 'Same as the share’s setting') }}</span>
      </label>
      <p v-if="!hostAgents.length" class="lsa-hint">{{ t('liveShare.agents.noneHint', 'No agent is installed and turned on in Settings > Agents.') }}</p>
      <div v-for="a in hostAgents" :key="a.id" class="lsa-agent">
        <div class="lsa-agent-row">
          <label class="lsa-item" :data-test="key('agent-' + a.id)">
            <input type="checkbox" :checked="allowedNow(a.id)" :disabled="busy || following" @change="setAgent(a, $event)" />
            <span>{{ a.name || a.id }}</span>
          </label>
          <button
            v-if="a.models && a.models.length && allowedNow(a.id)"
            type="button"
            class="lsa-models-toggle"
            :aria-expanded="!!modelsOpen[a.id]"
            :data-test="key('models-' + a.id)"
            @click="modelsOpen[a.id] = !modelsOpen[a.id]"
          >
            {{ modelsText(a) }}
            <ChevronDown :size="11" :class="{ closed: !modelsOpen[a.id] }" aria-hidden="true" />
          </button>
        </div>
        <div v-if="modelsOpen[a.id] && allowedNow(a.id) && a.models && a.models.length" class="lsa-models" role="group" :aria-label="t('liveShare.agents.modelsOf', 'Models of {{agent}}', { agent: a.name || a.id })">
          <label class="lsa-item" :data-test="key('allmodels-' + a.id)">
            <input type="checkbox" :checked="!onlyModels(a.id)" :disabled="busy || following" @change="setAllModels(a, $event)" />
            <span>{{ t('liveShare.agents.allModelsLater', 'All models (including new ones)') }}</span>
          </label>
          <label v-for="m in a.models" :key="m.id" class="lsa-item" :data-test="key('model-' + a.id + '-' + m.id)">
            <input type="checkbox" :checked="modelOn(a, m)" :disabled="busy || following || !onlyModels(a.id) || lastModel(a, m)" @change="setModel(a, m, $event)" />
            <span>{{ m.label || m.id }}</span>
          </label>
        </div>
      </div>
      <label class="lsa-item" :data-test="key('later')">
        <input type="checkbox" :checked="later" :disabled="busy || following" @change="setLater" />
        <span class="lsa-text">
          <span>{{ t('liveShare.agents.later', 'Allow agents I add later') }}</span>
          <span class="lsa-hint">{{ t('liveShare.agents.laterHint', 'Agents you install or subscribe to after this.') }}</span>
        </span>
      </label>
      <p class="lsa-hint" :data-test="key('hint')">{{ t('liveShare.agents.hint', 'They still see the panes of agents you leave out, but can’t open them, type in them or switch them to a model you leave out. A terminal they can type in can still start any program.') }}</p>
    </div>
  </div>
</template>

<style scoped>
.lsa {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.lsa-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 2px 0;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.lsa-toggle:focus-visible,
.lsa-models-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lsa-toggle .closed,
.lsa-models-toggle .closed {
  transform: rotate(-90deg);
}
.lsa-title {
  flex: none;
}
.lsa-summary {
  min-width: 0;
  color: var(--text-dim);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.lsa-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-left: 19px;
  min-width: 0;
}
.lsa-agent-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.lsa-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  padding: 1px 0;
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.35;
  cursor: pointer;
}
.lsa-item input {
  flex: none;
  margin: 2px 0 0;
  accent-color: var(--accent);
}
.lsa-item input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lsa-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.lsa-models-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  line-height: 18px;
  cursor: pointer;
}
.lsa-models {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 22px;
}
.lsa-hint {
  margin: 0;
  color: var(--text-dim);
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
</style>
