<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
const props = defineProps({ guestId: { type: Number, default: null } })
const rows = ref([])
const expanded = ref(false)
let off
const api = () => window.shellApi?.browser
watch(() => props.guestId, async (id) => {
  rows.value = []
  if (id == null) return
  const result = await api()?.downloads?.(id)
  if (props.guestId === id) rows.value = result || []
}, { immediate: true })
onMounted(() => {
  off = api()?.onDownloadChanged?.((row) => {
    if (row.webContentsId !== props.guestId) return
    const i = rows.value.findIndex((r) => r.id === row.id)
    if (i < 0) { rows.value.unshift(row); expanded.value = true }
    else rows.value[i] = row
    rows.value = rows.value.slice(0, 100)
  })
})
onBeforeUnmount(() => off?.())
const active = (r) => !['completed', 'cancelled'].includes(r.state) && r.error !== 'transfer-failed'
const labels = {
  choosing: ['browser.download.choosing', 'Choose where to save'],
  progressing: ['browser.download.progressing', 'Downloading'],
  completed: ['browser.download.completed', 'Saved'],
  cancelled: ['browser.download.cancelled', 'Cancelled'],
  interrupted: ['browser.download.interrupted', 'Download interrupted']
}
const label = (r) => t(...(labels[r.state] || labels.interrupted))
</script>

<template>
  <section v-if="rows.length" class="browser-downloads" aria-live="polite">
    <button type="button" :aria-expanded="expanded" @click="expanded = !expanded">{{ t('browser.download.title', 'Downloads') }} ({{ rows.length }})</button>
    <div v-if="expanded" class="download-list">
      <div v-for="row in rows" :key="row.id" class="download-row">
        <strong>{{ row.name }}</strong> — {{ label(row) }}
        <progress v-if="active(row)" :value="row.totalBytes > 0 ? row.receivedBytes : undefined" :max="row.totalBytes || 1" />
        <small>{{ row.receivedBytes.toLocaleString() }} / {{ row.totalBytes > 0 ? row.totalBytes.toLocaleString() : '?' }} B</small>
        <span v-if="row.path" class="download-path">{{ row.path }}</span>
        <button v-if="active(row)" type="button" @click="api()?.cancelDownload(props.guestId, row.id)">{{ t('browser.download.cancel', 'Cancel') }}</button>
        <button v-if="row.path" type="button" @click="api()?.revealDownload(props.guestId, row.id)">{{ t('browser.download.reveal', 'Show in folder') }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.browser-downloads { flex: 0 0 auto; padding: 6px 10px; background: var(--bg-secondary, #202329); border-bottom: 1px solid var(--border, #444); font-size: 12px; }
.download-list { max-height: 180px; overflow: auto; }
.download-row { padding: 6px 0; overflow-wrap: anywhere; }
.download-row small, .download-row button, progress { margin-left: 8px; }
.download-path { display: block; user-select: text; }
button { color: inherit; background: transparent; border: 1px solid var(--border, #666); border-radius: 4px; cursor: pointer; padding: 3px 7px; }
</style>
