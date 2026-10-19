<script setup>
// After Orca's NativeChatToolLine.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * A single inline tool line — `▸ ToolName  preview` — that expands in place to
 * show the call's diff/input or the result's body. Tool calls read as flat
 * lines in the conversation rather than boxed blocks. Lines only mount while
 * the parent run is open and are individually collapsible. Everything is text
 * (never HTML).
 *
 * Props: block (a tool-call or tool-result block), result (the call's paired
 *   output, drawn here rather than as a `Result` row of its own),
 *   initiallyExpanded (true), disclosureKey, onLinkClick(event, url).
 * Tessel: the preview and the input detail are cut from an input masked with
 *   maskSecrets first; a call the agent's stop cut short says "Stopped".
 *   A file tool's path (Read, Edit, Write…, every agent's: chat/agentEdits.js)
 *   opens its file at the line it read or first changed; an edit also opens
 *   its diff in an editor tab (use-agent-edit-actions.js).
 *   The images its result carries (a screenshot, an image file it read:
 *   the result block's images / imagesMore) show under its output as
 *   thumbnails, one viewer for them all (NativeChatImageAttachments).
 */
import { computed } from 'vue'
import { ChevronRight, ExternalLink, GitCompareArrows } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { isToolCallBlock, isToolResultBlock } from '../../../chat/orca/shared/native-chat-types.js'
import { diffFromText, diffFromToolCall } from '../../../chat/orca/native-chat-diff.js'
import { createToolInputDisplay, truncateToolDetail } from '../../../chat/orca/native-chat-tool-summary.js'
import { useNativeChatDisclosure } from '../../../chat/orca/composables/native-chat-disclosure-store.js'
import { maskToolInput } from '../../../chat/orca/lib/native-chat-tool-secrets.js'
import { isStoppedToolCall } from '../../../chat/orca/lib/native-chat-tool-stopped.js'
import { editSteps, toolFileTarget } from '../../../chat/agentEdits.js'
import { useAgentEditActions } from '../../../chat/orca/composables/use-agent-edit-actions.js'
import NativeChatToolIcon from './NativeChatToolIcon.vue'
import NativeChatToolName from './NativeChatToolName.vue'
import NativeChatCommandMetadata from './NativeChatCommandMetadata.vue'
import NativeChatSearchResults from './NativeChatSearchResults.vue'
import NativeChatDiffView from './NativeChatDiffView.vue'
import NativeChatImageAttachments from './NativeChatImageAttachments.vue'

const props = defineProps({
  block: { type: Object, required: true },
  result: { type: Object, default: undefined },
  initiallyExpanded: { type: Boolean, default: true },
  disclosureKey: { type: String, default: undefined },
  onLinkClick: { type: Function, default: undefined }
})

const { open: expanded, setOpen: setExpanded } = useNativeChatDisclosure(
  () => props.disclosureKey,
  () => props.initiallyExpanded
)

const isCall = computed(() => isToolCallBlock(props.block))
const isResult = computed(() => !isCall.value && isToolResultBlock(props.block))
// The input as it may be shown: secrets masked before any label is cut from it.
const inputDisplay = computed(() => (isCall.value ? createToolInputDisplay(maskToolInput(props.block.input)) : null))

const name = computed(() => (isCall.value ? props.block.name : t('chat.orca.tool.result', 'Result')))
const preview = computed(() => {
  if (isCall.value) return inputDisplay.value.label
  if (isResult.value) return props.block.output.split('\n')[0]?.slice(0, 80) ?? ''
  return ''
})
// Diffs show file content, from the raw input (see native-chat-tool-secrets.js).
const diff = computed(() => {
  if (!expanded.value) return null
  if (isCall.value) return diffFromToolCall(props.block.name, props.block.input)
  if (isResult.value) return diffFromText(props.block.output)
  return null
})
const detail = computed(() => (isCall.value && expanded.value && !diff.value ? inputDisplay.value.formatDetail() : null))
const body = computed(() => {
  if (isCall.value) return props.result ? { output: props.result.output, isError: props.result.isError } : null
  if (isResult.value) return { output: props.block.output, isError: props.block.isError }
  return null
})
const hasResults = computed(() => isCall.value && (props.block.webSearchResults?.length ?? 0) > 0)
// Tessel: the result's images (image-ref blocks) and how many it left out.
const resultBlock = computed(() => (isCall.value ? props.result : isResult.value ? props.block : null))
const images = computed(() => (Array.isArray(resultBlock.value?.images) ? resultBlock.value.images : []))
const imagesMore = computed(() => (Number.isSafeInteger(resultBlock.value?.imagesMore) ? resultBlock.value.imagesMore : 0))
const hasImages = computed(() => images.value.length > 0 || imagesMore.value > 0)
// A result that is only images shows no empty text box.
const showBody = computed(() => body.value !== null && (Boolean(body.value.output) || !hasImages.value))
const hasDetail = computed(
  () => diff.value !== null || body.value !== null || (inputDisplay.value?.hasDetail ?? false) || hasResults.value || hasImages.value
)
const stopped = computed(() => isStoppedToolCall(props.block))
const stoppedText = computed(() => t('chat.orca.tool.stopped', 'Stopped'))

function toggle() {
  if (hasDetail.value) setExpanded(!expanded.value)
}

// Tessel: the file this call names, as a link (header actions; the body below
// is the call's detail and images).
const edits = useAgentEditActions()
const fileTarget = computed(() => (isCall.value ? toolFileTarget(props.block) : null))
const openablePath = computed(() =>
  fileTarget.value && edits.canOpen.value ? edits.pathOf(props.block, fileTarget.value.path) : null
)
const fileEdits = computed(() => [{ block: props.block, resultText: props.result?.output || '' }])
const diffable = computed(
  () =>
    !!openablePath.value &&
    fileTarget.value.edit &&
    edits.canDiff.value &&
    !props.result?.isError &&
    !!editSteps(props.block, null, props.result?.output || '')
)
const openTitle = computed(() =>
  fileTarget.value?.line
    ? t('chat.agentEdits.openAtLine', 'Open {{path}} at line {{line}}', { path: fileTarget.value.path, line: fileTarget.value.line })
    : t('chat.agentEdits.open', 'Open {{path}}', { path: fileTarget.value?.path || '' })
)
const diffTitle = computed(() => t('chat.agentEdits.openDiff', 'Open diff'))
function openFile(event) {
  void edits.openAt({ path: fileTarget.value.path, edits: fileEdits.value, line: fileTarget.value.line }, event)
}
function openDiff() {
  void edits.openDiff({ path: fileTarget.value.path, edits: fileEdits.value })
}
// A click on the path opens the file rather than folding the row.
function onPreviewClick(event) {
  if (!openablePath.value) return
  event.stopPropagation()
  openFile(event)
}
</script>

<template>
  <div v-if="isCall || isResult">
    <div class="nc-tool-line__row">
    <button
      type="button"
      :class="['nc-tool-line', hasDetail ? 'nc-tool-line--toggle' : 'nc-tool-line--static']"
      :aria-expanded="hasDetail ? (expanded ? 'true' : 'false') : undefined"
      @click="toggle"
    >
      <!-- Decorative category glyph; the word beside it is the row's name. A
           result's word is translated copy, not a tool name, so there is no
           category to read from it: the empty slot keeps rows aligned. -->
      <NativeChatToolIcon v-if="isCall" :mcp-identity="block.mcpIdentity" :row-word="name" class="nc-tool-line__glyph" />
      <span v-else aria-hidden="true" class="nc-tool-line__glyph-slot" />
      <code class="nc-tool-line__name"><NativeChatToolName
          v-if="isCall"
          :name="name"
          :mcp-identity="block.mcpIdentity"
        /><template v-else>{{ name }}</template></code>
      <span
        v-if="preview"
        :class="['nc-tool-line__preview', openablePath ? 'nc-tool-line__preview--link' : null]"
        :title="openablePath ? openTitle : preview"
        :data-test="openablePath ? 'tool-path-link' : undefined"
        @click="onPreviewClick"
      >{{ preview }}</span>
      <NativeChatCommandMetadata v-if="isCall" :block="block" />
      <span v-if="stopped" class="nc-tool-line__stopped" data-native-chat-tool-state="stopped">{{ stoppedText }}</span>
      <!-- Revealed on hover of this row alone, never of the message around it. -->
      <ChevronRight
        v-if="hasDetail"
        :class="['nc-tool-line__chevron', expanded ? 'nc-tool-line__chevron--open' : 'nc-tool-line__chevron--hover-reveal']"
      />
    </button>
    <!-- Tessel: the file's own actions, beside the row (never inside its
         toggle), revealed on hover or keyboard focus. -->
    <span v-if="openablePath" class="nc-tool-line__actions">
      <button type="button" class="nc-tool-line__action" :title="openTitle" :aria-label="openTitle" data-test="tool-open-file" @click="openFile">
        <ExternalLink aria-hidden="true" />
      </button>
      <button v-if="diffable" type="button" class="nc-tool-line__action" :title="diffTitle" :aria-label="diffTitle" data-test="tool-open-diff" @click="openDiff">
        <GitCompareArrows aria-hidden="true" />
      </button>
    </span>
    </div>
    <div v-if="hasDetail && expanded" class="nc-tool-line__detail">
      <NativeChatSearchResults v-if="isCall && hasResults" :results="block.webSearchResults" :on-link-click="onLinkClick" />
      <NativeChatDiffView v-if="diff" :lines="diff" />
      <pre v-if="!diff && detail" class="nc-tool-line__pre nc-scrollbar-sleek">{{ detail }}</pre>
      <pre
        v-if="showBody"
        :class="['nc-tool-line__pre', 'nc-scrollbar-sleek', body.isError ? 'nc-tool-line__pre--error' : null]"
      >{{ truncateToolDetail(body.output) }}</pre>
      <NativeChatImageAttachments
        v-if="hasImages"
        :blocks="images"
        :more="imagesMore"
        :enable-preview="true"
        :runtime-context="null"
        variant="tool"
      />
    </div>
  </div>
