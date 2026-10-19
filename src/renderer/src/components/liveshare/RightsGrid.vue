<script>
import { Keyboard, SquareTerminal, SquareX, Gauge, FilePenLine, GitCommitHorizontal, ListTodo, Globe, Circle } from 'lucide-vue-next'
// Each right's icon, also for the views that show rights as columns
// (LsAccess.vue's grid).
const ICONS = { type: Keyboard, open: SquareTerminal, close: SquareX, usage: Gauge, edit: FilePenLine, git: GitCommitHorizontal, tasks: ListTodo, pagesView: Globe }
export const rightIcon = (id) => ICONS[id] || Circle
</script>

<script setup>
// Live Share: someone's rights, the one way every view shows them (an
// invitation, the first invitation, a person, a trusted person, the accept
// prompt). Optionally the presets first (View only · Collaborate · Full
// control · Custom), then one tile per right of the catalog
// (liveShareRights.js shownRights, in its order: Type first), each an icon
// and a short label, the full words in its tooltip and for screen readers.
// Type, which runs commands as you, has a red outline and says so. Under the
// tiles, what the preset means, or what the right under the pointer allows.
//
// Each tile shows what the subject has now; a click asks for the change
// (toggle) and the tile follows `rights` when it comes back (main's answer,
// or the form's own copy). A preset asks for the whole set (preset).
//
// `dense`: one wrapping row of small chips, for the rows of a list.
// `agents`: a row for the agents they may use, under the tiles (the #agents
// slot; for now every agent, which is what a guest gets).
import { ref, computed, useId } from 'vue'
import { Check, Bot } from 'lucide-vue-next'
import { shownRights, rightsPreset, presetLabel, presetHint, dangerTag } from '../../liveShareRights'
import { t } from '../../i18n'

const props = defineProps({
  rights: { type: Object, default: () => ({}) },
  disabled: { type: Boolean, default: false },
  // A change on its way for this right: its tile waits.
  busy: { type: Function, default: null },
  label: { type: String, default: '' },
  // For data-test: ls-right-<id>-<testKey>, ls-<testKey>-preset-<id>.
  testKey: { type: String, default: '' },
  presets: { type: Boolean, default: false },
  dense: { type: Boolean, default: false },
  // The line under the tiles (not in dense rows).
  describe: { type: Boolean, default: true },
  agents: { type: Boolean, default: false }
})
// toggle(id, on), preset(id)
const emit = defineEmits(['toggle', 'preset'])

const iconOf = rightIcon

const rows = computed(() => shownRights())
const on = (id) => !!(props.rights && props.rights[id] === true)
const suffix = computed(() => (props.testKey ? '-' + props.testKey : ''))
const groupLabel = computed(() => props.label || t('liveShare.right.groupLabel2', 'What this person can do'))

function change(id, event) {
  const box = event.target
  const want = !!box.checked
  box.checked = on(id)
  emit('toggle', id, want)
}

// The presets: the one the rights match, or Custom (also once picked, to
// change the tiles one by one from a preset).
const customPicked = ref(false)
const preset = computed(() => rightsPreset(props.rights))
const segment = computed(() => (customPicked.value ? 'custom' : preset.value))
const PRESETS = computed(() => ['view', 'collaborate', 'full', 'custom'].map((id) => ({ id, label: presetLabel(id) })))
function pick(id) {
  if (props.disabled) return
  if (id === 'custom') {
    customPicked.value = true
    return
  }
  customPicked.value = false
  emit('preset', id)
}
const group = useId()

// What the line under the tiles says: the right under the pointer (or the
// keyboard), else what the preset means.
const pointed = ref(null)
const pointedRight = computed(() => rows.value.find((r) => r.id === pointed.value) || null)
const describeText = computed(() => {
  if (pointedRight.value) return pointedRight.value.label + '. ' + pointedRight.value.hint
  return props.presets ? presetHint(segment.value === 'custom' ? 'custom' : preset.value, props.rights) : ''
})
const describeWarn = computed(() => (pointedRight.value ? pointedRight.value.danger : props.presets && preset.value === 'full'))
</script>

