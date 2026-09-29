<script setup>
// After Orca's components/ui/dropdown-menu.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DropdownMenuRadioItem: role="menuitemradio" with aria-checked, data-state
 * 'checked' | 'unchecked' and a dot when it is the group's value. Selecting
 * sets the group's v-model (even when the select listener prevents the
 * close, as in Radix).
 * Props: value (required), disabled, textValue.
 * Emits: select(event) (preventDefault keeps the menu open).
 */
import { computed, inject } from 'vue'
import { Circle } from 'lucide-vue-next'
import { MENU_RADIO_GROUP, required } from './contexts.js'
import { useMenuItem } from './menu.js'
import { bindWith } from './primitive.js'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  value: { type: [String, Number, Boolean], required: true },
  disabled: { type: Boolean, default: false },
  textValue: { type: String, default: undefined }
})
const emit = defineEmits(['select'])

const group = required(inject(MENU_RADIO_GROUP, null), 'DropdownMenuRadioItem', 'DropdownMenuRadioGroup')
const checked = computed(() => group.value.value === props.value)

const { highlighted, handlers } = useMenuItem({
  disabled: () => props.disabled,
  onSelect: (event) => emit('select', event),
  afterSelect: () => group.select(props.value)
})
</script>

<template>
  <div
    v-bind="
      bindWith(
        { role: 'menuitemradio', ...$attrs },
        {
          tabindex: -1,
          'aria-checked': checked ? 'true' : 'false',
          'data-state': checked ? 'checked' : 'unchecked',
          'data-slot': 'dropdown-menu-radio-item',
          'data-nc-menu-item': '',
          'data-disabled': disabled ? '' : undefined,
          'aria-disabled': disabled ? 'true' : undefined,
          'data-highlighted': highlighted ? '' : undefined,
          'data-text-value': textValue
        },
        handlers
      )
    "
    class="nc-ui-menu-check-item"
  >
    <span class="nc-ui-menu-indicator">
      <Circle v-if="checked" class="nc-ui-menu-dot size-2" />
    </span>
    <slot />
  </div>
</template>
