<script setup>
// After Orca's NativeChatToolRun.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * A run of a message's tool calls/results, collapsed to a one-line summary that
 * expands to the individual inline tool lines. Spawn-group rosters and
 * background tasks that belong with the run draw one row each above it.
 *
 * Props: blocks, previousTodoWrite, previousUpdatePlan (the task-list calls
 *   before this run, for the diff), revealedDiff ({ editKey, fileIndex,
 *   requestId }), onRevealDiff(element), subagentGroups, backgroundTasks,
 *   expandSignal (legacy view-level default; the native chat passes false),
 *   expandOverride (external control of this run's disclosure; left unset,
 *   the run owns it), activeTurnIsWorking (undefined = no turn state),
 *   trailing (whether this run is the working turn's last; unset = yes),
 *   structuredActivityUi (true), disclosureId (the message: where the run's
 *   and its rows' open state is remembered while windowing unmounts them),
 *   onLinkClick(event, url).
 * Tessel: the header's command / latest-call text is cut from inputs masked
 *   with maskSecrets; a run with a stopped call is never marked done and says
 *   how many stopped.
 */
import { computed } from 'vue'
import { Check, ChevronRight } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { isToolCallBlock } from '../../../chat/orca/shared/native-chat-types.js'
import { isRenderableSubagentGroup } from '../../../chat/orca/shared/native-chat-subagent-summary.js'
import { buildEditCards, NO_EDIT_CARDS } from '../../../chat/orca/native-chat-edit-cards.js'
import { countToolCalls } from '../../../chat/orca/native-chat-tool-summary.js'
import { nativeChatToolRunSentence } from '../../../chat/orca/native-chat-tool-run-label.js'
import {
  NO_NATIVE_CHAT_TOOL_PAIRING,
  pairNativeChatToolResults
} from '../../../chat/orca/shared/native-chat-tool-pairing.js'
import {
  describeLatestToolCall,
  NATIVE_CHAT_TOOL_ACTIVITY_COPY,
  selectActiveToolCall
} from '../../../chat/orca/shared/native-chat-tool-activity.js'
import { nativeChatToolRunIconName } from '../../../chat/orca/shared/native-chat-tool-icon.js'
import { nativeChatToolRunOutcome } from '../../../chat/orca/shared/native-chat-tool-run-outcome.js'
import { nativeChatAskRunBlocks, nativeChatAskRunSubject } from '../../../chat/orca/shared/native-chat-ask-row.js'
import { buildNativeChatTaskListRows } from '../../../chat/orca/native-chat-task-list-history.js'
import { useNativeChatDisclosure } from '../../../chat/orca/composables/native-chat-disclosure-store.js'
import { maskToolCallBlock } from '../../../chat/orca/lib/native-chat-tool-secrets.js'
import { isStoppedToolCall } from '../../../chat/orca/lib/native-chat-tool-stopped.js'
import NativeChatAwaitingInputRow from './NativeChatAwaitingInputRow.vue'
import NativeChatTaskList from './NativeChatTaskList.vue'
import NativeChatBackgroundTaskRun from './NativeChatBackgroundTaskRun.vue'
import NativeChatSubagentRun from './NativeChatSubagentRun.vue'
import NativeChatToolRunIcon from './NativeChatToolRunIcon.vue'
import NativeChatDiffCard from './NativeChatDiffCard.vue'
import NativeChatToolLine from './NativeChatToolLine.vue'

const props = defineProps({
  blocks: { type: Array, required: true },
  previousTodoWrite: { type: Object, default: undefined },
  previousUpdatePlan: { type: Object, default: undefined },
  revealedDiff: { type: Object, default: undefined },
  onRevealDiff: { type: Function, default: undefined },
  subagentGroups: { type: Array, default: () => [] },
  backgroundTasks: { type: Array, default: () => [] },
  expandSignal: { type: Boolean, required: true },
  // Tri-state on purpose (undefined is "no caller control" / "no turn state"):
  // the explicit undefined defaults stop Vue's Boolean casting to false.
  expandOverride: { type: Boolean, default: undefined },
  activeTurnIsWorking: { type: Boolean, default: undefined },
  trailing: { type: Boolean, default: undefined },
  structuredActivityUi: { type: Boolean, default: true },
  disclosureId: { type: String, default: undefined },
  onLinkClick: { type: Function, default: undefined }
})

// A reader's deviation belongs to the controlling disclosure state, so returning
// to that state restores the same choice without writing to the store mid-render.
const runKey = computed(() =>
  props.disclosureId === undefined
    ? undefined
    : `run:${props.disclosureId}:${props.expandOverride ?? '-'}:${props.expandSignal}:${props.revealedDiff?.requestId ?? '-'}` // i18n-ignore
)
const { open, setOpen } = useNativeChatDisclosure(runKey, () =>
  props.revealedDiff ? true : (props.expandOverride ?? props.expandSignal)
)

// Childless groups are dropped so "something will draw" stays honest: a group
// with no children renders nothing, and the wrapper would be an empty bubble.
const subagentRows = computed(() => props.subagentGroups.filter(isRenderableSubagentGroup))
// Neither a roster nor a background task is tool activity, so both take every
// escape below that the tool header does not: a task row outlives the turn
// that started it and is the only durable report of how it ended.
const hasStandaloneRows = computed(() => subagentRows.value.length > 0 || props.backgroundTasks.length > 0)

const askRun = computed(() => nativeChatAskRunBlocks(props.blocks))
const headerBlocks = computed(() => askRun.value.work)
const hasAskCall = computed(() => askRun.value.asks.length > 0)
const askSubject = computed(() => (hasAskCall.value ? nativeChatAskRunSubject(askRun.value.asks) : null))
const showsHeader = computed(() => !hasAskCall.value || countToolCalls(headerBlocks.value) > 0)
const callCount = computed(() => countToolCalls(headerBlocks.value) || headerBlocks.value.length)
const askIsActive = computed(
  () => selectActiveToolCall(askRun.value.unansweredAsks, { activeTurnIsWorking: props.activeTurnIsWorking }) !== null
)
// Live is the turn's state, not a call's: deriving it from "some call is
// running" flipped the header to settled and back around every call. The
// turn's trailing run stays live from its first call until the agent moves on;
// a caller with no turn state, or a turn blocked on the reader's answer, falls
// back to the calls themselves.
const live = computed(
  () =>
    props.structuredActivityUi &&
    (props.activeTurnIsWorking === true && !askIsActive.value
      ? props.trailing !== false
      : selectActiveToolCall(headerBlocks.value, { activeTurnIsWorking: props.activeTurnIsWorking }) !== null)
)
// The header's words are cut from masked inputs (Tessel): one sentence for the
// whole run, or the command itself when the run is one call.
const maskedHeaderBlocks = computed(() => headerBlocks.value.map(maskToolCallBlock))
const runSentence = computed(() => nativeChatToolRunSentence(maskedHeaderBlocks.value, { live: live.value }))
// What the run is doing now, beside the sentence: the latest call, running or
// not, so a call that finished in a frame still leaves its name until the next.
const latestCallLabel = computed(() => {
  if (!live.value) return null
  const latest = maskedHeaderBlocks.value.findLast(isToolCallBlock)
  return latest ? describeLatestToolCall(latest) : null
})
const outcome = computed(() =>
  nativeChatToolRunOutcome(headerBlocks.value, { activeTurnIsWorking: props.activeTurnIsWorking })
)
const stoppedCallCount = computed(() => headerBlocks.value.filter(isStoppedToolCall).length)
// Only a stated success is marked done, and never while live. Tessel: a call
// the stop cut short is not a success either.
const showsCheck = computed(
  () => props.structuredActivityUi && !live.value && outcome.value.succeeded && stoppedCallCount.value === 0
)
// An externally opened run keeps child tools collapsed; normal callers leave
// the run's own disclosure independent from the turn status bar.
const expandToolLines = computed(() => (props.expandOverride === undefined ? open.value : false))
// Diffing every edit is the run's most expensive work, so a collapsed run —
// which renders none of it — never pays for it.
const taskLists = computed(() =>
  open.value
    ? buildNativeChatTaskListRows(props.blocks, {
        todowrite: props.previousTodoWrite,
        update_plan: props.previousUpdatePlan
      })
    : null
)
const editCards = computed(() => (open.value ? buildEditCards(props.blocks) : NO_EDIT_CARDS))
const pairing = computed(() =>
  open.value ? pairNativeChatToolResults(headerBlocks.value) : NO_NATIVE_CHAT_TOOL_PAIRING
)
// The glyph over the whole run: a run that spans categories heads with the
// generic tool glyph, and the glyph stays fixed; state rides on the trailing mark.
const settledHeaderIcon = computed(() => nativeChatToolRunIconName(headerBlocks.value.filter(isToolCallBlock)))
const headerLabel = computed(() => {
  if (runSentence.value !== null && runSentence.value !== undefined) return runSentence.value
  return callCount.value === 1
    ? t('chat.orca.tool.countOne', NATIVE_CHAT_TOOL_ACTIVITY_COPY.countOne)
    : t('chat.orca.tool.countN', NATIVE_CHAT_TOOL_ACTIVITY_COPY.countN, { value0: callCount.value })
})
const failedLabel = computed(() =>
  t('chat.orca.tool.failedCallsLabel', NATIVE_CHAT_TOOL_ACTIVITY_COPY.failedCallsLabel, {
    value0: outcome.value.failedCallCount
  })
)
const failedText = computed(() =>
  t('chat.orca.tool.failedCount', NATIVE_CHAT_TOOL_ACTIVITY_COPY.failedCount, { value0: outcome.value.failedCallCount })
)
const stoppedText = computed(() =>
  t('chat.orca.tool.stoppedCount', '{{count}} stopped', { count: stoppedCallCount.value })
)

// Completed turn activity belongs behind the turn-status disclosure. The
// rosters are not tool activity, so they survive this guard (and the tool-less
// escape) as rows of their own.
const collapsedIntoTurn = computed(
  () =>
    props.structuredActivityUi &&
    props.expandOverride === false &&
    !(props.revealedDiff && open.value) &&
    !live.value &&
    props.activeTurnIsWorking === false
)
const standaloneOnly = computed(() => props.blocks.length === 0 || collapsedIntoTurn.value)

// The opened run's members: a task list, an edit's diff cards, or a tool line.
const members = computed(() => {
  if (!open.value || !showsHeader.value) return []
  const seen = new Map()
  const out = []
  headerBlocks.value.forEach((block, blockIndex) => {
    const taskList = taskLists.value?.rows.get(block)
    if (taskList) {
      out.push({ kind: 'tasks', key: `tasks:${blockIndex}`, taskList }) // i18n-ignore
      return
    }
    if (taskLists.value?.consumedResults.has(block)) return
    const edit = editCards.value.editCards.get(block)
    if (edit) {
      out.push({ kind: 'edit', key: `edit:${edit.key}`, edit }) // i18n-ignore
      return
    }
    // A result its call now owns is drawn by that call's line, not as a row.
    if (editCards.value.consumedResults.has(block) || pairing.value.pairedResults.has(block)) return
    const signature =
      block.type === 'tool-call'
        ? `${block.type}:${block.name}:${JSON.stringify(block.input)}`
        : block.type === 'tool-result'
          ? `${block.type}:${block.output}`
          : `${block.type}`
    const occurrence = seen.get(signature) ?? 0
    seen.set(signature, occurrence + 1)
    const providerCallId =
      block.type === 'tool-call' && block.callId !== undefined && block.callId.trim().length > 0
        ? block.callId
        : undefined
    const lineIdentity = providerCallId !== undefined ? `call:${providerCallId}` : `${signature}:${occurrence}` // i18n-ignore
    out.push({
      kind: 'line',
      key: lineIdentity,
      block,
      result: block.type === 'tool-call' ? pairing.value.resultByCall.get(block) : undefined,
      disclosureKey: props.disclosureId === undefined ? undefined : `line:${props.disclosureId}:${lineIdentity}` // i18n-ignore
    })
  })
  return out
})

function diffRevealSignal(edit, fileIndex) {
  const reveal = props.revealedDiff
  return reveal?.editKey === edit.key && reveal.fileIndex === fileIndex ? reveal.requestId : undefined
}

function diffDisclosureKey(edit, fileIndex) {
  return props.disclosureId === undefined ? undefined : `diff:${props.disclosureId}:${edit.key}:${fileIndex}` // i18n-ignore
}
</script>

<template>
  <div v-if="standaloneOnly ? hasStandaloneRows : true" class="nc-tool-run">
    <NativeChatSubagentRun v-for="group in subagentRows" :key="group.groupId" :block="group" />
    <NativeChatBackgroundTaskRun v-for="task in backgroundTasks" :key="task.taskId" :block="task" />
    <template v-if="!standaloneOnly">
      <NativeChatAwaitingInputRow
        v-if="hasAskCall"
        :subject="askSubject"
        :pending="askIsActive"
        :disclosure-key="disclosureId === undefined ? undefined : `ask:${disclosureId}`"
      />
      <!-- One element for the run's whole life. Live and settled are states of
           this button, not two buttons: a header that remounted as a call
           started and again as it ended lost its hover, its mark, and its count. -->
      <button
        v-if="showsHeader"
        type="button"
        class="nc-tool-run__header"
        :aria-expanded="open ? 'true' : 'false'"
        aria-live="polite"
        :data-native-chat-tool-run-state="live ? 'live' : 'settled'"
        @click="setOpen(!open)"
      >
        <NativeChatToolRunIcon
          v-if="structuredActivityUi && settledHeaderIcon"
          :icon-name="settledHeaderIcon"
          class="nc-tool-run__glyph"
        />
        <!-- The run in words, in the transcript's own type. Present tense while
             live, past once settled; while live it keeps its width and the
             preview beside it is what gives way. -->
        <span :class="['nc-tool-run__label', live ? 'nc-tool-run__label--live nc-animate-pulse' : 'nc-tool-run__label--settled']">{{
          headerLabel
        }}</span>
        <!-- Outside the truncating label, so the one thing the reader cannot
             afford to miss survives a narrow pane. Quiet text, not a tint. -->
        <span v-if="outcome.failedCallCount > 0" :aria-label="failedLabel" class="nc-tool-run__count">{{ failedText }}</span>
        <span v-if="!live && stoppedCallCount > 0" class="nc-tool-run__count" data-native-chat-tool-state="stopped">{{
          stoppedText
        }}</span>
        <Check v-if="showsCheck" aria-hidden="true" class="nc-tool-run__check" />
        <span v-if="latestCallLabel" class="nc-tool-run__latest">{{ latestCallLabel }}</span>
        <ChevronRight
          :class="['nc-tool-run__chevron', open ? 'nc-tool-run__chevron--open' : 'nc-tool-run__chevron--hover-reveal']"
        />
      </button>
      <!-- Members are indented under the header because nothing else marks the
           run's extent: flush rows would have no visible end. -->
      <div v-if="open && showsHeader" class="nc-tool-run__members">
        <template v-for="member in members" :key="member.key">
          <NativeChatTaskList
            v-if="member.kind === 'tasks'"
            :list="member.taskList.list"
            :previous="member.taskList.previous"
          />
          <div v-else-if="member.kind === 'edit'">
            <NativeChatDiffCard
              v-for="(file, fileIndex) in member.edit.files"
              :key="`${member.edit.key}:${fileIndex}`"
              :file="file"
              :reveal-signal="diffRevealSignal(member.edit, fileIndex)"
              :on-reveal="onRevealDiff"
              :initially-expanded="expandToolLines"
              :disclosure-key="diffDisclosureKey(member.edit, fileIndex)"
            />
          </div>
          <NativeChatToolLine
            v-else
            :block="member.block"
            :result="member.result"
            :on-link-click="onLinkClick"
            :initially-expanded="expandToolLines"
            :disclosure-key="member.disclosureKey"
          />
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Extra top margin sets the tool run apart from the assistant prose above it. */
.nc-tool-run {
  margin-top: 12px;
}
/* group/tool-run flex min-h-6 w-full items-center gap-1.5 rounded-md py-0.5 text-left */
.nc-tool-run__header {
  box-sizing: border-box;
  display: flex;
  min-height: 24px;
  width: 100%;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 2px 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.nc-tool-run__header:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--nc-ring) 70%, transparent);
}
.nc-tool-run__glyph {
  color: var(--nc-muted-foreground);
}
/* truncate text-sm leading-relaxed transition-colors */
.nc-tool-run__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 1.625;
  transition: color 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