</template>

<style scoped>
/* group/tool-line flex w-full items-center gap-1.5 py-0.5 text-left */
.nc-tool-line {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}
.nc-tool-line--toggle {
  cursor: pointer;
}
.nc-tool-line--static {
  cursor: default;
}
.nc-tool-line__glyph {
  color: var(--nc-muted-foreground);
}
.nc-tool-line__glyph-slot {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
/* min-w-0 truncate font-mono text-xs font-semibold text-foreground/90 group-hover/tool-line:text-foreground */
.nc-tool-line__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 16px;
  font-weight: 600;
  color: color-mix(in srgb, var(--nc-foreground) 90%, transparent);
  transition: color 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-tool-line:hover .nc-tool-line__name {
  color: var(--nc-foreground);
}
/* min-w-0 truncate font-mono text-[11px] text-muted-foreground group-hover/tool-line:text-foreground/70 */
.nc-tool-line__preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  color: var(--nc-muted-foreground);
  transition: color 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-tool-line:hover .nc-tool-line__preview {
  color: color-mix(in srgb, var(--nc-foreground) 70%, transparent);
}
/* Tessel: the row and the file's actions beside its toggle. */
.nc-tool-line__row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.nc-tool-line__row > .nc-tool-line {
  min-width: 0;
  flex: 1 1 auto;
}
.nc-tool-line__preview--link {
  cursor: pointer;
  text-decoration: underline dotted color-mix(in srgb, var(--nc-muted-foreground) 60%, transparent);
  text-underline-offset: 2px;
}
.nc-tool-line__preview--link:hover {
  color: var(--nc-foreground);
  text-decoration-style: solid;
}
.nc-tool-line__actions {
  display: inline-flex;
  flex-shrink: 0;
  gap: 2px;
  opacity: 0;
  transition: opacity 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-tool-line__row:hover .nc-tool-line__actions,
.nc-tool-line__actions:focus-within {
  opacity: 1;
}
.nc-tool-line__action {
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--nc-muted-foreground);
  cursor: pointer;
}
.nc-tool-line__action:hover {
  background: var(--nc-accent);
  color: var(--nc-foreground);
}
.nc-tool-line__action:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--nc-ring) 70%, transparent);
}
.nc-tool-line__action svg {
  width: 13px;
  height: 13px;
}
/* Tessel: same quiet type as the command metadata. */
.nc-tool-line__stopped {
  flex-shrink: 0;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
/* size-3.5 shrink-0 text-muted-foreground transition-all */
.nc-tool-line__chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
  transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-tool-line__chevron--open {
  transform: rotate(90deg);
  opacity: 1;
}
.nc-tool-line__chevron--hover-reveal {
  opacity: 0;
}
.nc-tool-line:hover .nc-tool-line__chevron--hover-reveal {
  opacity: 1;
}
/* space-y-1.5 py-1 */
.nc-tool-line__detail {
  padding: 4px 0;
}
.nc-tool-line__detail > * + * {
  margin-top: 6px;
}
/* max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-accent p-2 font-mono text-[11px] text-foreground/80 */
.nc-tool-line__pre {
  max-height: 256px;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  border-radius: 4px;
  background: var(--nc-accent);
  padding: 8px;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  color: color-mix(in srgb, var(--nc-foreground) 80%, transparent);
}
.nc-tool-line__pre--error {
  color: var(--nc-destructive);
}
</style>
