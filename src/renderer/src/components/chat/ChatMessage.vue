<script setup>
// One row of a chat that is not a tool or an approval: the user's message
// (or a teammate's, set apart), the agent's text as Markdown (sanitized by
// markdownView.js), its thinking (folded), a notice, the end of a turn.
// Look after Orca's NativeChatMessageRow.tsx (MIT, Copyright (c) 2026
// Lovecast Inc.), written for Vue.
import { computed, ref } from 'vue'
import { Brain, ChevronRight, Clock, Users } from 'lucide-vue-next'
import { renderMarkdown } from '../../markdownView'
import { t, intlLocale } from '../../i18n'

const props = defineProps({
  row: { type: Object, required: true }
})

const thinkingOpen = ref(false)

const html = computed(() => (props.row.kind === 'assistant' ? renderMarkdown(props.row.text, { untrusted: true }) : ''))

const fromLabel = computed(() => {
  const from = String(props.row.from || '').trim()
  const who = /^\d+$/.test(from) ? `#${from}` : from
  return who ? t('chat.user.fromTeammate', 'From {{from}} (teammate)', { from: who }) : t('chat.user.fromTeam', 'From a teammate')
})

const statusChip = computed(() => {
  const r = props.row
  if (r.kind !== 'user') return ''
  if (r.status === 'queued')
    return r.origin === 'team'
      ? t('chat.user.teamQueued', 'Waiting: delivered when the turn ends')
      : t('chat.user.queued', 'Queued: will send when the turn ends')
  if (r.status === 'failed') return t('chat.user.failed', 'Not sent')
  return ''
})

const atTitle = computed(() => {
  const at = props.row.at
  if (!at) return undefined
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' })
})

function seconds(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return t('chat.turn.seconds', '{{n}} s', { n: s })
  return t('chat.turn.minutes', '{{m}} min {{s}} s', { m: Math.floor(s / 60), s: s % 60 })
}
const turnText = computed(() => {
  const r = props.row
  if (r.kind !== 'turn') return ''
  if (r.status === 'interrupted') return t('chat.turn.interrupted', 'Interrupted')
  if (r.status === 'failed') return r.error ? t('chat.turn.failedWith', 'Failed: {{error}}', { error: r.error }) : t('chat.turn.failed', 'Failed')
  return r.durationMs != null ? t('chat.turn.doneIn', 'Done in {{time}}', { time: seconds(r.durationMs) }) : t('chat.turn.done', 'Done')
})

// Links: the web opens outside; nothing navigates the window.
function onBodyClick(e) {
  const a = e.target.closest && e.target.closest('a[href]')
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href') || ''
  const api = window.shellApi
  if (/^(https?:|mailto:)/i.test(href) && api && typeof api.openExternal === 'function') api.openExternal(href)
}
</script>

<template>
  <div v-if="row.kind === 'user'" class="chat-row chat-user" :class="['origin-' + row.origin, 'st-' + row.status]" data-test="chat-user">
    <div v-if="row.origin === 'team'" class="chat-team-from" data-test="chat-team-from">
      <Users :size="12" aria-hidden="true" />
      {{ fromLabel }}
    </div>
    <div class="chat-bubble" :title="atTitle">{{ row.text }}</div>
    <div v-if="statusChip" class="chat-chip" :class="{ err: row.status === 'failed' }" data-test="chat-user-status">
      <Clock v-if="row.status === 'queued'" :size="11" aria-hidden="true" />
      {{ statusChip }}
    </div>
  </div>

  <div v-else-if="row.kind === 'assistant'" class="chat-row chat-assistant" :class="{ streaming: row.streaming }" data-test="chat-assistant" @click="onBodyClick">
    <!-- eslint-disable-next-line vue/no-v-html (sanitized by DOMPurify, markdownView.js) -->
    <div class="fview-md chat-md" v-html="html"></div>
  </div>

  <div v-else-if="row.kind === 'thinking'" class="chat-row chat-thinking" data-test="chat-thinking">
    <button type="button" class="chat-thinking-btn" :aria-expanded="thinkingOpen" @click="thinkingOpen = !thinkingOpen">
      <ChevronRight :size="13" class="chat-thinking-chevron" :class="{ open: thinkingOpen }" aria-hidden="true" />
      <Brain :size="13" aria-hidden="true" />
      {{ t('chat.thinking', 'Thinking') }}
    </button>
    <div v-if="thinkingOpen" class="chat-thinking-text">{{ row.text }}</div>
  </div>

  <div v-else-if="row.kind === 'notice'" class="chat-row chat-notice" :class="'lv-' + row.level" data-test="chat-notice">{{ row.text }}</div>

  <div v-else-if="row.kind === 'turn'" class="chat-row chat-turn" :class="'st-' + row.status" data-test="chat-turn">
    <span class="chat-turn-text">{{ turnText }}</span>
  </div>
