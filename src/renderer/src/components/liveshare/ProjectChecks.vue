<script setup>
// Live Share: which projects a person, an invitation or an accept prompt
// gets, as checkboxes. Each box shows what the subject has now; a click asks
// for the change (toggle) and the box follows `selected` when it comes back.
// `chips`: each project a chip, lit while ticked (a check says it, not only
// the colour), as the Overview's projects (People: the projects next to a
// person).
import { computed } from 'vue'
import { Check } from 'lucide-vue-next'
import { t } from '../../i18n'

const props = defineProps({
  // [{ id, name }]
  projects: { type: Array, default: () => [] },
  selected: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
  // One line (wrapping) instead of a list.
  compact: { type: Boolean, default: false },
  chips: { type: Boolean, default: false },
  label: { type: String, default: '' },
  // For data-test: ls-proj-<id>-<testKey>.
  testKey: { type: String, default: '' },
  busy: { type: Function, default: null },
  // Shown when there is no project to tick.
  empty: { type: String, default: '' }
})
// toggle(id, on)
const emit = defineEmits(['toggle'])

const set = computed(() => new Set(props.selected || []))
function change(id, event) {
  const box = event.target
  const want = !!box.checked
  box.checked = set.value.has(id)
  emit('toggle', id, want)
}
const groupLabel = computed(() => props.label || t('liveShare.project.groupLabel', 'Projects they see'))
</script>

<template>
  <p v-if="!projects.length" class="lsp-empty">{{ empty || t('liveShare.project.none', 'No project shared yet.') }}</p>
  <div v-else class="lsp" :class="{ compact: compact || chips, chips }" role="group" :aria-label="groupLabel">
    <label
      v-for="p in projects"
      :key="p.id"
      class="lsp-item"
      :class="{ on: chips && set.has(p.id), waiting: !!(busy && busy(p.id)) }"
      :title="p.name"
      :data-test="'ls-proj-' + p.id + (testKey ? '-' + testKey : '')"
    >
      <input type="checkbox" :checked="set.has(p.id)" :disabled="disabled || !!(busy && busy(p.id))" @change="change(p.id, $event)" />
      <Check v-if="chips && set.has(p.id)" :size="12" class="lsp-check" aria-hidden="true" />
      <span class="lsp-name">{{ p.name }}</span>
    </label>
  </div>
</template>

<style scoped>
.lsp {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.lsp.compact {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.lsp.chips {
  gap: 6px;
}
.lsp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 2px 0;
  color: var(--text);
  font-size: 12.5px;
  cursor: pointer;
}
.compact .lsp-item {
  max-width: 100%;
  font-size: 12px;
}
.lsp-item input {
  flex: none;
  margin: 0;
  accent-color: var(--accent);
}
.lsp-item input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
/* Chips: the box itself hidden, the chip shows it. */
.chips .lsp-item {
  position: relative;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  color: var(--text-dim);
}
.chips .lsp-item input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.chips .lsp-item:hover {
  background: var(--surface-3);
  color: var(--text);
}
.chips .lsp-item.on {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--text-strong);
}
.chips .lsp-item.waiting {
  opacity: 0.6;
  cursor: progress;
}
.chips .lsp-item:has(:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.lsp-check {
  flex: none;
  color: var(--accent);
}
.lsp-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lsp-empty {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
}
</style>
