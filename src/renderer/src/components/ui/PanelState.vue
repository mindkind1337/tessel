<script setup>
// What a side panel tab shows while it has nothing to list yet: "Loading…"
// with a spinner and a few skeleton rows (a first read, or a read for the
// project just chosen), or what went wrong with Retry. "Nothing here" is
// each tab's own text, shown only once a read has answered.
import { LoaderCircle } from 'lucide-vue-next'
import { t } from '../../i18n'

defineProps({
  // 'loading' | 'error'
  kind: { type: String, default: 'loading' },
  // The loading line ("Loading…" when empty) or the error.
  text: { type: String, default: '' },
  // Skeleton rows under the loading line.
  rows: { type: Number, default: 3 },
  // Error: offer Retry.
  retry: { type: Boolean, default: true },
  // Error: a retry is running.
  busy: { type: Boolean, default: false }
})
const emit = defineEmits(['retry'])
</script>

<template>
  <div v-if="kind === 'error'" class="ps ps-error" role="alert" data-test="panel-error">
    <p class="ps-msg" data-test="panel-error-text">{{ text }}</p>
    <button v-if="retry" type="button" class="exit-btn ps-retry" :disabled="busy" data-test="panel-retry" @click="emit('retry')">
      <LoaderCircle v-if="busy" :size="12" class="ps-spin" aria-hidden="true" />
      {{ t('changes.compare.retry', 'Retry') }}
    </button>
  </div>
  <div v-else class="ps ps-loading" role="status" aria-busy="true" data-test="panel-loading">
    <div class="ps-line">
      <LoaderCircle :size="13" class="ps-spin" aria-hidden="true" />
      <span>{{ text || t('app.sessions.loading', 'Loading…') }}</span>
    </div>
    <div v-for="i in rows" :key="i" class="ps-skel-row" aria-hidden="true">
      <span class="ps-skel w80"></span>
      <span class="ps-skel w50"></span>
    </div>
  </div>
</template>

<style scoped>
.ps {
  padding: 12px;
  font-size: 11.5px;
}
.ps-line {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
}
.ps-skel-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}
.ps-skel {
  height: 10px;
  border-radius: 3px;
  background: var(--surface-3);
}
.ps-skel.w80 {
  width: 80%;
}
.ps-skel.w50 {
  width: 50%;
  opacity: 0.7;
}
.ps-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.ps-msg {
  margin: 0;
  color: var(--danger);
  overflow-wrap: anywhere;
}
.ps-retry {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ps-spin {
  animation: ps-spin 1s linear infinite;
}
@keyframes ps-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
