<script setup>
// After Orca's NativeChatBackgroundTasksStatus.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * The strip above the composer while background tasks run: a one-line header
 * ("3 agents · 1 monitor") that opens the roster, grouped by kind, with a Stop
 * per task (or one Stop for all when the host only accepts that).
 *
 * Props: tasks, settledTasks (AgentSessionBackgroundTask[]), supportsTaskStop,
 *   supportsStopAll (false: no honest stop, so no fallback button),
 *   stoppingTaskIds (Set), stoppingAll, indicatorActive (true while the session
 *   is idle: only then does the strip speak as the monitoring indicator),
 *   isVisible, expanded (owned by the parent: the strip unmounts whenever live
 *   work momentarily drops to nothing), onExpandedChange(expanded) (also
 *   @expanded-change), onStop(taskId?) (also @stop; no id = stop all).
 * Tessel: task names (often a command line) are shown through maskSecrets.
 */
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { useNow } from '../../../chat/orca/composables/use-now.js'
import { backgroundTasksHeaderContent } from '../../../chat/orca/background-task-header-content.js'
import {
  backgroundTaskElapsedLabel,
  backgroundTaskGroupLabel,
  backgroundTaskStateReason,
  buildBackgroundTaskGroups,
  formatBackgroundTaskTokens
} from '../../../chat/orca/background-task-roster.js'
import { maskToolText } from '../../../chat/orca/lib/native-chat-tool-secrets.js'
import { KIND_ICONS, kindIconTone } from './native-chat-background-task-icons.js'
import AgentStateDot from './AgentStateDot.vue'
import { Button } from './ui'

const props = defineProps({
  tasks: { type: Array, required: true },
  settledTasks: { type: Array, required: true },
  supportsTaskStop: { type: Boolean, default: false },
  supportsStopAll: { type: Boolean, default: false },
  stoppingTaskIds: { type: Set, default: () => new Set() },
  stoppingAll: { type: Boolean, default: false },
  indicatorActive: { type: Boolean, default: false },
  isVisible: { type: Boolean, default: true },
  expanded: { type: Boolean, default: false },
  onExpandedChange: { type: Function, default: undefined },
  onStop: { type: Function, default: undefined },
  // Tessel: where to stop them when no Stop is offered here (a terminal agent).
  stopNote: { type: String, default: '' }
})

/** Below this strip width (border-box, live root font size) the header drops
 *  its per-kind breakdown for an honest total. A narrow split pane on a wide
 *  monitor must behave like a narrow window, so no viewport media query. */
const NARROW_STRIP_REM = 24

function rootFontSizePx() {
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16
}

