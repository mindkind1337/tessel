<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { t } from '../i18n'
import { Download } from 'lucide-vue-next'
const props = defineProps({ guestId: { type: Number, default: null } })
const rows = ref([])
const expanded = ref(false)
const root = ref(null)
const closeOutside = (event) => { if (!root.value?.contains(event.target)) expanded.value = false }
let off
const api = () => window.shellApi?.browser
watch(() => props.guestId, async (id) => {
  rows.value = []
  expanded.value = false
  if (id == null) return
  const result = await api()?.downloads?.(id)
  if (props.guestId === id) rows.value = result || []
}, { immediate: true })
onMounted(() => {
  document.addEventListener('pointerdown', closeOutside)
  off = api()?.onDownloadChanged?.((row) => {
    if (row.webContentsId !== props.guestId) return
    const i = rows.value.findIndex((r) => r.id === row.id)
    if (i < 0) rows.value.unshift(row)
    else rows.value[i] = row
    rows.value = rows.value.slice(0, 100)
  })
})
onBeforeUnmount(() => { off?.(); document.removeEventListener('pointerdown', closeOutside) })
const active = (r) => ['choosing', 'progressing'].includes(r.state) || (r.state === 'interrupted' && r.error === 'transfer-interrupted')
const labels = {
  choosing: () => t('browser.download.choosing', 'Choose where to save'),
  progressing: () => t('browser.download.progressing', 'Downloading'),
  completed: () => t('browser.download.completed', 'Saved'),
  cancelled: () => t('browser.download.cancelled', 'Cancelled'),
  interrupted: () => t('browser.download.interrupted', 'Download interrupted')
}
const label = (r) => (labels[r.state] || labels.interrupted)()
</script>

<template>
  <section v-if="rows.length" ref="root" class="browser-downloads" @keydown.esc="expanded = false">
    <button type="button" class="download-toggle" :title="t('browser.download.title', 'Downloads')" :aria-label="t('browser.download.title', 'Downloads')" :aria-expanded="expanded" @click="expanded = !expanded"><Download :size="16" /><span>{{ rows.length }}</span></button>
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
.browser-downloads { position: relative; flex: 0 0 auto; font-size: 12px; }
.download-toggle { display: flex; align-items: center; gap: 3px; border: none; }
.download-toggle span { font-size: 10px; }
.download-list { position: absolute; z-index: 100; right: 0; top: calc(100% + 8px); width: min(440px, 80vw); max-height: 260px; overflow: auto; padding: 10px; border: 1px solid var(--border, #444); border-radius: 8px; background: var(--bg-secondary, #202329); box-shadow: 0 8px 24px #0006; }
.download-row { padding: 6px 0; overflow-wrap: anywhere; }
.download-row small, .download-row button, progress { margin-left: 8px; }
.download-path { display: block; user-select: text; }
button { color: inherit; background: transparent; border: 1px solid var(--border, #666); border-radius: 4px; cursor: pointer; padding: 3px 7px; }
</style>
