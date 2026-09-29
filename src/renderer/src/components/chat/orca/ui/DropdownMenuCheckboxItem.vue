<script setup>
// After Orca's components/ui/dropdown-menu.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DropdownMenuCheckboxItem: role="menuitemcheckbox" with aria-checked and a
 * check mark; selecting toggles it.
 * Props: checked (v-model:checked; true | false | 'indeterminate'),
 *   disabled, textValue.
 * Emits: update:checked, select(event) (preventDefault keeps the menu open).
 */
import { computed } from 'vue'
import { Check } from 'lucide-vue-next'
import { useMenuItem } from './menu.js'
import { bindWith } from './primitive.js'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  checked: { type: [Boolean, String], default: false },
  disabled: { type: Boolean, default: false },
  textValue: { type: String, default: undefined }
})
const emit = defineEmits(['update:checked', 'select'])

const indeterminate = computed(() => props.checked === 'indeterminate')
const state = computed(() => (indeterminate.value ? 'indeterminate' : props.checked ? 'checked' : 'unchecked'))

const { highlighted, handlers } = useMenuItem({
  disabled: () => props.disabled,
  onSelect: (event) => emit('select', event),
  afterSelect: () => emit('update:checked', indeterminate.value ? true : !props.checked)
})
</script>

<template>
  <div
    v-bind="
      bindWith(
        { role: 'menuitemcheckbox', ...$attrs },
        {
          tabindex: -1,
          'aria-checked': indeterminate ? 'mixed' : checked ? 'true' : 'false',
          'data-state': state,
          'data-slot': 'dropdown-menu-checkbox-item',
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
      <Check v-if="state !== 'unchecked'" class="nc-ui-menu-check size-3.5" />
    </span>
    <slot />
  </div>
</template>
