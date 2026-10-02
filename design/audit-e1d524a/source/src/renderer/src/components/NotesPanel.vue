<script setup>
// The project notes, inside Tessel: read them formatted, or edit and save.
// Agents write in the same file, so the view follows their changes, and a
// save never overwrites a change you have not seen.
import { ref, computed, onMounted, onBeforeUnmount, inject, nextTick } from 'vue'
import { parseMarkdown } from '../../../shared/markdown'

const props = defineProps({
  dir: { type: String, required: true },
  wsName: { type: String, default: '' },
  // Text of a new notes file, if there is none yet.
  template: { type: String, default: '' }
})
const emit = defineEmits(['close', 'open-external'])
const askConfirm = inject('askConfirm', (o) => Promise.resolve(window.confirm(o.title)))

const path = ref('')
const text = ref('') // what the file holds (as last read or saved)
const mtime = ref(null)
const draft = ref('')
const editing = ref(false)
const status = ref('') // "Saved", errors
const theirs = ref(null) // { text, mtime } when the file changed under your edits
const loading = ref(true)
const editorEl = ref(null)
const cardEl = ref(null)
let poll = null

const dirty = computed(() => editing.value && draft.value !== text.value)
const blocks = computed(() => parseMarkdown(text.value))

async function load(initial = false) {
  if (!window.shellApi.loadNotes) return
  const res = await window.shellApi.loadNotes({ dir: props.dir, content: props.template })
  loading.value = false
  if (!res || !res.ok) {
    status.value = `Could not read the notes: ${(res && res.error) || 'unknown error'}`
    return
  }
  path.value = res.path
  if (initial || mtime.value === null) {
    text.value = res.text
    mtime.value = res.mtime
    return
  }
  if (res.mtime === mtime.value) return
  // Changed on disk (an agent wrote in it).
  if (dirty.value) {
    theirs.value = { text: res.text, mtime: res.mtime }
  } else {
    text.value = res.text
    mtime.value = res.mtime
    if (editing.value) draft.value = res.text
  }
}

function startEdit() {
  draft.value = text.value
  editing.value = true
  status.value = ''
  nextTick(() => editorEl.value && editorEl.value.focus())
}

async function save(force = false) {
  if (!editing.value) return
  const res = await window.shellApi.saveNotes({
    dir: props.dir,
    text: draft.value,
    baseMtime: force && theirs.value ? theirs.value.mtime : mtime.value
  })
  if (res && res.ok) {
    text.value = draft.value
    mtime.value = res.mtime
    theirs.value = null
    status.value = 'Saved'
    setTimeout(() => status.value === 'Saved' && (status.value = ''), 2000)
  } else if (res && res.conflict) {
    theirs.value = { text: res.text, mtime: res.mtime }
  } else {
    status.value = `Could not save: ${(res && res.error) || 'unknown error'}`
  }
}

// The file changed while you were editing: take their version, or keep yours.
function useTheirs() {
  text.value = theirs.value.text
  mtime.value = theirs.value.mtime
  draft.value = theirs.value.text
  theirs.value = null
}

async function done() {
  if (dirty.value) {
    const ok = await askConfirm({
      title: 'Discard your changes?',
      text: 'Your edits to the notes are not saved.',
      confirmLabel: 'Discard',
      danger: true
    })
    if (!ok) return
  }
  editing.value = false
  theirs.value = null
}

async function close() {
  if (dirty.value) {
    const ok = await askConfirm({
      title: 'Close without saving?',
      text: 'Your edits to the notes are not saved.',
      confirmLabel: 'Close',
      danger: true
    })
    if (!ok) return
  }
  emit('close')
}

function onKey(e) {
  if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.confirm-card')) {
    e.preventDefault()
    if (editing.value) done()
    else close()
  }
}

function onEditorKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    save()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  if (cardEl.value) cardEl.value.focus()
  await load(true)
  poll = setInterval(load, 2500)
})
onBeforeUnmount(() => {
  clearInterval(poll)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="close">
    <div ref="cardEl" class="help-card notes-card" role="dialog" aria-labelledby="notes-title" tabindex="-1">
      <div class="help-head">
        <span class="notes-heading">
          <span id="notes-title">Project notes</span>
          <span class="notes-where">{{ wsName }}<template v-if="path"> · {{ path }}</template></span>
        </span>
        <span class="notes-tools">
          <span v-if="status" class="notes-status" role="status">{{ status }}</span>
          <template v-if="editing">
            <button class="confirm-btn" @click="done">{{ dirty ? 'Cancel' : 'Done' }}</button>
            <button class="confirm-btn primary" :disabled="!dirty" title="Save (Ctrl+S)" @click="save()">
              Save
            </button>
          </template>
          <template v-else>
            <button class="confirm-btn" title="Open the file in your text editor" @click="emit('open-external')">
              Open in editor
            </button>
            <button class="confirm-btn primary" :disabled="loading" @click="startEdit">Edit</button>
          </template>
          <button class="tb-icon" title="Close (Esc)" aria-label="Close" @click="close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </span>
      </div>

      <div v-if="theirs" class="notes-conflict" role="alert">
        <span>The notes changed while you were editing (an agent wrote in them).</span>
        <button class="confirm-btn" @click="useTheirs">Load their version</button>
        <button class="confirm-btn danger" @click="save(true)">Keep mine</button>
      </div>

      <textarea
        v-if="editing"
        ref="editorEl"
        v-model="draft"
        class="notes-editor"
        spellcheck="false"
        aria-label="Project notes (Markdown)"
        @keydown="onEditorKey"
      ></textarea>

      <div v-else class="notes-view">
        <p v-if="loading" class="act-none">Loading…</p>
        <template v-for="(b, i) in blocks" :key="i">
          <h3 v-if="b.type === 'h1'" class="notes-h1">
            <template v-for="(p, j) in b.parts" :key="j"><code v-if="p.kind === 'code'">{{ p.text }}</code><strong v-else-if="p.kind === 'bold'">{{ p.text }}</strong><em v-else-if="p.kind === 'italic'">{{ p.text }}</em><template v-else>{{ p.text }}</template></template>
          </h3>
          <h4 v-else-if="b.type === 'h2' || b.type === 'h3'" class="notes-h2">
            <template v-for="(p, j) in b.parts" :key="j"><code v-if="p.kind === 'code'">{{ p.text }}</code><strong v-else-if="p.kind === 'bold'">{{ p.text }}</strong><em v-else-if="p.kind === 'italic'">{{ p.text }}</em><template v-else>{{ p.text }}</template></template>
          </h4>
          <ul v-else-if="b.type === 'ul'" class="notes-list">
            <li v-for="(item, k) in b.items" :key="k">
              <template v-for="(p, j) in item" :key="j"><code v-if="p.kind === 'code'">{{ p.text }}</code><strong v-else-if="p.kind === 'bold'">{{ p.text }}</strong><em v-else-if="p.kind === 'italic'">{{ p.text }}</em><template v-else>{{ p.text }}</template></template>
            </li>
          </ul>
          <pre v-else-if="b.type === 'code'" class="notes-code">{{ b.text }}</pre>
          <hr v-else-if="b.type === 'hr'" class="notes-hr" />
          <p v-else :class="b.type === 'quote' ? 'notes-quote' : 'notes-p'">
            <template v-for="(p, j) in b.parts" :key="j"><code v-if="p.kind === 'code'">{{ p.text }}</code><strong v-else-if="p.kind === 'bold'">{{ p.text }}</strong><em v-else-if="p.kind === 'italic'">{{ p.text }}</em><template v-else>{{ p.text }}</template></template>
          </p>
        </template>
      </div>
    </div>
  </div>
</template>