/* max-w-[72%] shrink-0 animate-pulse text-foreground/85 motion-reduce:animate-none */
.nc-tool-run__label--live {
  max-width: 72%;
  flex-shrink: 0;
  color: color-mix(in srgb, var(--nc-foreground) 85%, transparent);
}
/* min-w-0 text-muted-foreground group-hover/tool-run:text-foreground/80 */
.nc-tool-run__label--settled {
  min-width: 0;
  color: var(--nc-muted-foreground);
}
.nc-tool-run__header:hover .nc-tool-run__label--settled,
.nc-tool-run__header:hover .nc-tool-run__count {
  color: color-mix(in srgb, var(--nc-foreground) 80%, transparent);
}
/* shrink-0 font-mono text-[11px] text-muted-foreground transition-colors */
.nc-tool-run__count {
  flex-shrink: 0;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  color: var(--nc-muted-foreground);
  transition: color 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
/* size-3 shrink-0 text-muted-foreground */
.nc-tool-run__check {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
}
/* min-w-0 truncate font-mono text-[11px] text-muted-foreground */
.nc-tool-run__latest {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
.nc-tool-run__chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
  transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-tool-run__chevron--open {
  transform: rotate(90deg);
  opacity: 1;
}
.nc-tool-run__chevron--hover-reveal {
  opacity: 0;
}
.nc-tool-run__header:hover .nc-tool-run__chevron--hover-reveal {
  opacity: 1;
}
/* mt-1 pl-4 */
.nc-tool-run__members {
  margin-top: 4px;
  padding-left: 16px;
}
</style>
