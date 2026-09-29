<script setup>
// After Orca's NativeChatEmptyState.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// The chat's loading / empty / error / not-an-agent state: an icon, a title
// and a line under it, centred.
// Props: kind ('loading' | 'empty' | 'error' | 'not-agent'), message (the
//   error's own text, shown instead of the generic line), agent ('claude',
//   'codex'…: named in the empty state).
import { computed } from 'vue'
import { MessageSquare, TriangleAlert } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { NATIVE_CHAT_EMPTY_STATE_COPY } from '../../../chat/orca/shared/native-chat-empty-state.js'

const props = defineProps({
  kind: { type: String, required: true },
  message: { type: String, default: undefined },
  agent: { type: String, default: undefined }
})

// The agent's product name (the reference's formatAgentTypeLabel for Tessel's agents).
// Product names, the same in every language.
const AGENT_LABELS = { claude: 'Claude', codex: 'Codex' } // i18n-ignore
function agentLabel(agent) {
  if (!agent) return t('chat.orca.state.theAgent', 'the agent')
  return AGENT_LABELS[agent] || agent.charAt(0).toUpperCase() + agent.slice(1)
}

const copy = computed(() => {
  const C = NATIVE_CHAT_EMPTY_STATE_COPY
  switch (props.kind) {
    case 'loading':
      return { title: t('chat.orca.state.loading.title', C.loading.title), subtitle: t('chat.orca.state.loading.subtitle', C.loading.subtitle) }
    case 'error':
      return { title: t('chat.orca.state.error.title', C.error.title), subtitle: props.message ?? t('chat.orca.state.error.subtitle', C.error.subtitle) }
    case 'not-agent':
      return { title: t('chat.orca.state.notAgent.title', C.notAgent.title), subtitle: t('chat.orca.state.notAgent.subtitle', C.notAgent.subtitle) }
    default: {
      const value0 = agentLabel(props.agent)
      return {
        title: t('chat.orca.state.empty.title', C.empty.title, { value0 }),
        subtitle: t('chat.orca.state.empty.subtitle', C.empty.subtitle, { value0 })
      }
    }
  }
})
</script>

<template>
  <div class="nc-empty" :data-native-chat-empty-state="kind">
    <div class="nc-empty-badge" :class="{ 'nc-empty-badge--error': kind === 'error' }">
      <TriangleAlert v-if="kind === 'error'" class="nc-empty-icon" aria-hidden="true" />
      <MessageSquare v-else class="nc-empty-icon" aria-hidden="true" />
    </div>
    <p class="nc-empty-title">{{ copy.title }}</p>
    <p v-if="copy.subtitle" class="nc-empty-subtitle">{{ copy.subtitle }}</p>
  </div>
</template>

<style scoped>
/* flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center */
.nc-empty {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: 100%;
  height: 100%;
  padding: 24px;
  text-align: center;
}
/* flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground */
.nc-empty-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 9999px;
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
/* bg-destructive/10 text-destructive */
.nc-empty-badge--error {
  background: color-mix(in srgb, var(--nc-destructive) 10%, transparent);
  color: var(--nc-destructive);
}
.nc-empty-icon {
  width: 24px;
  height: 24px;
}
/* text-sm font-medium text-foreground */
.nc-empty-title {
  margin: 0;
  color: var(--nc-foreground);
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
}
/* max-w-sm text-balance text-xs text-muted-foreground */
.nc-empty-subtitle {
  max-width: 24rem;
  margin: 0;
  color: var(--nc-muted-foreground);
  font-size: 12px;
  line-height: 16px;
  text-wrap: balance;
}
</style>
