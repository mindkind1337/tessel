<script setup>
// An Excel workbook (.xlsx / .xlsm) in an editor tab, read-only: its sheets
// as tabs, each a table with the column letters and the row numbers
// (sheet/xlsx.js reads it; formatting, charts and pictures are not shown).
import { ref, computed, watch, onMounted } from 'vue'
import { readWorkbook, colName, MAX_ROWS } from '../sheet/xlsx'
import { t } from '../i18n'

const props = defineProps({
  file: { type: String, required: true }
})

const sheets = ref([])
const current = ref(0)
const error = ref('')
const loading = ref(true)

const sheet = computed(() => sheets.value[current.value] || null)
const letters = computed(() => (sheet.value ? Array.from({ length: sheet.value.cols }, (_, i) => colName(i)) : []))

function bytesOf(dataUrl) {
  const b64 = String(dataUrl || '').replace(/^data:[^,]*,/, '')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

let seq = 0
async function load() {
  const my = ++seq
  loading.value = true
  error.value = ''
  sheets.value = []
  current.value = 0
  try {
    const r = window.shellApi && window.shellApi.viewImage ? await window.shellApi.viewImage(props.file) : null
    if (my !== seq) return
    if (!r || !r.ok || !r.dataUrl) {
      error.value = (r && r.error) || t('editor.sheet.unreadable', 'This workbook could not be read.')
      return
    }
    const wb = await readWorkbook(bytesOf(r.dataUrl))
    if (my !== seq) return
    sheets.value = wb.sheets
  } catch {
    if (my === seq) error.value = t('editor.sheet.unreadable', 'This workbook could not be read.')
  } finally {
    if (my === seq) loading.value = false
  }
}
watch(() => props.file, load)
onMounted(load)
</script>

<template>
  <div class="sheet-view" data-test="sheet-view">
    <div v-if="error" class="fview-note error">{{ error }}</div>
    <div v-else-if="loading" class="fview-note">{{ t('editor.viewer.reading', 'Reading…') }}</div>
    <template v-else>
      <div v-if="!sheets.length" class="fview-note">{{ t('editor.sheet.empty', 'This workbook has no sheet.') }}</div>
      <template v-else>
        <div class="sheet-table-wrap">
          <table v-if="sheet && sheet.rows.length" class="fview-table sheet-table">
            <thead>
              <tr>
                <th class="fview-rownum"></th>
                <th v-for="l in letters" :key="l">{{ l }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in sheet.rows" :key="i">
                <td class="fview-rownum">{{ i + 1 }}</td>
                <td v-for="(l, j) in letters" :key="j">{{ r[j] || '' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="fview-note">{{ t('editor.sheet.emptySheet', 'This sheet is empty.') }}</div>
          <div
            v-if="sheet && sheet.more"
            class="fview-note"
            v-text="t('editor.sheet.moreRows', 'Only the first {{max}} rows are shown ({{count}} more).', { max: MAX_ROWS, count: sheet.more })"
          ></div>
        </div>
        <div class="sheet-tabs" role="tablist" data-test="sheet-tabs">
          <button
            v-for="(s, i) in sheets"
            :key="i"
            class="sheet-tab"
            :class="{ active: i === current }"
            role="tab"
            :aria-selected="i === current"
            :title="s.name"
            @click="current = i"
          >
            {{ s.name }}
          </button>
          <span class="sheet-readonly">{{ t('editor.sheet.readOnly', 'Read-only') }}</span>
        </div>
      </template>
    </template>
  </div>
</template>
