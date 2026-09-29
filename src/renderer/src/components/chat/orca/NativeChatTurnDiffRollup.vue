<script setup>
// After Orca's NativeChatTurnDiffRollup.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Under a turn: "3 changed files +40 -12", opening to the list of files; a
 * file reveals its diff card in the transcript.
 * Props: diff (a NativeChatTurnDiff: { files: [{ path, added, removed, target }],
 *   added, removed, truncated }), onReveal(target) (also @reveal).
 */
import { computed } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui'
import { DiffLineCounts } from '../../../chat/orca/lib/diff-line-counts.js'

const props = defineProps({
  diff: { type: Object, required: true },
  onReveal: { type: Function, default: undefined }
})

const summary = computed(() =>
  props.diff.files.length === 1
    ? t('chat.orca.turnDiff.one', '1 changed file')
    : t('chat.orca.turnDiff.many', '{{count}} changed files', { count: props.diff.files.length })
)
const partialLabel = computed(() => t('chat.orca.turnDiff.partial', 'Partial diff'))
const recordedLabel = computed(() => t('chat.orca.turnDiff.recorded', 'Totals from recorded edits in this turn.'))
</script>

<template>
  <Collapsible class="nc-turn-diff">
    <CollapsibleTrigger as-child>
      <Button variant="ghost" size="xs" class="nc-turn-diff__trigger">
        <span class="nc-turn-diff__summary">{{ summary }}</span>
        <DiffLineCounts :added="diff.added" :removed="diff.removed" />
        <span v-if="diff.truncated">{{ partialLabel }}</span>
        <ChevronRight aria-hidden="true" class="nc-turn-diff__chevron nc-size-3-5" />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent class="nc-turn-diff__content">
      <p class="nc-turn-diff__note">{{ recordedLabel }}</p>
      <Button
        v-for="file in diff.files"
        :key="file.path"
        variant="ghost"
        size="xs"
        class="nc-turn-diff__file"
        @click="onReveal?.(file.target)"
      >
        <span class="nc-turn-diff__path" :title="file.path">{{ file.path }}</span>
        <DiffLineCounts :added="file.added" :removed="file.removed" />
      </Button>
    </CollapsibleContent>
  </Collapsible>
</template>

<style scoped>
/* text-xs text-muted-foreground */
.nc-turn-diff {
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
/* group w-full min-w-0 justify-start gap-1.5 */
.nc-turn-diff__trigger {
  width: 100%;
  min-width: 0;
  justify-content: flex-start;
  gap: 6px;
}
.nc-turn-diff__summary,
.nc-turn-diff__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-turn-diff__path {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
}
/* size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 */
.nc-turn-diff__chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-turn-diff__trigger[data-state='open'] .nc-turn-diff__chevron {
  transform: rotate(90deg);
}
@media (prefers-reduced-motion: reduce) {
  .nc-turn-diff__chevron {
    transition: none;
  }
}
/* mt-1 space-y-1 pl-4 */
.nc-turn-diff__content {
  margin-top: 4px;
  padding-left: 16px;
}
.nc-turn-diff__content > * + * {
  margin-top: 4px;
}
.nc-turn-diff__note {
  margin: 0;
  padding: 0 8px;
}
/* flex w-full justify-start gap-2 */
.nc-turn-diff__file {
  display: flex;
  width: 100%;
  justify-content: flex-start;
  gap: 8px;
}
</style>
