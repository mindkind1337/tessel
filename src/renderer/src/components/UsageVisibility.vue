<script setup>
import { settings } from '../settings'
import { t } from '../i18n'
defineProps({ providers: { type: Array, default: () => [] } })
const emit = defineEmits(['change'])
function toggle(id, show) {
  settings.hiddenUsageProviders = [
    ...new Set(
      show
        ? settings.hiddenUsageProviders.filter((p) => p !== id)
        : [...settings.hiddenUsageProviders, id]
    )
  ]
  emit('change', { id, show })
}
</script>
<template>
  <details v-if="providers.length" class="usage-visibility" data-test="usage-visibility">
    <summary>{{ t('settings.usageVisibility.showInUsage', 'Show in Usage') }}</summary>
    <label v-for="p in providers" :key="p.id"
      ><input
        type="checkbox"
        :checked="!settings.hiddenUsageProviders.includes(p.id)"
        :data-test="'usage-visible-' + p.id"
        @change="toggle(p.id, $event.target.checked)"
      />{{ p.name }}<small v-if="!p.report">{{ t('settings.usageVisibility.quotas', 'Quotas') }}</small></label
    >
  </details>
</template>
<style scoped>
.usage-visibility {
  font-size: 11px;
  padding: 8px 13px;
  color: var(--text-dim);
}
summary {
  cursor: pointer;
}
label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  color: var(--text);
}
small {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 10px;
}
input {
  accent-color: var(--accent);
}
</style>