</template>

<style scoped>
.chat-row {
  min-width: 0;
}

.chat-user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  margin: 6px 0;
}

.chat-bubble {
  max-width: 85%;
  padding: 7px 11px;
  border-radius: 9px 9px 3px 9px;
  background: var(--surface-3);
  color: var(--text-strong);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.origin-team {
  align-items: flex-start;
}

.origin-team .chat-bubble {
  border: 1px dashed var(--border-strong);
  border-radius: 9px 9px 9px 3px;
  background: var(--surface);
  color: var(--text);
}

.chat-team-from {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
}

.chat-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 9px;
  background: var(--surface-2);
  color: var(--text-dim);
  font-size: 10.5px;
}

.chat-chip.err {
  color: var(--danger);
}

.st-queued .chat-bubble {
  opacity: 0.7;
}

.chat-assistant {
  margin: 4px 0;
}

/* The model's markdown stays inside its own box (never over the interface). */
.chat-md {
  position: relative;
  contain: paint;
  overflow: hidden;
  max-width: none;
  margin: 0;
  padding: 0;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
}

.chat-md :deep(> :first-child) {
  margin-top: 0;
}

.chat-md :deep(> :last-child) {
  margin-bottom: 0;
}

.chat-md :deep(p) {
  margin: 0.45em 0;
}

.chat-md :deep(pre) {
  padding: 8px 10px;
  font-size: 12px;
}

.chat-md :deep(h1),
.chat-md :deep(h2) {
  font-size: 1.15em;
}

.chat-md :deep(h3),
.chat-md :deep(h4) {
  font-size: 1.05em;
}

.streaming .chat-md :deep(> :last-child)::after {
  content: '▍';
  margin-left: 2px;
  color: var(--text-dim);
  animation: chat-blink 1s steps(1) infinite;
}

@keyframes chat-blink {
  50% {
    opacity: 0;
  }
}

.chat-thinking-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  font-style: italic;
  cursor: pointer;
}

.chat-thinking-btn:hover {
  background: var(--surface-2);
}

.chat-thinking-chevron {
  transition: transform 0.12s ease;
}

.chat-thinking-chevron.open {
  transform: rotate(90deg);
}

.chat-thinking-text {
  margin: 2px 0 4px 22px;
  padding-left: 8px;
  border-left: 2px solid var(--border);
  color: var(--text-dim);
  font-size: 12px;
  font-style: italic;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-notice {
  margin: 4px 0;
  padding: 5px 9px;
  border-radius: 5px;
  background: var(--surface-2);
  color: var(--text-dim);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-notice.lv-error {
  background: color-mix(in srgb, var(--danger) 12%, var(--surface));
  color: var(--danger);
}

.chat-turn {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 10px;
  color: var(--text-dim);
  font-size: 10.5px;
}

.chat-turn::before,
.chat-turn::after {
  content: '';
  flex: 1 1 auto;
  height: 1px;
  background: var(--border);
}

.chat-turn.st-failed {
  color: var(--danger);
}

.chat-turn.st-interrupted {
  color: var(--warn);
}

.chat-turn-text {
  flex: 0 1 auto;
  max-width: 80%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
