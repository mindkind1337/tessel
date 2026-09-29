<script>
// Formatters per interface locale (shared by every timestamp).
let cached = null

function getTimestampFormatters(locale) {
  if (!cached || cached.locale !== locale) {
    cached = {
      locale,
      time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }),
      full: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long' })
    }
  }
  return cached
}
</script>

<script setup>
// After Orca's NativeChatMessageTimestamp.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * A message's time: the short time shown, the full date and time as its
 * accessible name, the ISO instant as datetime. Renders nothing for a missing
 * or invalid timestamp. Follows the interface language (intlLocale() is
 * reactive), without a parent re-render.
 * Props: timestamp (ms or null), focusable (tabindex 0, for user metadata).
 * Class goes to the <time>.
 */
import { computed } from 'vue'
import { intlLocale } from '../../../i18n'

const props = defineProps({
  timestamp: { type: Number, default: null },
  focusable: { type: Boolean, default: false }
})

const view = computed(() => {
  if (props.timestamp === null || props.timestamp === undefined) return null
  const date = new Date(props.timestamp)
  if (Number.isNaN(date.getTime())) return null
  const formatters = getTimestampFormatters(intlLocale())
  return {
    iso: date.toISOString(),
    full: formatters.full.format(date),
    short: formatters.time.format(date)
  }
})
</script>

<template>
  <time
    v-if="view"
    class="nc-timestamp"
    :datetime="view.iso"
    :aria-label="view.full"
    :tabindex="focusable ? 0 : undefined"
    >{{ view.short }}</time
  >
</template>

<style scoped>
.nc-timestamp {
  border-radius: 6px;
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
  color: var(--nc-muted-foreground);
  font-variant-numeric: tabular-nums;
}
.nc-timestamp:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
</style>
