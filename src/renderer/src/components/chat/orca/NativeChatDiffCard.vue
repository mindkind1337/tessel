<script setup>
// After Orca's NativeChatDiffCard.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Inline card for one file an agent edited: verb header, path with change
 * counts, and the unified rows. The gutter is blank when the provider gave no
 * resolved ranges, because a snippet-relative number would read as a file
 * position. A change reported with no body — a delete names the file and
 * nothing else — keeps the header rows and offers no empty disclosure.
 * Props: file (a NativeChatEditFile), revealSignal (a request id: opens the card
 *   and reports it), onReveal(element), initiallyExpanded (false),
 *   disclosureKey (where the open state is remembered while unmounted).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronRight, FileMinus2, FilePen, FilePlus2 } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { unifiedLineNumber } from '../../../chat/orca/shared/native-chat-edit-model.js'
import { useNativeChatDisclosure } from '../../../chat/orca/composables/native-chat-disclosure-store.js'
import { DiffLineCounts } from '../../../chat/orca/lib/diff-line-counts.js'
import NativeChatCopyButton from './NativeChatCopyButton.vue'

const props = defineProps({
  file: { type: Object, required: true },
  revealSignal: { type: Number, default: undefined },
  onReveal: { type: Function, default: undefined },
  initiallyExpanded: { type: Boolean, default: false },
  disclosureKey: { type: String, default: undefined }
})

const { open: expanded, setOpen: setExpanded } = useNativeChatDisclosure(
  () => props.disclosureKey,
  () => props.initiallyExpanded
)
const cardRef = ref(null)

function reveal() {
  if (props.revealSignal && cardRef.value) {
    setExpanded(true)
    // Reported from the card, not the row: a turn that touched four files must
    // land on the one that was asked for, and only the card knows where it is.
    props.onReveal?.(cardRef.value)
  }
}
onMounted(reveal)
watch(() => [props.revealSignal, props.onReveal], reveal, { flush: 'post' })

const verbLabel = computed(() => {
  switch (props.file.changeKind) {
    case 'added':
      return t('chat.orca.tool.addedFile', 'Added file')
    case 'deleted':
      return t('chat.orca.tool.deletedFile', 'Deleted file')
    case 'renamed':
      return t('chat.orca.tool.renamedFile', 'Renamed file')
    default:
      return t('chat.orca.tool.editedFile', 'Edited file')
  }
})
const verbIcon = computed(() =>
  props.file.changeKind === 'added' ? FilePlus2 : props.file.changeKind === 'deleted' ? FileMinus2 : FilePen
)

function baseName(path) {
  return String(path).split(/[\\/]/).at(-1) || path
}

function sign(line) {
  return line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
}

// Joining every row to seed the copy button is the card's most expensive work.
const copyText = computed(() =>
  props.file.lines
    .filter((line) => line.kind !== 'gap')
    .map((line) => `${sign(line)}${line.text}`)
    .join('\n')
)
const hasBody = computed(() => props.file.lines.length > 0)
const gutterWidth = computed(() => {
  if (!props.file.lineNumbersKnown) return 0
  const widest = props.file.lines.reduce((max, line) => Math.max(max, unifiedLineNumber(line) ?? 0), 0)
  return Math.max(3, String(widest).length + 1)
})
// Keys: signature plus occurrence, so identical rows keep distinct identities.
const rows = computed(() => {
  const seen = new Map()
  return props.file.lines.map((line) => {
    const signature = `${line.kind}:${line.oldLineNumber}:${line.newLineNumber}:${line.text}`
    const occurrence = seen.get(signature) ?? 0
    seen.set(signature, occurrence + 1)
    return { key: `${signature}:${occurrence}`, line }
  })
})

const gapLabel = computed(() => t('chat.orca.tool.diffGap', 'Lines not shown'))
const truncatedLabel = computed(() => t('chat.orca.tool.diffTruncated', 'Diff truncated'))
const copyLabel = computed(() => t('chat.orca.tool.copyDiff', 'Copy diff'))

function toggle() {
  if (hasBody.value) setExpanded(!expanded.value)
}
</script>

