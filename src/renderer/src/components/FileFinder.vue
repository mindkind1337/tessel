<script setup>
// Jump to file (Ctrl+Shift+J): the workspace's project files, found by a
// few letters (fuzzy). Enter opens the file (VS Code when installed);
// Ctrl+Enter puts its path in the active pane, e.g. to point an agent at it.
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { fuzzyFilter } from '../../../shared/fuzzy'

const props = defineProps({
  root: { type: String, default: null }, // the workspace's project folder
  canInsert: { type: Boolean, default: false } // a pane is active
})
const emit = defineEmits(['close', 'open', 'insert'])

const query = ref('')
const index = ref(0)
const files = ref([])
const state = ref('loading') // 'loading' | 'ready' | 'error'
const error = ref('')
const truncated = ref(false)
const inputEl = ref(null)
const listEl = ref(null)

const results = computed(() => fuzzyFilter(query.value, files.value, 60))
watch(query, () => (index.value = 0))

onMounted(async () => {
  await nextTick()
  if (inputEl.value) inputEl.value.focus()
  if (!props.root) {
    state.value = 'error'
    error.value = 'This workspace has no project folder.'
    return
  }
  const res = await window.shellApi.listFiles(props.root).catch((e) => ({ ok: false, error: e.message }))
  if (!res || !res.ok) {
    state.value = 'error'
    error.value = (res && res.error) || 'Could not list the files.'
    return
  }
  files.value = res.files
  truncated.value = !!res.truncated
  state.value = 'ready'
})

function move(d) {
  const n = results.value.length
  if (!n) return
  index.value = (index.value + d + n) % n
  nextTick(() => {
    const el = listEl.value && listEl.value.children[index.value]
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  })
}
function choose(i, insert) {
  const rel = results.value[i]
  if (!rel) return
  const full = `${props.root.replace(/[\\/]+$/, '')}\\${rel.split('/').join('\\')}`
  emit(insert && props.canInsert ? 'insert' : 'open', { rel, full })
  emit('close')
}
function onKey(e) {
  if (e.key === 'ArrowDown') (e.preventDefault(), move(1))
  else if (e.key === 'ArrowUp') (e.preventDefault(), move(-1))
  else if (e.key === 'Enter') (e.preventDefault(), choose(index.value, e.ctrlKey))
  else if (e.key === 'Escape') (e.preventDefault(), emit('close'))
}
function nameOf(rel) {
  return rel.slice(rel.lastIndexOf('/') + 1)
}
function dirOf(rel) {
  const i = rel.lastIndexOf('/')
  return i > 0 ? rel.slice(0, i) : ''
}
</script>

<template>
  <div class="pal-backdrop" @pointerdown.self="emit('close')">
    <div class="pal file-finder" role="dialog" aria-label="Jump to file">
      <div class="pal-search">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 2h5l3 3v9H4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
          <path d="M9 2v3h3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
        </svg>
        <input
          ref="inputEl"
          v-model="query"
          class="pal-input"
          placeholder="Jump to a file: type a few letters of its name"
          spellcheck="false"
          data-test="finder-input"
          @keydown.stop="onKey"
        />
        <kbd class="pal-kbd">Esc</kbd>
      </div>
      <p v-if="state === 'loading'" class="finder-empty">Listing the project's files…</p>
      <p v-else-if="state === 'error'" class="finder-empty">{{ error }}</p>
      <p v-else-if="!results.length" class="finder-empty">No file matches.</p>
      <div v-else ref="listEl" class="pal-list">
        <button
          v-for="(rel, i) in results"
          :key="rel"
          class="pal-item finder-item"
          :class="{ active: i === index }"
          tabindex="-1"
          data-test="finder-item"
          @mouseenter="index = i"
          @click="choose(i, $event.ctrlKey)"
        >
          <span class="finder-name">{{ nameOf(rel) }}</span>
          <span class="finder-dir">{{ dirOf(rel) }}</span>
        </button>
      </div>
      <p class="finder-hint">
        Enter: open<template v-if="canInsert"> · Ctrl+Enter: put its path in the active pane</template
        ><template v-if="truncated"> · only the first 20,000 files</template>
      </p>
    </div>
  </div>
</template>
