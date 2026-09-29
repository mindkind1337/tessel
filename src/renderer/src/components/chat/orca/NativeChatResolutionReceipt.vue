<script setup>
// After Orca's NativeChatResolutionReceipt.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// What an answered (or cancelled) approval or question left in the
// transcript: its title, the detail, the chosen answer, who answered and
// when. A pending question is its "awaiting input" row; a pending approval
// shows nothing here (its card asks).
// Props: body (the approval / question journal body), disclosureId (the
//   message it stands in for; keys the question row's disclosure).
// Tessel's approval options are ids with English labels (data): shown
// through t() here, never translated in the data.
import { computed } from 'vue'
import { t } from '../../../i18n'
import NativeChatMessageTimestamp from './NativeChatMessageTimestamp.vue'
import NativeChatAwaitingInputRow from './NativeChatAwaitingInputRow.vue'
import { nativeChatReceiptAnswers } from '../../../chat/orca/native-chat-resolution-receipt.js'

const props = defineProps({
  body: { type: Object, required: true },
  disclosureId: { type: String, default: undefined }
})

const askDisclosureKey = computed(() => (props.disclosureId === undefined ? undefined : `ask:${props.disclosureId}`)) // i18n-ignore
const subject = computed(() => {
  const body = props.body
  if (body.kind !== 'question') return null
  if (body.questions && body.questions.length > 1) return { kind: 'count', count: body.questions.length }
  // Claude keeps a generic grouped label for a single multi-select question.
  // Use it after resolution so the answer's question line is not repeated
  // in the heading.
  return {
    kind: 'question',
    text:
      body.resolution.state !== 'pending' && body.questions?.length === 1 && body.questions[0]?.question !== body.question
        ? body.question
        : (body.questions?.[0]?.question ?? body.question)
  }
})
const pending = computed(() => props.body.resolution.state === 'pending')
const resolution = computed(() => props.body.resolution)
const title = computed(() => (props.body.kind === 'approval' ? (props.body.displayName ?? props.body.title) : props.body.question))

// Tessel's approval choices, worded at display time.
const TESSEL_OPTION_LABEL = {
  allow: () => t('chat.approval.allow', 'Allow'),
  allowSession: () => t('chat.approval.allowSessionButton', 'Allow for this session'),
  deny: () => t('chat.approval.deny', 'Deny')
}
const answers = computed(() => {
  const list = nativeChatReceiptAnswers(props.body)
  const body = props.body
  if (body.kind !== 'approval' || !body.tessel) return list
  const word = TESSEL_OPTION_LABEL[body.resolution.selectedOptionId]
  return word ? list.map((a) => (a.answer === null ? a : { ...a, answer: word() })) : list
})
function answerKey(index) {
  return props.body.kind === 'question' ? (props.body.questions?.[index]?.id ?? 'answer') : 'answer'
}
function showQuestion(answer) {
  if (!answer.question) return false
  const body = props.body
  return !(body.kind === 'question' && body.questions?.length === 1 && subject.value?.kind === 'question' && answer.question === subject.value.text)
}
const stateText = computed(() =>
  resolution.value.state === 'cancelled' ? t('chat.orca.receipt.cancelled', 'Cancelled') : t('chat.orca.receipt.resolved', 'Resolved')
)
const resolverText = computed(() =>
  resolution.value.state === 'cancelled'
    ? t('chat.orca.receipt.cancelledBy', 'Cancelled on {{device}}', { device: resolution.value.resolvedBy })
    : t('chat.orca.receipt.resolver', 'Answered on {{device}}', { device: resolution.value.resolvedBy })
)
// Tessel answers on this computer ('local'): no "Answered on local".
const showResolver = computed(() => !!resolution.value.resolvedBy && resolution.value.resolvedBy !== 'local')
</script>

<template>
  <template v-if="pending">
    <NativeChatAwaitingInputRow v-if="body.kind === 'question'" :subject="subject" pending :disclosure-key="askDisclosureKey" />
  </template>
  <div v-else class="nc-receipt" :data-native-chat-receipt="body.kind">
    <NativeChatAwaitingInputRow v-if="body.kind === 'question'" :pending="false" :subject="subject" :disclosure-key="askDisclosureKey" />
    <div v-else class="nc-receipt-title">{{ title }}</div>
    <p v-if="body.kind === 'approval' && body.detail" class="nc-receipt-clamp">{{ body.detail }}</p>
    <div v-for="(answer, index) in answers" :key="answerKey(index)">
      <p v-if="showQuestion(answer)" class="nc-receipt-p">{{ answer.question }}</p>
      <p class="nc-receipt-clamp">{{ answer.answer ?? t('chat.orca.receipt.unavailable', 'Selected answer unavailable') }}</p>
    </div>
    <div class="nc-receipt-meta">
      <span>{{ stateText }}</span>
      <span v-if="showResolver">{{ resolverText }}</span>
      <NativeChatMessageTimestamp :timestamp="resolution.resolvedAt ?? null" />
    </div>
  </div>
</template>

<style scoped>
/* space-y-1 border-l border-border pl-3 text-xs text-muted-foreground */
.nc-receipt {
  padding-left: 12px;
  border-left: 1px solid var(--nc-border);
  color: var(--nc-muted-foreground);
  font-size: 12px;
  line-height: 16px;
}
.nc-receipt > * + * {
  margin-top: 4px;
}
.nc-receipt-title {
  font-weight: 500;
}
.nc-receipt-p {
  margin: 0;
}
/* line-clamp-3 whitespace-pre-wrap break-words */
.nc-receipt-clamp {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  overflow-wrap: break-word;
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
}
/* flex flex-wrap items-center gap-x-2 gap-y-1 */
.nc-receipt-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
</style>
