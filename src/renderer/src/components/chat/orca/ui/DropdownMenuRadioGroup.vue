<script setup>
// After Orca's components/ui/dropdown-menu.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DropdownMenuRadioGroup: role="group" around DropdownMenuRadioItems.
 * Props: modelValue (v-model: the selected item's value).
 * Emits: update:modelValue (the value of the selected radio item).
 * <DropdownMenuRadioGroup v-model="effort" :aria-label="label">…</DropdownMenuRadioGroup>
 */
import { computed, provide } from 'vue'
import { MENU_RADIO_GROUP } from './contexts.js'

const props = defineProps({ modelValue: { type: [String, Number, Boolean], default: undefined } })
const emit = defineEmits(['update:modelValue'])

provide(MENU_RADIO_GROUP, {
  value: computed(() => props.modelValue),
  select: (value) => emit('update:modelValue', value)
})
</script>

<template>
  <div role="group" data-slot="dropdown-menu-radio-group"><slot /></div>
</template>
