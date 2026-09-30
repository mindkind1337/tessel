<script setup>
/**
 * A file an earlier-history message carried (a PDF, a text file…), as a chip:
 * an icon by its type, its name and size. A file that was still a plain local
 * file when the history was read opens with the system on a click (files:open
 * checks again that it is an existing regular file); one held inline in the
 * transcript is only shown (nothing is written).
 * Props: block (file-ref: { name, mediaType?, size?, path? }).
 */
import { computed, ref } from 'vue'
import { File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { fileSizeLabel } from '../../../chat/orca/native-chat-images.js'

const props = defineProps({ block: { type: Object, required: true } })

const failed = ref('')

const icon = computed(() => {
  const type = String(props.block.mediaType || '').toLowerCase()
  const ext = (String(props.block.name || '').match(/\.([a-z0-9]{1,8})$/i)?.[1] || '').toLowerCase()
  if (type.startsWith('image/')) return FileImage
  if (/zip|tar|gzip|compressed|x-7z|rar/.test(type) || ['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return FileArchive
  if (/spreadsheet|excel|csv/.test(type) || ['csv', 'xls', 'xlsx', 'ods'].includes(ext)) return FileSpreadsheet
  if (/json|javascript|typescript|x-python|x-sh|xml|html|css/.test(type) || ['js', 'ts', 'json', 'py', 'sh', 'html', 'css', 'vue', 'xml'].includes(ext)) return FileCode
  if (type === 'application/pdf' || type.startsWith('text/') || /word|document|rtf/.test(type) || ['pdf', 'txt', 'md', 'doc', 'docx', 'rtf'].includes(ext)) return FileText
  return File
})
const size = computed(() => fileSizeLabel(props.block.size))
const canOpen = computed(() => typeof props.block.path === 'string' && props.block.path.length > 0 && !!window.shellApi?.openFile)
const title = computed(() => {
  const parts = [props.block.name, size.value].filter(Boolean).join(' · ')
  return failed.value ? `${parts}\n${failed.value}` : parts
})

async function open() {
  if (!canOpen.value) return
  failed.value = ''
  const res = await window.shellApi.openFile({ file: props.block.path }).catch(() => null)
  if (!res || res.ok !== true) failed.value = (res && res.error) || t('chat.orca.file.openFailed', 'The file could not be opened.')
}
</script>

<template>
  <button
    v-if="canOpen"
    type="button"
    class="nc-file-chip is-openable"
    :class="{ 'is-failed': failed }"
    :title="title"
    :aria-label="`${t('chat.orca.file.open', 'Open file')}: ${block.name}`"
    data-test="nc-file-chip"
    @click="open"
  >
    <component :is="icon" class="nc-file-chip-icon" aria-hidden="true" />
    <span class="nc-file-chip-name">{{ block.name }}</span>
    <span v-if="size" class="nc-file-chip-size">{{ size }}</span>
  </button>
  <div v-else class="nc-file-chip" :title="title" data-test="nc-file-chip">
    <component :is="icon" class="nc-file-chip-icon" aria-hidden="true" />
    <span class="nc-file-chip-name">{{ block.name }}</span>
    <span v-if="size" class="nc-file-chip-size">{{ size }}</span>
  </div>
</template>

<style scoped>
.nc-file-chip {
  display: flex;
  max-width: 100%;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
  border: 1px solid var(--nc-border);
  background: var(--nc-background);
  padding: 4px 8px;
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
  text-align: left;
}
.nc-file-chip.is-openable {
  cursor: pointer;
  transition-property: color, border-color;
  transition-duration: 150ms;
}
.nc-file-chip.is-openable:hover {
  border-color: var(--nc-ring);
  color: var(--nc-foreground);
}
.nc-file-chip.is-openable:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-file-chip.is-failed {
  border-color: var(--nc-destructive, var(--nc-border));
}
.nc-file-chip-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.nc-file-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-file-chip-size {
  flex-shrink: 0;
  opacity: 0.8;
}
</style>
