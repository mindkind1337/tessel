<script setup>
// After Orca's NativeChatToolIcon.tsx, NativeChatToolRunIcon (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * The glyph over a settled run, which speaks for every call in it rather than
 * for one row, so its caller resolves the category and no row word names it.
 * Same table and same slot as a row's glyph (NativeChatToolIcon).
 * Props: iconName (a NATIVE_CHAT_TOOL_ICON_NAMES value, e.g. 'wrench').
 */
import { computed } from 'vue'
import { NATIVE_CHAT_TOOL_GLYPHS } from './native-chat-tool-glyphs.js'

const props = defineProps({
  iconName: { type: String, required: true }
})

const glyph = computed(() => NATIVE_CHAT_TOOL_GLYPHS[props.iconName] ?? NATIVE_CHAT_TOOL_GLYPHS.wrench)
</script>

<template>
  <span class="nc-tool-glyph-slot">
    <component :is="glyph" aria-hidden="true" class="nc-tool-glyph" />
  </span>
</template>

<style scoped>
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