const taskListId = useId()
const stripRef = ref(null)
// The viewport is only the pre-measurement stand-in before the first observer callback.
const narrow = ref(window.innerWidth < NARROW_STRIP_REM * 16)
let observer = null
onMounted(() => {
  const element = stripRef.value
  if (!element || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver((entries) => {
    const width = entries[0]?.borderBoxSize?.[0]?.inlineSize ?? element.getBoundingClientRect().width
    narrow.value = width < NARROW_STRIP_REM * rootFontSizePx()
  })
  observer.observe(element, { box: 'border-box' })
})
onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

// The 1 Hz elapsed tick must not re-group, re-sort and re-translate the whole roster.
const groups = computed(() => buildBackgroundTaskGroups(props.tasks, props.settledTasks))
const singleLiveCommand = computed(
  () => groups.value.length === 1 && groups.value[0].kind === 'command' && groups.value[0].tasks.length === 1
)
const hasElapsed = computed(() =>
  groups.value.some((group) => group.tasks.some((entry) => !entry.settled && (entry.task.startedAt ?? 0) > 0))
)
const now = useNow(1_000, () => props.isVisible && hasElapsed.value && (props.expanded || singleLiveCommand.value))
const header = computed(() => backgroundTasksHeaderContent(groups.value, { narrow: narrow.value, now: now.value }))
const headerText = computed(() => {
  const { segments, detail } = header.value
  return `${segments.map((segment) => segment.text).join(' · ')}${detail ? `${segments.length > 0 ? ' — ' : ''}${detail}` : ''}`
})

/** Absent means stoppable: a host predating the field published only rows its
 *  stop could act on. Only an explicit `false` withholds the button — a Stop on
 *  such a row resolves to an empty target list and silently reports nothing. */
function stoppable(task) {
  return task.stoppable !== false
}

const rowGroups = computed(() =>
  groups.value.map((group) => ({
    kind: group.kind,
    label: backgroundTaskGroupLabel(group.kind),
    rows: group.tasks.map((entry) => {
      const name = maskToolText(entry.name)
      // Settled rows keep their final usage but no elapsed — a still-growing
      // clock on finished work would lie.
      const meta = [
        entry.task.totalTokens !== undefined ? formatBackgroundTaskTokens(entry.task.totalTokens) : null,
        entry.settled ? null : backgroundTaskElapsedLabel(entry.task, now.value)
      ]
        .filter((part) => part !== null)
        .join(' · ')
      return {
        entry,
        name,
        // Every attention state states its reason on the row; `unverifiable`
        // ("no contact") must never be silently dropped.
        reason: backgroundTaskStateReason(entry.state),
        meta,
        canStop: !entry.settled && props.supportsTaskStop && stoppable(entry.task),
        stopLabel: t('chat.orca.backgroundTasks.stopTask', 'Stop {{value0}}', { value0: name })
      }
    })
  }))
)

const stopText = computed(() => t('chat.orca.backgroundTasks.stop', 'Stop'))
const stopAllLabel = computed(() => t('chat.orca.backgroundTasks.stopAll', 'Stop background tasks'))
const unavailableText = computed(() =>
  t('chat.orca.backgroundTasks.detailsUnavailable', 'Task details are unavailable for this session.')
)
</script>

<template>
  <div data-native-chat-background-tasks="true" class="nc-bg-tasks">
    <!-- When the goal tab is the next sibling, take its width and share its top edge. -->
    <div class="nc-bg-tasks__column">
      <div ref="stripRef" class="nc-bg-tasks__strip">
        <div class="nc-bg-tasks__bar">
          <button
            type="button"
            class="nc-bg-tasks__header"
            :aria-expanded="expanded ? 'true' : 'false'"
            :aria-controls="taskListId"
            :aria-label="headerText"
            @click="onExpandedChange?.(!expanded)"
          >
            <span class="nc-bg-tasks__summary">
              <span v-for="(segment, index) in header.segments" :key="segment.kind ?? 'total'">
                <!-- A text token, not the border colour: that one is a divider
                     line and reads as invisible at this size. -->
                <span v-if="index > 0" class="nc-bg-tasks__separator">{{ ' · ' }}</span>
                <!-- A collapsed total spans kinds, so no single icon can stand
                     for it. The turn owns the voice: same icons, dimmed until it ends. -->
                <component
                  :is="KIND_ICONS[segment.kind]"
                  v-if="segment.kind && KIND_ICONS[segment.kind]"
                  aria-hidden="true"
                  :class="['nc-bg-tasks__segment-icon', kindIconTone(segment.kind, !indicatorActive)]"
                />
                <span class="nc-bg-tasks__segment-text">{{ segment.text }}</span>
              </span>
              <span v-if="header.detail">{{ header.segments.length > 0 ? ' — ' : '' }}{{ header.detail }}</span>
            </span>
            <ChevronDown aria-hidden="true" :class="['nc-bg-tasks__chevron', { 'nc-bg-tasks__chevron--open': expanded }]" />
          </button>
        </div>
        <div v-if="expanded" :id="taskListId" class="nc-bg-tasks__list nc-scrollbar-sleek">
          <template v-if="rowGroups.length > 0">
            <div
              v-for="(group, index) in rowGroups"
              :key="group.kind"
              :class="{ 'nc-bg-tasks__group--next': index > 0 }"
            >
              <p class="nc-bg-tasks__group-label">{{ group.label }}</p>
              <ul role="list" :aria-label="group.label" class="nc-bg-tasks__rows">
                <li v-for="row in group.rows" :key="row.entry.task.id" class="nc-bg-tasks__row">
                  <component
                    :is="KIND_ICONS[row.entry.task.kind] ?? KIND_ICONS.unknown"
                    aria-hidden="true"
                    :class="['nc-bg-tasks__row-icon', kindIconTone(row.entry.task.kind, false)]"
                  />
                  <AgentStateDot :state="row.entry.state" size="sm" :title="null" />
                  <span class="nc-bg-tasks__row-name"><span class="nc-bg-tasks__name">{{ row.name }}</span><span
                      v-if="row.reason"
                      class="nc-bg-tasks__reason"
                    >{{ ` · ${row.reason}` }}</span></span>
                  <span v-if="row.meta" class="nc-bg-tasks__meta">{{ row.meta }}</span>
                  <Button
                    v-if="row.canStop"
                    type="button"
                    variant="ghost"
                    size="xs"
                    :aria-label="row.stopLabel"
                    :disabled="stoppingTaskIds.has(row.entry.task.id)"
                    @click="onStop?.(row.entry.task.id)"
                  >{{ stopText }}</Button>
                </li>
              </ul>
            </div>
          </template>
          <p v-else class="nc-bg-tasks__unavailable">{{ unavailableText }}</p>
          <p v-if="stopNote && !supportsTaskStop && !supportsStopAll" class="nc-bg-tasks__note" data-test="bg-tasks-stop-note">{{ stopNote }}</p>
          <div
            v-if="!supportsTaskStop && supportsStopAll"
            :class="rowGroups.length > 0 ? 'nc-bg-tasks__stop-all--ruled' : 'nc-bg-tasks__stop-all'"
          >
            <Button
              type="button"
              variant="ghost"
              size="xs"
              :aria-label="stopAllLabel"
              :disabled="stoppingAll"
              @click="onStop?.()"
            >{{ stopText }}</Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* group/tasks shrink-0 bg-background px-3 pt-2 sm:px-4 */
.nc-bg-tasks {
  flex-shrink: 0;
  background: var(--nc-background);
  padding: 8px 12px 0;
}
@media (min-width: 40rem) {
  .nc-bg-tasks {
    padding-left: 16px;
    padding-right: 16px;
  }
}
/* mx-auto w-full max-w-4xl, group-has-[+[data-native-chat-thread-goal]]/tasks:px-2 */
.nc-bg-tasks__column {
  margin: 0 auto;
  width: 100%;
  max-width: 56rem;
}
.nc-bg-tasks:has(+ [data-native-chat-thread-goal]) .nc-bg-tasks__column {
  padding: 0 8px;
}
/* overflow-hidden rounded-lg border border-border bg-muted/50 text-xs text-muted-foreground shadow-xs */
.nc-bg-tasks__strip {
  overflow: hidden;
  border: 1px solid var(--nc-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--nc-muted) 50%, transparent);
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
}
.nc-bg-tasks:has(+ [data-native-chat-thread-goal]) .nc-bg-tasks__strip {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  box-shadow: none;
}
/* flex h-8 items-center px-1.5 */
.nc-bg-tasks__bar {
  display: flex;
  height: 32px;
  align-items: center;
  padding: 0 6px;
}
/* flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 */
.nc-bg-tasks__header {
  display: flex;
  height: 24px;
  min-width: 0;
  flex: 1 1 0%;
  cursor: pointer;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  outline: none;
}
.nc-bg-tasks__header:hover {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-bg-tasks__header:focus-visible {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--nc-ring) 50%, transparent);
}
.nc-bg-tasks__summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-bg-tasks__separator {
  color: var(--nc-muted-foreground);
}
/* mr-1 inline size-3 align-[-0.125em] */
.nc-bg-tasks__segment-icon {
  display: inline;
  margin-right: 4px;
  width: 12px;
  height: 12px;
  vertical-align: -0.125em;
}
.nc-bg-tasks__segment-text,
.nc-bg-tasks__name {
  font-weight: 500;
  color: var(--nc-foreground);
}
.nc-bg-tasks__chevron {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-bg-tasks__chevron--open {
  transform: rotate(180deg);
}
/* max-h-40 overflow-y-auto border-t border-border px-3 py-2 */
.nc-bg-tasks__list {
  max-height: 160px;
  overflow-y: auto;
  border-top: 1px solid var(--nc-border);
  padding: 8px 12px;
}
.nc-bg-tasks__group--next {
  margin-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--nc-border) 60%, transparent);
  padding-top: 6px;
}
/* px-0.5 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground */
.nc-bg-tasks__group-label {
  margin: 0;
  padding: 0 2px 4px;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--nc-muted-foreground);
}
.nc-bg-tasks__rows {
  margin: 0;
  padding: 0;
  list-style: none;
}
.nc-bg-tasks__rows > * + * {
  margin-top: 2px;
}
/* flex h-6 min-w-0 items-center gap-2 text-foreground/80 */
.nc-bg-tasks__row {
  display: flex;
  height: 24px;
  min-width: 0;
  align-items: center;
  gap: 8px;
  color: color-mix(in srgb, var(--nc-foreground) 80%, transparent);
}
.nc-bg-tasks__row-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.nc-bg-tasks__row-name {
  min-width: 0;
  flex: 1 1 0%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-bg-tasks__reason {
  color: var(--nc-muted-foreground);
}
/* shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground */
.nc-bg-tasks__meta {
  flex-shrink: 0;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--nc-muted-foreground);
}
.nc-bg-tasks__unavailable {
  margin: 0;
}
.nc-bg-tasks__note {
  margin: 8px 0 0;
  border-top: 1px solid var(--nc-border);
  padding-top: 6px;
}
.nc-bg-tasks__stop-all {
  margin-top: 8px;
}
.nc-bg-tasks__stop-all--ruled {
  margin-top: 8px;
  border-top: 1px solid var(--nc-border);
  padding-top: 8px;
}
/* Kind tones (kindIconTone): monitor amber = text-yellow-500, /40 while a turn runs. */
.nc-kind-tone--muted {
  color: var(--nc-muted-foreground);
}
.nc-kind-tone--monitor {
  color: oklch(0.795 0.184 86.047);
}
.nc-kind-tone--muted.nc-kind-tone--dimmed {
  color: color-mix(in srgb, var(--nc-muted-foreground) 40%, transparent);
}
.nc-kind-tone--monitor.nc-kind-tone--dimmed {
  color: color-mix(in oklab, oklch(0.795 0.184 86.047) 40%, transparent);
}
</style>