<template>
  <div ref="cardRef" class="nc-diff-card">
    <button
      type="button"
      :class="['nc-diff-card__header', hasBody ? 'nc-diff-card__header--toggle' : 'nc-diff-card__header--static']"
      :aria-expanded="hasBody ? (expanded ? 'true' : 'false') : undefined"
      @click="toggle"
    >
      <component :is="verbIcon" class="nc-diff-card__verb-icon" />
      <span class="nc-diff-card__verb">{{ verbLabel }}</span>
      <ChevronRight
        v-if="hasBody"
        :class="['nc-diff-card__chevron', { 'nc-diff-card__chevron--open': expanded }]"
      />
    </button>
    <div class="nc-diff-card__file">
      <template v-if="file.oldPath">
        <span class="nc-diff-card__old-path">{{ baseName(file.oldPath) }}</span>
        <span class="nc-diff-card__arrow">→</span>
      </template>
      <span class="nc-diff-card__path" :title="file.path">{{ baseName(file.path) }}</span>
      <DiffLineCounts :added="file.added" :removed="file.removed" />
      <!-- Beside the counts rather than under the rows: a collapsed card, and
           one clipped down to no rows at all, would otherwise say nothing. -->
      <span v-if="file.truncated" class="nc-diff-card__truncated">{{ truncatedLabel }}</span>
      <NativeChatCopyButton :text="copyText" :label="copyLabel" class="nc-diff-card__copy" />
    </div>
    <!-- Focusable so the rows can be scrolled from the keyboard. -->
    <div v-if="hasBody && expanded" tabindex="0" class="nc-diff-card__rows nc-scrollbar-sleek">
      <template v-for="row in rows" :key="row.key">
        <!-- The break between two regions of the file, quiet enough not to read
             as a row of content but present enough that the gutter's jump is
             accounted for. -->
        <div v-if="row.line.kind === 'gap'" role="separator" :aria-label="gapLabel" class="nc-diff-card__gap">⋯</div>
        <div v-else :class="['nc-diff-card__row', `nc-diff-card__row--${row.line.kind}`]">
          <!-- The gutter carries its own ground so the number column stays
               legible against a tinted row instead of dissolving into it. -->
          <span
            v-if="gutterWidth > 0"
            :class="['nc-diff-card__gutter', `nc-diff-card__gutter--${row.line.kind}`]"
            :style="{ width: `${gutterWidth}ch` }"
            aria-hidden="true"
          >{{ unifiedLineNumber(row.line) ?? '' }}</span>
          <span :class="['nc-diff-card__sign', `nc-diff-card__sign--${row.line.kind}`]" aria-hidden="true">{{ sign(row.line) }}</span>
          <span class="nc-diff-card__text">{{ row.line.text }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* my-1 overflow-hidden rounded-md border border-border */
.nc-diff-card {
  margin: 4px 0;
  overflow: hidden;
  border: 1px solid var(--nc-border);
  border-radius: 6px;
}
/* group/diff-card flex w-full items-center gap-1.5 px-2 py-1 text-left */
.nc-diff-card__header {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 4px 8px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}
.nc-diff-card__header--toggle {
  cursor: pointer;
}
.nc-diff-card__header--toggle:hover {
  background: color-mix(in srgb, var(--nc-accent) 30%, transparent);
}
.nc-diff-card__header--static {
  cursor: default;
}
.nc-diff-card__verb-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
}
.nc-diff-card__verb {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
.nc-diff-card__header:hover .nc-diff-card__verb {
  color: color-mix(in srgb, var(--nc-foreground) 80%, transparent);
}
.nc-diff-card__chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
  transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-diff-card__chevron--open {
  transform: rotate(90deg);
}
/* flex items-center gap-1.5 border-t border-border bg-accent/40 px-2 py-1 */
.nc-diff-card__file {
  display: flex;
  align-items: center;
  gap: 6px;
  border-top: 1px solid var(--nc-border);
  background: color-mix(in srgb, var(--nc-accent) 40%, transparent);
  padding: 4px 8px;
}
.nc-diff-card__old-path,
.nc-diff-card__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
}
.nc-diff-card__old-path {
  color: var(--nc-muted-foreground);
  text-decoration: line-through;
}
.nc-diff-card__path {
  font-weight: 500;
  color: var(--nc-foreground);
}
.nc-diff-card__arrow,
.nc-diff-card__truncated {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
.nc-diff-card__copy {
  margin-left: auto;
  flex-shrink: 0;
}
/* max-h-72 overflow-auto font-mono text-[11px] leading-relaxed */
.nc-diff-card__rows {
  max-height: 288px;
  overflow: auto;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  line-height: 1.625;
}
.nc-diff-card__rows:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--nc-ring) 70%, transparent);
}
/* select-none border-y border-border/60 bg-accent/30 py-0.5 text-center text-muted-foreground */
.nc-diff-card__gap {
  user-select: none;
  border-top: 1px solid color-mix(in srgb, var(--nc-border) 60%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--nc-border) 60%, transparent);
  background: color-mix(in srgb, var(--nc-accent) 30%, transparent);
  padding: 2px 0;
  text-align: center;
  color: var(--nc-muted-foreground);
}
.nc-diff-card__row {
  display: flex;
  align-items: flex-start;
}
.nc-diff-card__row--add {
  background: var(--nc-diff-added-ground);
}
.nc-diff-card__row--del {
  background: var(--nc-diff-removed-ground);
}
/* shrink-0 select-none pr-1.5 text-right tabular-nums text-muted-foreground */
.nc-diff-card__gutter {
  flex-shrink: 0;
  user-select: none;
  padding-right: 6px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--nc-muted-foreground);
}
.nc-diff-card__gutter--add {
  background: var(--nc-diff-added-gutter);
}
.nc-diff-card__gutter--del {
  background: var(--nc-diff-removed-gutter);
}
.nc-diff-card__gutter--context {
  background: color-mix(in srgb, var(--nc-accent) 40%, transparent);
}
/* w-3 shrink-0 select-none text-center */
.nc-diff-card__sign {
  width: 12px;
  flex-shrink: 0;
  user-select: none;
  text-align: center;
}
.nc-diff-card__sign--add {
  color: var(--nc-git-added);
}
.nc-diff-card__sign--del {
  color: var(--nc-git-deleted);
}
/* min-w-0 whitespace-pre-wrap break-words pr-2 text-foreground/85 */
.nc-diff-card__text {
  min-width: 0;
  padding-right: 8px;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  color: color-mix(in srgb, var(--nc-foreground) 85%, transparent);
}
</style>