<template>
  <div class="lsr" :class="{ dense }" role="group" :aria-label="groupLabel">
    <div v-if="presets && !dense" class="lsr-seg" role="radiogroup" :aria-label="t('liveShare.preset.label', 'Preset')">
      <label
        v-for="p in PRESETS"
        :key="p.id"
        class="lsr-seg-item"
        :class="{ on: segment === p.id, disabled }"
        :data-test="p.id === 'custom' ? 'ls-' + testKey + '-customize' : 'ls-' + testKey + '-preset-' + p.id"
        @click="p.id === 'custom' && pick('custom')"
      >
        <input type="radio" :name="group" :value="p.id" :checked="segment === p.id" :disabled="disabled" @change="pick(p.id)" />
        <span>{{ p.label }}</span>
      </label>
    </div>

    <div class="lsr-grid">
      <label
        v-for="r in rows"
        :key="r.id"
        class="lsr-item"
        :class="{ on: on(r.id), danger: r.danger, waiting: !!(busy && busy(r.id)) }"
        :title="r.label + '\n' + r.hint"
        :data-test="'ls-right-' + r.id + suffix"
        @mouseenter="pointed = r.id"
        @mouseleave="pointed === r.id && (pointed = null)"
        @focusin="pointed = r.id"
        @focusout="pointed === r.id && (pointed = null)"
      >
        <input type="checkbox" :checked="on(r.id)" :disabled="disabled || !!(busy && busy(r.id))" @change="change(r.id, $event)" />
        <component :is="iconOf(r.id)" :size="dense ? 12 : 14" class="lsr-icon" aria-hidden="true" />
        <span class="lsr-short" aria-hidden="true">{{ r.short }}</span>
        <span class="sr-only">{{ r.label }}</span>
        <span v-if="r.danger && !dense" class="tag tag-danger lsr-tag" aria-hidden="true">{{ dangerTag() }}</span>
        <Check v-if="on(r.id) && !dense" :size="12" class="lsr-check" aria-hidden="true" />
      </label>
    </div>

    <p v-if="describe && !dense && describeText" class="lsr-describe" :class="{ warn: describeWarn }" :data-test="presets ? 'ls-' + testKey + '-preset-hint' : 'ls-rights-describe' + suffix">{{ describeText }}</p>

    <div v-if="agents && !dense" class="lsr-agents" :data-test="'ls-agents' + suffix">
      <span class="lsr-agents-label"><Bot :size="13" aria-hidden="true" /> {{ t('liveShare.agents.label', 'Agents they can use') }}</span>
      <slot name="agents">
        <span class="tag tag-scope">{{ t('liveShare.agents.all', 'All agents') }}</span>
      </slot>
    </div>
  </div>
</template>

<style scoped>
.lsr {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.lsr.dense {
  gap: 0;
}
.lsr-seg {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.lsr-seg-item {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.lsr-seg-item input,
.lsr-item input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.lsr-seg-item:hover {
  background: var(--surface-3);
  color: var(--text);
}
.lsr-seg-item.on {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--text-strong);
}
.lsr-seg-item.disabled {
  opacity: 0.6;
  cursor: default;
}
.lsr-seg-item:has(:focus-visible),
.lsr-item:has(:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* The tiles: as many columns as fit (four in the dialog at 720 px). */
.lsr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 6px;
}
.lsr-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.lsr-item:hover {
  background: var(--surface-3);
  color: var(--text);
}
.lsr-item.on {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--text-strong);
}
.lsr-item.on .lsr-icon {
  color: var(--accent);
}
/* Type: runs commands as you. Its outline says so even while off. */
.lsr-item.danger {
  grid-column: span 2;
  border-color: color-mix(in srgb, var(--danger) 55%, transparent);
}
.lsr-item.danger.on {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
}
.lsr-item.danger.on .lsr-icon {
  color: #ffb4b6;
}
.lsr-item.waiting {
  opacity: 0.6;
  cursor: progress;
}
.lsr-icon {
  flex: none;
}
.lsr-short {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lsr-item.danger .lsr-short {
  flex: none;
}
.lsr-tag {
  min-width: 0;
  flex: 0 1 auto;
}
.lsr-check {
  flex: none;
  margin-left: auto;
  color: var(--accent);
}
.lsr-item.danger .lsr-check {
  color: #ffb4b6;
}
.lsr-describe {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.4;
}
.lsr-describe.warn {
  color: var(--warn);
}
.lsr-agents {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.lsr-agents-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
  font-size: 12px;
}

/* Dense: a row of chips (a person's row, a trusted person, a project's
   people). */
.dense .lsr-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.dense .lsr-item {
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border-radius: 11px;
  font-size: 11.5px;
}
.dense .lsr-item.danger {
  grid-column: auto;
}
</style>
