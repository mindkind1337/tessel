<script setup>
// One tool call in a chat: a flat line ("▸ Read src/x.js") that opens in
// place to show the input and the clipped output, always as plain text
// (never HTML). After Orca's NativeChatToolLine.tsx (MIT, Copyright (c)
// 2026 Lovecast Inc.), written for Vue.
import { computed, ref } from 'vue'
import { ChevronRight, Loader2, TriangleAlert, Wrench } from 'lucide-vue-next'
import { formatInput, truncate, MAX_DETAIL } from '../../chat/chatModel'
import { t } from '../../i18n'

const props = defineProps({
  row: { type: Object, required: true }
})

const expanded = ref(false)

const name = computed(() => props.row.name || t('chat.tool.result', 'Result'))
// The summary starts with the tool's name; the rest is its argument.
const arg = computed(() => {
  const summary = props.row.summary || ''
  const n = props.row.name || ''
  if (n && summary.startsWith(n)) return summary.slice(n.length).replace(/^:?\s*/, '')
  return n ? summary : ''
})
const inputText = computed(() => (expanded.value ? formatInput(props.row.input) : ''))
const resultText = computed(() => (expanded.value && props.row.result ? truncate(props.row.result.text, MAX_DETAIL) : ''))
const hasDetail = computed(() => props.row.input != null || !!(props.row.result && props.row.result.text))
const statusText = computed(() => {
  if (props.row.status === 'running') return t('chat.tool.running', 'Running…')
  if (props.row.status === 'error') return t('chat.tool.failed', 'Failed')
  return ''
})

function toggle() {
  if (hasDetail.value) expanded.value = !expanded.value
}
</script>

<template>
  <div class="chat-tool" :class="['st-' + row.status, { open: expanded }]" data-test="chat-tool">
    <button
      type="button"
      class="chat-tool-line"
      :aria-expanded="hasDetail ? expanded : undefined"
      :title="row.summary || name"
      @click="toggle"
    >
      <ChevronRight :size="13" class="chat-tool-chevron" :class="{ hidden: !hasDetail }" aria-hidden="true" />
      <Loader2 v-if="row.status === 'running'" :size="13" class="chat-tool-icon spin" aria-hidden="true" />
      <TriangleAlert v-else-if="row.status === 'error'" :size="13" class="chat-tool-icon err" aria-hidden="true" />
      <Wrench v-else :size="13" class="chat-tool-icon" aria-hidden="true" />
      <code class="chat-tool-name">{{ name }}</code>
      <span v-if="arg" class="chat-tool-arg">{{ arg }}</span>
      <span v-if="statusText" class="chat-tool-status">{{ statusText }}</span>
    </button>
    <div v-if="expanded" class="chat-tool-detail">
      <div v-if="inputText" class="chat-tool-label">{{ t('chat.tool.input', 'Input') }}</div>
      <pre v-if="inputText" class="chat-pre" data-test="chat-tool-input">{{ inputText }}</pre>
      <div v-if="resultText" class="chat-tool-label">{{ row.result.isError ? t('chat.tool.error', 'Error') : t('chat.tool.output', 'Output') }}</div>
      <pre v-if="resultText" class="chat-pre" :class="{ err: row.result.isError }" data-test="chat-tool-output">{{ resultText }}</pre>
    </div>
  </div>
</template>

<style scoped>
.chat-tool {
  min-width: 0;
}

.chat-tool-line {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-width: 0;
  padding: 2px 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.chat-tool-line:hover {
  background: var(--surface-2);
  color: var(--text);
}

.chat-tool-chevron {
  flex: 0 0 auto;
  transition: transform 0.12s ease;
}

.chat-tool-chevron.hidden {
  visibility: hidden;
}

.chat-tool.open .chat-tool-chevron {
  transform: rotate(90deg);
}

.chat-tool-icon {
  flex: 0 0 auto;
  opacity: 0.8;
}

.chat-tool-icon.err {
  color: var(--danger);
}

.spin {
  animation: chat-spin 1s linear infinite;
}

@keyframes chat-spin {
  to {
    transform: rotate(360deg);
  }
}

.chat-tool-name {
  flex: 0 0 auto;
  color: var(--text);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11.5px;
  font-weight: 600;
}

.chat-tool-arg {
  min-width: 0;
  overflow: hidden;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.chat-tool-status {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: 11px;
}

.st-error .chat-tool-status {
  color: var(--danger);
}

.chat-tool-detail {
  padding: 2px 0 6px 22px;
}

.chat-tool-label {
  margin: 4px 0 2px;
  color: var(--text-dim);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.chat-pre {
  max-height: 260px;
  margin: 0;
  padding: 6px 8px;
  overflow: auto;
  border-radius: 5px;
  background: var(--surface-2);
  color: var(--text);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-pre.err {
  color: var(--danger);
}
</style>
