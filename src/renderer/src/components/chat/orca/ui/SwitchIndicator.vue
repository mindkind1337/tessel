<script setup>
// After Orca's components/ui/switch.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * SwitchIndicator: a switch's look with no switch semantics (aria-hidden),
 * for rows that are themselves the control (a menu item with role="switch").
 * Props: checked (Boolean, required); size 'default' | 'compact';
 *   thumbClass (extra class for the thumb).
 * <SwitchIndicator :checked="checked" />
 */
import { computed } from 'vue'
import './switch.css'

const props = defineProps({
  checked: { type: Boolean, required: true },
  size: { type: String, default: 'default' },
  thumbClass: { type: [String, Array, Object], default: undefined }
})

const state = computed(() => (props.checked ? 'checked' : 'unchecked'))
const compact = computed(() => props.size === 'compact')
</script>

<template>
  <span
    aria-hidden="true"
    data-slot="switch-indicator"
    :data-state="state"
    :class="['nc-ui-switch-track', compact && 'nc-ui-switch-track--compact']"
  >
    <span
      data-slot="switch-thumb"
      :data-state="state"
      :class="['nc-ui-switch-thumb', compact && 'nc-ui-switch-thumb--compact', thumbClass]"
    />
  </span>
</template>
