<script setup>
// Source control (after Orca's Changes tab): the project's changed files from
// git status, kept current as files change; click one to open it. Task
// copies of this workspace (an agent's worktree) open in the review.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { tasks } from '../taskBoardStore'

const props = defineProps({
  root: { type: String, default: null },
  // Only this workspace's task copies (null: every one).
  workspaceId: { type: String, default: null }
})
const emit = defineEmits(['open', 'review'])

const LETTER_TITLE = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Untracked' }
const api = () => window.shellApi && window.shellApi.explorer
const files = ref([]) // [{ path, rel, name, dir, letter }]
const repo = ref(true)
const loading = ref(false)
const loaded = ref(false)
const selected = ref(null)

const rootKey = () => String(props.root || '').replace(/[\\/]+$/, '').toLowerCase()

let seq = 0
async function load() {
  if (!props.root || !api()) {
    files.value = []
    return
  }
  const my = ++seq
  loading.value = true
  const res = await api().status({ root: props.root }).catch(() => null)
  if (my !== seq) return
  loading.value = false
  loaded.value = true
  if (!res || !res.ok) return
  repo.value = !!res.repo
  const r = props.root.replace(/[\\/]+$/, '')
  const out = []
  for (const [p, letter] of Object.entries(res.files || {})) {
    if (letter === '!') continue
    // Only what is in this project's folder (its repository may be bigger).
    if (!p.toLowerCase().startsWith(rootKey() + '\\')) continue
    const rel = p.slice(r.length + 1)
    const i = rel.search(/[\\/][^\\/]*$/)
    out.push({ path: p, rel, name: i >= 0 ? rel.slice(i + 1) : rel, dir: i >= 0 ? rel.slice(0, i) : '', letter })
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true, sensitivity: 'base' }))
  files.value = out
}

// Agents' copies of the project with work to look at.
const copies = computed(() =>
  tasks.filter(
    (t) => t.worktree && (!props.workspaceId || t.wsId === props.workspaceId) && (t.column === 'review' || t.column === 'doing')
  )
)

function openFile(f) {
  selected.value = f.path
  if (f.letter === 'D') return
  emit('open', f.path)
}

let stop = null
let timer = 0
watch(() => props.root, () => {
  files.value = []
  loaded.value = false
  if (props.root && api()) api().watch(props.root)
  load()
})
onMounted(() => {
  if (props.root && api()) api().watch(props.root)
  load()
  if (api() && api().onChanged)
    stop = api().onChanged((r) => {
      if (!props.root || String(r).toLowerCase() !== props.root.toLowerCase()) return
      clearTimeout(timer)
      timer = setTimeout(load, 250)
    })
})
onBeforeUnmount(() => {
  if (stop) stop()
  clearTimeout(timer)
  // The side panel closes (the file explorer, when shown, closes with it).
  if (api()) api().unwatch()
})
defineExpose({ load })
</script>

<template>
  <div class="changes" aria-label="Changes" data-test="changes-panel">
    <div class="explorer-head">
      <span class="explorer-title">Source control</span>
      <span class="explorer-actions">
        <button class="tb-icon" title="Refresh" aria-label="Refresh" data-test="changes-refresh" :disabled="!root" @click="load">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      </span>
    </div>
    <div v-if="!root" class="explorer-empty">This workspace has no project folder. Choose one from the workspace menu (Project folder…) to see its changes here.</div>
    <div v-else class="explorer-tree">
      <template v-if="copies.length">
        <div class="changes-group">Task copies</div>
        <div v-for="t in copies" :key="t.id" class="changes-copy" data-test="changes-copy">
          <span class="changes-copy-title" :title="t.worktree.branch || ''">{{ t.title }}</span>
          <button class="exit-btn" data-test="review-changes" @click="emit('review', t.id)">Review changes</button>
        </div>
      </template>
      <div v-if="loaded && !repo" class="explorer-empty">This folder is not in a git repository.</div>
      <template v-else>
        <div class="changes-group">
          Changes <span class="changes-count" data-test="changes-count">{{ files.length }}</span>
        </div>
        <div v-if="loaded && !files.length" class="explorer-empty">No changes. Everything is committed.</div>
        <div
          v-for="f in files"
          :key="f.path"
          class="explorer-row changes-row"
          :class="{ selected: selected === f.path, ['git-' + f.letter]: true, gone: f.letter === 'D' }"
          :title="f.rel + ' (' + (LETTER_TITLE[f.letter] || f.letter) + ')' + (f.letter === 'D' ? ' — deleted, nothing to open' : '')"
          :data-path="f.path"
          data-test="changes-row"
          @click="openFile(f)"
        >
          <svg class="explorer-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></svg>
          <span class="explorer-name">{{ f.name }}</span>
          <span class="explorer-hit-dir">{{ f.dir }}</span>
          <span class="explorer-git">{{ f.letter }}</span>
        </div>
        <div v-if="loading && !loaded" class="explorer-empty">Reading git status…</div>
      </template>
    </div>
  </div>
</template>
