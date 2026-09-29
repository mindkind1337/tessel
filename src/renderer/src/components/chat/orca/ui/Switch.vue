<script setup>
// After Orca's components/ui/switch.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Switch: a button with role="switch" and aria-checked (Radix Switch).
 * Props: checked (v-model:checked; leave unset for uncontrolled),
 *   defaultChecked, disabled, required, name, value (default 'on'),
 *   thumbClass.
 * Emits: update:checked (Boolean).
 * <Switch v-model:checked="enabled" :aria-label="label" />
 */
import { computed, ref } from 'vue'
import { bindWith } from './primitive.js'
import './switch.css'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  checked: { type: Boolean, default: undefined },
  defaultChecked: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  required: { type: Boolean, default: false },
  name: { type: String, default: undefined },
  value: { type: String, default: 'on' },
  thumbClass: { type: [String, Array, Object], default: undefined }
})
const emit = defineEmits(['update:checked'])

const inner = ref(props.defaultChecked)
const isChecked = computed(() => (props.checked === undefined ? inner.value : props.checked))
const state = computed(() => (isChecked.value ? 'checked' : 'unchecked'))

function toggle(event) {
  if (event.defaultPrevented || props.disabled) return
  const next = !isChecked.value
  inner.value = next
  emit('update:checked', next)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    data-slot="switch"
    class="nc-ui-switch-track"
    :aria-checked="isChecked ? 'true' : 'false'"
    :aria-required="required || undefined"
    :data-state="state"
    :data-disabled="disabled ? '' : undefined"
    :disabled="disabled"
    :name="name"
    :value="value"
    v-bind="bindWith($attrs, {}, { onClick: toggle })"
  >
    <span data-slot="switch-thumb" :data-state="state" :class="['nc-ui-switch-thumb', thumbClass]" />
  </button>
</template>
