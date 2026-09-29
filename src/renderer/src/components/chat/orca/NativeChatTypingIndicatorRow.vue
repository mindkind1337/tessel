<script setup>
// After Orca's NativeChatTypingIndicatorRow.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/** Three bouncing dots: the legacy "agent is responding" row of a list without turn status. */
import { t } from '../../../i18n'
</script>

<template>
  <div
    class="nc-typing-indicator"
    :aria-label="t('chat.orca.status.responding', 'Agent is responding')"
    aria-live="polite"
  >
    <div class="nc-typing-indicator__dots">
      <span
        v-for="i in [0, 1, 2]"
        :key="i"
        class="nc-typing-indicator__dot nc-animate-bounce"
        :style="{ animationDelay: `${i * 160}ms` }"
      />
    </div>
  </div>
</template>

<style scoped>
.nc-typing-indicator {
  display: flex;
  align-items: center;
  justify-content: flex-start;
}
.nc-typing-indicator__dots {
  display: flex;
  height: 32px;
  align-items: center;
  gap: 6px;
  color: var(--nc-muted-foreground);
}
.nc-typing-indicator__dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--nc-muted-foreground) 70%, transparent);
}
.nc-animate-bounce {
  /* Tailwind's animate-bounce; the keyframes live in orca-tokens.css. */
  animation: nc-bounce 1s infinite;
}
@media (prefers-reduced-motion: reduce) {
  .nc-animate-bounce {
    animation: none;
  }
}
</style>
