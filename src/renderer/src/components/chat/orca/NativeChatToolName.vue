<script setup>
// After Orca's NativeChatToolAnnotations.tsx, NativeChatToolName (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * A tool's name on its row: an MCP tool reads "Server / tool" (the raw name
 * stays in the title), anything else is the name itself.
 * Props: name, mcpIdentity ({ server, tool }).
 */
import { computed } from 'vue'
import { mcpToolIdentity } from '../../../chat/orca/shared/native-chat-tool-identity.js'

const props = defineProps({
  name: { type: String, required: true },
  mcpIdentity: { type: Object, default: undefined }
})

const identity = computed(() => mcpToolIdentity(props.name, props.mcpIdentity))
</script>

<template>
  <span v-if="identity" :title="name" class="nc-tool-name">
    <span class="nc-tool-name__part">{{ identity.server }}</span>
    <span class="nc-tool-name__slash">/</span>
    <span class="nc-tool-name__part nc-tool-name__tool">{{ identity.tool }}</span>
  </span>
  <template v-else>{{ name }}</template>
</template>

<style scoped>
/* inline-flex min-w-0 items-center gap-1.5 */
.nc-tool-name {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}
.nc-tool-name__part {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-tool-name__slash {
  font-weight: 400;
  color: var(--nc-muted-foreground);
}
.nc-tool-name__tool {
  font-weight: 400;
}
</style>
