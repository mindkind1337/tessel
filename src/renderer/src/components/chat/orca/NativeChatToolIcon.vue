<script setup>
// After Orca's NativeChatToolIcon.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * The category glyph on a tool row. Decorative — the word beside it is the
 * accessible name — so it is aria-hidden and must never render without that
 * word. A fixed 16px slot with a 14px glyph keeps every row left-aligned,
 * including rows whose category this vocabulary doesn't model.
 * Props: rowWord (the word the row renders, its whole identity), mcpIdentity.
 * The class (e.g. a tone) goes on the slot.
 */
import { computed } from 'vue'
import { nativeChatToolIconName } from '../../../chat/orca/shared/native-chat-tool-icon.js'
import { NATIVE_CHAT_TOOL_GLYPHS } from './native-chat-tool-glyphs.js'

const props = defineProps({
  rowWord: { type: String, required: true },
  mcpIdentity: { type: Object, default: undefined }
})

const glyph = computed(() => NATIVE_CHAT_TOOL_GLYPHS[nativeChatToolIconName(props.rowWord, props.mcpIdentity)])
</script>

<template>
  <span class="nc-tool-glyph-slot">
    <component :is="glyph" aria-hidden="true" class="nc-tool-glyph" />
  </span>
</template>

<style scoped>
/* flex size-4 shrink-0 items-center justify-center; glyph size-3.5 */
.nc-tool-glyph-slot {
  display: flex;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
}
.nc-tool-glyph {
  width: 14px;
  height: 14px;
}
</style>
