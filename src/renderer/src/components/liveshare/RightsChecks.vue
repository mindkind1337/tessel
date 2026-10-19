<script setup>
// Live Share: a person's, an invitation's or an accept prompt's rights, as
// RightsGrid shows them (one tile per right of the catalog, Type marked),
// without the presets. Kept for the views that toggle one right at a time:
// a click asks for the change (toggle) and the tile follows `rights` when it
// comes back (main's answer, or the form's own copy).
import RightsGrid from './RightsGrid.vue'

defineProps({
  rights: { type: Object, default: () => ({}) },
  disabled: { type: Boolean, default: false },
  // A row of chips (the full words in each one's tooltip).
  compact: { type: Boolean, default: false },
  // The line under the tiles saying what the right under the pointer allows.
  hints: { type: Boolean, default: true },
  label: { type: String, default: '' },
  // For data-test: ls-right-<id>-<testKey>.
  testKey: { type: String, default: '' },
  // A change on its way for this right: its tile waits.
  busy: { type: Function, default: null },
  // The agents row under the tiles (not in compact rows).
  agents: { type: Boolean, default: false }
})
// toggle(id, on)
const emit = defineEmits(['toggle'])
</script>

<template>
  <RightsGrid :rights="rights" :disabled="disabled" :dense="compact" :describe="hints" :label="label" :test-key="testKey" :busy="busy" :agents="agents && !compact" @toggle="(id, on) => emit('toggle', id, on)">
    <template v-if="$slots.agents" #agents><slot name="agents" /></template>
  </RightsGrid>
</template>
