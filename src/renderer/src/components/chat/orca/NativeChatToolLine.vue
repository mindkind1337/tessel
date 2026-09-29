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
 */
import { computed } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { isToolCallBlock, isToolResultBlock } from '../../../chat/orca/shared/native-chat-types.js'
import { diffFromText, diffFromToolCall } from '../../../chat/orca/native-chat-diff.js'
import { createToolInputDisplay, truncateToolDetail } from '../../../chat/orca/native-chat-tool-summary.js'
import { useNativeChatDisclosure } from '../../../chat/orca/composables/native-chat-disclosure-store.js'
import { maskToolInput } from '../../../chat/orca/lib/native-chat-tool-secrets.js'
import { isStoppedToolCall } from '../../../chat/orca/lib/native-chat-tool-stopped.js'
import NativeChatToolIcon from './NativeChatToolIcon.vue'
import NativeChatToolName from './NativeChatToolName.vue'
import NativeChatCommandMetadata from './NativeChatCommandMetadata.vue'
import NativeChatSearchResults from './NativeChatSearchResults.vue'
import NativeChatDiffView from './NativeChatDiffView.vue'

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
const hasDetail = computed(
  () => diff.value !== null || body.value !== null || (inputDisplay.value?.hasDetail ?? false) || hasResults.value
)
const stopped = computed(() => isStoppedToolCall(props.block))
const stoppedText = computed(() => t('chat.orca.tool.stopped', 'Stopped'))

function toggle() {
  if (hasDetail.value) setExpanded(!expanded.value)
}
</script>

<template>
  <div v-if="isCall || isResult">
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
      <span v-if="preview" class="nc-tool-line__preview" :title="preview">{{ preview }}</span>
      <NativeChatCommandMetadata v-if="isCall" :block="block" />
      <span v-if="stopped" class="nc-tool-line__stopped" data-native-chat-tool-state="stopped">{{ stoppedText }}</span>
      <!-- Revealed on hover of this row alone, never of the message around it. -->
      <ChevronRight
        v-if="hasDetail"
        :class="['nc-tool-line__chevron', expanded ? 'nc-tool-line__chevron--open' : 'nc-tool-line__chevron--hover-reveal']"
      />
    </button>
    <div v-if="hasDetail && expanded" class="nc-tool-line__detail">
      <NativeChatSearchResults v-if="isCall && hasResults" :results="block.webSearchResults" :on-link-click="onLinkClick" />
      <NativeChatDiffView v-if="diff" :lines="diff" />
      <pre v-if="!diff && detail" class="nc-tool-line__pre nc-scrollbar-sleek">{{ detail }}</pre>
      <pre
        v-if="body"
        :class="['nc-tool-line__pre', 'nc-scrollbar-sleek', body.isError ? 'nc-tool-line__pre--error' : null]"
      >{{ truncateToolDetail(body.output) }}</pre>
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
