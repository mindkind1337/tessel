<script setup>
// What a panel that needs the project's files (Files, Changes) shows for a
// project on a remote host: Tessel reaches that host only through its
// terminals for now.
import { Server } from 'lucide-vue-next'
import { t } from '../../i18n'

defineProps({
  host: { type: String, default: '' },
  path: { type: String, default: '' }
})
</script>

<template>
  <div class="ru" data-test="remote-unavailable">
    <Server :size="22" class="ru-icon" aria-hidden="true" />
    <p class="ru-title">{{ t('project.remote.unavailable', 'Not available for a remote project yet') }}</p>
    <p class="ru-sub">
      {{ t('project.remote.unavailableHint', 'Use the terminals of this project: they run on the host, in its folder.') }}
    </p>
    <p v-if="host || path" class="ru-where">{{ host }}<template v-if="host && path">:</template>{{ path }}</p>
  </div>
</template>

<style scoped>
.ru {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 100%;
  min-height: 160px;
  padding: 24px 18px;
  box-sizing: border-box;
  color: var(--text-dim);
  text-align: center;
}
.ru-icon {
  opacity: 0.7;
}
.ru-title {
  margin: 4px 0 0;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}
.ru-sub {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
.ru-where {
  margin: 4px 0 0;
  max-width: 100%;
  overflow: hidden;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
