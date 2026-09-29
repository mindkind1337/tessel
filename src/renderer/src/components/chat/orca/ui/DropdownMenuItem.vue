<script setup>
// After Orca's components/ui/dropdown-menu.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DropdownMenuItem: role="menuitem" (override with role="switch" etc.),
 * data-highlighted while focused, data-variant, data-inset, data-disabled.
 * Props: variant 'default' | 'destructive', inset, disabled, textValue (for
 *   typeahead when the text is not plain).
 * Emits: select(event) on click / Enter / Space; the menu closes unless the
 *   listener calls event.preventDefault().
 * <DropdownMenuItem :disabled="!settable" @select="(e) => { e.preventDefault(); toggle() }">…</DropdownMenuItem>
 */
import { useMenuItem } from './menu.js'
import { bindWith } from './primitive.js'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  variant: { type: String, default: 'default' },
  inset: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  textValue: { type: String, default: undefined }
})
const emit = defineEmits(['select'])

const { highlighted, handlers } = useMenuItem({
  disabled: () => props.disabled,
  onSelect: (event) => emit('select', event)
})
</script>

<template>
  <div
    v-bind="
      bindWith(
        { role: 'menuitem', ...$attrs },
        {
          tabindex: -1,
          'data-slot': 'dropdown-menu-item',
          'data-nc-menu-item': '',
          'data-inset': inset ? '' : undefined,
          'data-variant': variant,
          'data-disabled': disabled ? '' : undefined,
          'aria-disabled': disabled ? 'true' : undefined,
          'data-highlighted': highlighted ? '' : undefined,
          'data-text-value': textValue
        },
        handlers
      )
    "
    class="nc-ui-menu-item"
  >
    <slot />
  </div>
</template>
