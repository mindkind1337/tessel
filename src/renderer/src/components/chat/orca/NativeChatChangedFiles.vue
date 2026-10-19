<script setup>
// Tessel: under an agent's turn, the files it changed (an agentic IDE's review
// bar): "3 files changed +40 -12" and each file with its counts. A file opens
// at its first change, "Open diff" shows the turn's edits to it in an editor
// diff tab, and "Review all" opens the pane's changes: its task's Review for a
// worktree copy, else Source Control (use-agent-edit-actions.js).
// Props: changes ({ files: [{ path, added, removed, changeKind, edits }],
//   added, removed }: chat/agentEdits.js turnChangedFiles).
import { computed, ref } from 'vue'
import { ChevronRight, GitCompareArrows, ListChecks } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { DiffLineCounts } from '../../../chat/orca/lib/diff-line-counts.js'
import { useAgentEditActions } from '../../../chat/orca/composables/use-agent-edit-actions.js'

const props = defineProps({
  changes: { type: Object, required: true }
})

const actions = useAgentEditActions()
// A few files show at once; a longer list waits for a click.
const open = ref(props.changes.files.length <= 4)

const summary = computed(() =>
  props.changes.files.length === 1
    ? t('chat.agentEdits.changedOne', '1 file changed')
    : t('chat.agentEdits.changedMany', '{{count}} files changed', { count: props.changes.files.length })
)
const reviewLabel = computed(() => t('chat.agentEdits.reviewAll', 'Review all'))
const reviewHint = computed(() => t('chat.agentEdits.reviewAllHint', "Review this pane's changes (its task's Review, or Source Control)"))
const diffLabel = computed(() => t('chat.agentEdits.openDiff', 'Open diff'))

function baseName(path) {
  return String(path).split(/[\\/]/).at(-1) || path
}
function folderOf(path) {
  const parts = String(path).split(/[\\/]/)
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
}
const rows = computed(() =>
  props.changes.files.map((file) => ({
    file,
    name: baseName(file.path),
    folder: folderOf(file.path),
    openable: file.changeKind !== 'deleted' && actions.canOpen.value && !!actions.pathOf(file.edits[0].block, file.path),
    diffable: actions.canDiff.value && !!actions.pathOf(file.edits[0].block, file.path),
    title: t('chat.agentEdits.openAtChange', 'Open {{path}} at its first change', { path: file.path })
  }))
)
const editsOf = (file) => file.edits.map((e) => ({ block: e.block, file: e.file }))
function openFile(file, event) {
  void actions.openAt({ path: file.path, edits: editsOf(file) }, event)
}
function openDiff(file) {
  void actions.openDiff({ path: file.path, edits: editsOf(file) })
}
</script>

<template>
  <div class="nc-changed-files" data-test="changed-files">
    <div class="nc-changed-files__head">
      <button type="button" class="nc-changed-files__toggle" :aria-expanded="open ? 'true' : 'false'" @click="open = !open">
        <ChevronRight aria-hidden="true" :class="['nc-changed-files__chevron', { 'nc-changed-files__chevron--open': open }]" />
        <span class="nc-changed-files__summary">{{ summary }}</span>
        <DiffLineCounts :added="changes.added" :removed="changes.removed" />
      </button>
      <button
        v-if="actions.canReview.value"
        type="button"
        class="nc-changed-files__review"
        :title="reviewHint"
        data-test="changed-files-review"
        @click="actions.reviewAll()"
      >
        <ListChecks aria-hidden="true" />
        <span>{{ reviewLabel }}</span>
      </button>
    </div>
    <ul v-if="open" class="nc-changed-files__list">
      <li v-for="row in rows" :key="row.file.path" class="nc-changed-files__file">
        <button
          v-if="row.openable"
          type="button"
          class="nc-changed-files__path nc-changed-files__path--link"
          :title="row.title"
          data-test="changed-file-open"
          @click="openFile(row.file, $event)"
        >
          <span class="nc-changed-files__name">{{ row.name }}</span>
          <span v-if="row.folder" class="nc-changed-files__folder">{{ row.folder }}</span>
        </button>
        <span v-else class="nc-changed-files__path" :title="row.file.path">
          <span :class="['nc-changed-files__name', { 'nc-changed-files__name--deleted': row.file.changeKind === 'deleted' }]">{{ row.name }}</span>
          <span v-if="row.folder" class="nc-changed-files__folder">{{ row.folder }}</span>
        </span>
        <DiffLineCounts :added="row.file.added" :removed="row.file.removed" />
        <button
          v-if="row.diffable"
          type="button"
          class="nc-changed-files__action"
          :title="diffLabel"
          :aria-label="diffLabel"
          data-test="changed-file-diff"
          @click="openDiff(row.file)"
        >
          <GitCompareArrows aria-hidden="true" />
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.nc-changed-files {
  overflow: hidden;
  border: 1px solid var(--nc-border);
  border-radius: 6px;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
.nc-changed-files__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px 2px 0;
  background: color-mix(in srgb, var(--nc-accent) 40%, transparent);
}
.nc-changed-files__toggle {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 3px 8px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.nc-changed-files__toggle:hover .nc-changed-files__summary {
  color: var(--nc-foreground);
}
.nc-changed-files__chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-changed-files__chevron--open {
  transform: rotate(90deg);
}
@media (prefers-reduced-motion: reduce) {
  .nc-changed-files__chevron {
    transition: none;
  }
}
.nc-changed-files__summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--nc-foreground) 85%, transparent);
}
.nc-changed-files__review {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 2px 8px;
  border: 1px solid var(--nc-border);
  border-radius: 4px;
  background: var(--nc-background, transparent);
  color: var(--nc-foreground);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.nc-changed-files__review:hover {
  background: var(--nc-accent);
}
.nc-changed-files__review svg {
  width: 12px;
  height: 12px;
}
.nc-changed-files__list {
  margin: 0;
  padding: 2px 0;
  list-style: none;
}
.nc-changed-files__file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 1px 6px 1px 28px;
}
.nc-changed-files__file:hover {
  background: color-mix(in srgb, var(--nc-accent) 30%, transparent);
}
.nc-changed-files__path {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}
.nc-changed-files__path--link {
  cursor: pointer;
}
.nc-changed-files__path--link:hover .nc-changed-files__name {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.nc-changed-files__name {
  flex-shrink: 0;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  color: var(--nc-foreground);
}
.nc-changed-files__name--deleted {
  color: var(--nc-muted-foreground);
  text-decoration: line-through;
}
.nc-changed-files__folder {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  direction: rtl;
  text-align: left;
}
.nc-changed-files__action {
  display: inline-flex;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  margin: 0 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--nc-muted-foreground);
  cursor: pointer;
}
.nc-changed-files__action:hover {
  background: var(--nc-accent);
  color: var(--nc-foreground);
}
.nc-changed-files__action svg {
  width: 13px;
  height: 13px;
}
.nc-changed-files__toggle:focus-visible,
.nc-changed-files__review:focus-visible,
.nc-changed-files__path--link:focus-visible,
.nc-changed-files__action:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--nc-ring) 70%, transparent);
  border-radius: 4px;
}
</style>
