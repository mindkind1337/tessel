<script setup>
// After Orca's NativeChatSkillPill.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// The prompt editor's node view for a skill the picker inserted: a pill with
// the skill's readable name; the document keeps the exact token ($review).
import { computed } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { Package } from 'lucide-vue-next'
import Badge from './ui/Badge.vue'

const props = defineProps(nodeViewProps)

function skillLabel(token) {
  return token
    .replace(/^[$/]/, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

const token = computed(() => String(props.node.attrs.token))
</script>

<template>
  <NodeViewWrapper as="span" class="nc-skill-pill-wrapper" contenteditable="false">
    <Badge
      variant="secondary"
      :data-native-chat-skill="token"
      :class="['nc-skill-pill', { 'nc-skill-pill--selected': selected }]"
    >
      <Package aria-hidden="true" />
      {{ skillLabel(token) }}
    </Badge>
  </NodeViewWrapper>
</template>

<style scoped>
.nc-skill-pill-wrapper {
  display: inline;
}
/* border-border px-1.5 py-0 text-muted-foreground align-baseline (+ ring-1 ring-ring when selected) */
.nc-skill-pill {
  border-color: var(--nc-border);
  padding: 0 6px;
  color: var(--nc-muted-foreground);
  vertical-align: baseline;
}
.nc-skill-pill--selected {
  box-shadow: 0 0 0 1px var(--nc-ring);
}
</style>
