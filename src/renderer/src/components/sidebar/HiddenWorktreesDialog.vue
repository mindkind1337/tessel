<script setup>
// A project's hidden git worktrees, from its menu: a search box and a Show
// button per row (after Orca's WorktreeVisibilityDialog.tsx and
// HiddenWorktreeRecoveryList.tsx, MIT, Copyright (c) 2026 Lovecast Inc.).
// Esc or a click outside closes it.
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { FolderMinus, Search, X } from 'lucide-vue-next'
import { t } from '../../i18n'

const props = defineProps({
  projectName: { type: String, default: '' },
  // [{ key, path, label, folder, detached, locked }] (sidebarModel's projectOtherBranches)
  items: { type: Array, required: true },
  // How many of the project's other worktrees are shown already.
  shownCount: { type: Number, default: 0 }
})
const emit = defineEmits(['show', 'close'])

const query = ref('')
const searchEl = ref(null)
const dialog = ref(null)
let previousFocus = null

const filtered = computed(() => {
  const q = query.value.trim().toLocaleLowerCase()
  if (!q) return props.items
  return props.items.filter((i) => i.label.toLocaleLowerCase().includes(q) || i.path.toLocaleLowerCase().includes(q))
})

onMounted(() => {
  previousFocus = document.activeElement
  searchEl.value?.focus()
})
onUnmounted(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})

function trapTab(event) {
  const focusable = [...(dialog.value?.querySelectorAll('button:not(:disabled), input') || [])]
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
</script>

<template>
  <div class="help-backdrop hwt-backdrop" data-test="hidden-worktrees-dialog" @pointerdown.self="emit('close')">
    <div
      ref="dialog"
      class="help-card hwt-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hwt-title"
      @focusin.stop
      @keydown.escape.prevent.stop="emit('close')"
      @keydown.tab.stop="trapTab"
    >
      <div class="hwt-head">
        <div class="hwt-head-text">
          <h2
            id="hwt-title"
            class="hwt-title"
            data-test="hidden-worktrees-title"
            v-text="t('sidebar.hiddenWorktrees.title', 'Hidden worktrees ({{count}})', { count: items.length })"
          ></h2>
          <p class="hwt-sub">
            <span v-if="projectName">{{ projectName }} · </span>{{
              t('sidebar.hiddenWorktrees.sub', 'Worktrees Tessel did not create stay hidden until you show them.')
            }}
          </p>
        </div>
        <button type="button" class="hwt-close" :aria-label="t('sidebar.hiddenWorktrees.close', 'Close')" @click="emit('close')">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
      <label class="hwt-search">
        <Search :size="13" aria-hidden="true" />
        <input
          ref="searchEl"
          v-model="query"
          type="search"
          data-test="hidden-worktrees-search"
          :aria-label="t('sidebar.hiddenWorktrees.search', 'Search hidden worktrees')"
          :placeholder="t('sidebar.hiddenWorktrees.searchPlaceholder', 'Search {{count}} worktrees…', { count: items.length })"
        />
      </label>
      <ul v-if="filtered.length" class="hwt-list">
        <li v-for="item in filtered" :key="item.key" class="hwt-row" data-test="hidden-worktrees-row">
          <div class="hwt-row-text">
            <div class="hwt-name">{{ item.label }}</div>
            <div class="hwt-path" :title="item.path">{{ item.path }}</div>
          </div>
          <button
            type="button"
            class="hwt-show"
            data-test="hidden-worktrees-show"
            :aria-label="t('sidebar.hiddenWorktrees.showAt', 'Show {{name}} at {{path}}', { name: item.label, path: item.path })"
            @click="emit('show', item.path)"
          >
            {{ t('sidebar.hiddenWorktrees.show', 'Show') }}
          </button>
        </li>
      </ul>
      <div v-else class="hwt-empty" data-test="hidden-worktrees-empty">
        <span class="hwt-empty-icon"><FolderMinus :size="14" aria-hidden="true" /></span>
        <div>
          <div class="hwt-empty-title">
            {{
              query.trim()
                ? t('sidebar.hiddenWorktrees.noMatches', 'No matching worktrees')
                : shownCount
                  ? t('sidebar.hiddenWorktrees.allShown', 'All discovered worktrees are shown')
                  : t('sidebar.hiddenWorktrees.noneFound', 'No other worktrees found')
            }}
          </div>
          <div class="hwt-empty-sub">
            {{
              query.trim()
                ? t('sidebar.hiddenWorktrees.tryAnother', 'Try a different name or path.')
                : t('sidebar.hiddenWorktrees.appearHere', 'New worktrees appear here when Tessel finds them.')
            }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
