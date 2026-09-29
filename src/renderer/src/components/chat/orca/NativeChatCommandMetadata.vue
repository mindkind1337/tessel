<script setup>
// After Orca's NativeChatToolAnnotations.tsx, NativeChatCommandMetadata (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * A command's exit code and duration beside its row ("exit 127  400ms"), each
 * only when the provider reported it. A non-zero exit is tinted.
 * Props: block (the tool-call block).
 */
import { computed } from 'vue'
import { t } from '../../../i18n'
import { formatToolDuration } from '../../../chat/orca/shared/native-chat-tool-identity.js'

const props = defineProps({
  block: { type: Object, required: true }
})

const duration = computed(() =>
  formatToolDuration(props.block.durationMs, (value0) => t('chat.orca.tool.milliseconds', '{{value0}}ms', { value0 }))
)
const exitCode = computed(() => (Number.isSafeInteger(props.block.exitCode) ? props.block.exitCode : undefined))
const exitText = computed(() => t('chat.orca.tool.exitCode', 'exit {{value0}}', { value0: exitCode.value }))
</script>

<template>
  <span v-if="exitCode !== undefined || duration !== null" class="nc-command-metadata">
    <span v-if="exitCode !== undefined" :class="{ 'nc-command-metadata--failed': exitCode !== 0 }">{{ exitText }}</span>
    <span v-if="duration">{{ duration }}</span>
  </span>
</template>

<style scoped>
/* flex shrink-0 gap-1.5 font-mono text-[11px] text-muted-foreground */
.nc-command-metadata {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
.nc-command-metadata--failed {
  color: var(--nc-destructive);
}
</style>
