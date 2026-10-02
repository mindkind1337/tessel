<script setup>
// Command palette (Ctrl+Shift+P, or the search box in the middle of the
// toolbar): type to find any command, pane or workspace, Enter to run it.
// `commands` is a list of { id, group, title, hint?, shortcut?, run }.
import { ref, computed, onMounted, nextTick, watch } from 'vue'

const props = defineProps({
  commands: { type: Array, required: true }
})
const emit = defineEmits(['close'])

const query = ref('')
const index = ref(0)
const inputEl = ref(null)
const listEl = ref(null)

// Every word typed must appear in the title, group or hint. Titles that
// start with the query come first.
const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.commands
  const words = q.split(/\s+/)
  return props.commands
    .map((c) => {
      const title = c.title.toLowerCase()
      const hay = `${title} ${c.group.toLowerCase()} ${(c.hint || '').toLowerCase()}`
      if (!words.every((w) => hay.includes(w))) return null
      const score = title.startsWith(q) ? 0 : title.includes(q) ? 1 : 2
      return { c, score }
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score)
    .map((r) => r.c)
})

// Group headers only where the group changes.
const rows = computed(() =>
  results.value.map((c, i) => ({
    c,
    header: i === 0 || results.value[i - 1].group !== c.group ? c.group : null
  }))
)

watch(query, () => (index.value = 0))

function move(d) {
  const n = results.value.length
  if (!n) return
  index.value = (index.value + d + n) % n
  nextTick(() => {
    const el = listEl.value && listEl.value.querySelector('.pal-item.active')
    if (el) el.scrollIntoView({ block: 'nearest' })
  })
}

function run(c) {
  if (!c) return
  emit('close')
  c.run()
}

onMounted(() => inputEl.value && inputEl.value.focus())
</script>

<template>
  <div class="pal-backdrop" @pointerdown.self="emit('close')">
    <div class="pal" role="dialog" aria-label="Command palette">
      <div class="pal-search">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.4" />
          <path
            d="M10.4 10.4L14 14"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        <input
          ref="inputEl"
          v-model="query"
          class="pal-input"
          placeholder="Search panes, workspaces and commands"
          spellcheck="false"
          @keydown.down.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="run(results[index])"
          @keydown.escape.prevent.stop="emit('close')"
        />
        <kbd class="pal-kbd">Esc</kbd>
      </div>
      <div ref="listEl" class="pal-list">
        <template v-for="(r, i) in rows" :key="r.c.id">
          <div v-if="r.header" class="pal-group">{{ r.header }}</div>
          <button
            class="pal-item"
            :class="{ active: i === index }"
            @mouseenter="index = i"
            @click="run(r.c)"
          >
            <span class="pal-title">{{ r.c.title }}</span>
            <span v-if="r.c.hint" class="pal-hint">{{ r.c.hint }}</span>
            <span v-if="r.c.shortcut" class="pal-shortcut">{{ r.c.shortcut }}</span>
          </button>
        </template>
        <div v-if="!rows.length" class="pal-empty">Nothing matches "{{ query }}"</div>
      </div>
    </div>
  </div>
</template>
