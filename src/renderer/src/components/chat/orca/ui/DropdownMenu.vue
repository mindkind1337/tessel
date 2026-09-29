<script setup>
// After Orca's components/ui/dropdown-menu.tsx (shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * DropdownMenu (Radix DropdownMenu.Root; renders no element). Parts:
 * DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
 * DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
 * DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut,
 * DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent.
 * Props: open (v-model:open; leave unset for uncontrolled), defaultOpen,
 *   modal (default true: pointer events outside the menu are blocked while
 *   open, like Radix; pass :modal="false" for a context menu).
 * Emits: update:open (Boolean).
 * Slot props: { open, close }.
 * <DropdownMenu>
 *   <DropdownMenuTrigger as-child><Button variant="ghost" size="xs">{{ label }}</Button></DropdownMenuTrigger>
 *   <DropdownMenuContent align="start" side="top" :collision-padding="8" class="w-64">
 *     <DropdownMenuLabel>{{ heading }}</DropdownMenuLabel>
 *     <DropdownMenuRadioGroup v-model="model" :aria-label="heading">
 *       <DropdownMenuRadioItem v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}</DropdownMenuRadioItem>
 *     </DropdownMenuRadioGroup>
 *     <DropdownMenuSeparator />
 *     <DropdownMenuSub>
 *       <DropdownMenuSubTrigger>{{ moreLabel }}</DropdownMenuSubTrigger>
 *       <DropdownMenuSubContent><DropdownMenuItem @select="fork">{{ forkLabel }}</DropdownMenuItem></DropdownMenuSubContent>
 *     </DropdownMenuSub>
 *     <DropdownMenuItem variant="destructive" @select="remove">{{ deleteLabel }}<DropdownMenuShortcut>Del</DropdownMenuShortcut></DropdownMenuItem>
 *   </DropdownMenuContent>
 * </DropdownMenu>
 */
import { computed, provide, shallowRef, useId } from 'vue'
import { MENU } from './contexts.js'
import { useControllableOpen } from './primitive.js'

const props = defineProps({
  open: { type: Boolean, default: undefined },
  defaultOpen: { type: Boolean, default: false },
  modal: { type: Boolean, default: true }
})
const emit = defineEmits(['update:open'])

const open = useControllableOpen(props, emit)

function close() {
  open.set(false)
}

provide(MENU, {
  open: open.value,
  setOpen: open.set,
  toggle: () => open.set(!open.value.value),
  close,
  modal: computed(() => props.modal),
  triggerEl: shallowRef(null),
  triggerId: useId(),
  contentId: useId()
})
</script>

<template>
  <slot :open="open.value.value" :close="close" />
</template>
