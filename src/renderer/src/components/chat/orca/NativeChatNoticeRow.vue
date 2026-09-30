<script setup>
// After Orca's NativeChatNoticeRow.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * A status notice in the transcript: compaction separator, plan card, or a
 * toned notice (warning / error / notice; other tones render as plain text).
 * Props: block (the notice's text block), onLinkClick ((event, href); links in
 *   a plan), allowFileUriLinks.
 * Tessel: an error notice (a failed turn's error, an error event) is shown
 * whole, wrapped, and can be copied (no Copy button without the clipboard
 * bridge). Notice text is text, never HTML; only a plan goes through
 * ChatMarkdown.
 */
import { computed, inject } from 'vue'
import { AlertCircle, AlertTriangle, Info } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { Card, CardContent, CardHeader, CardTitle } from './ui'
import ChatMarkdown from './ChatMarkdown.vue'
import NativeChatCopyButton from './NativeChatCopyButton.vue'
import ProviderFrameRow from './ProviderFrameRow.vue'

const props = defineProps({
  block: { type: Object, required: true },
  onLinkClick: { type: Function, default: undefined },
  allowFileUriLinks: { type: Boolean, default: false }
})

const compactionLabel = computed(() => t('chat.orca.notices.compaction', 'Context compacted'))
const planTitle = computed(() => t('chat.orca.notices.plan', 'Plan'))
const detailsLabel = computed(() => t('chat.orca.notices.details', 'Details'))
const copyErrorLabel = computed(() => t('chat.error.copyLabel', 'Copy the error text'))
// Tessel: a notice can offer a way out (block.action), done by the pane.
const onAction = inject('chatNoticeAction', null)
const actionLabel = computed(() => (props.block.action === 'newConversation' ? t('chat.notice.newConversation', 'New conversation') : ''))

const tone = computed(() => props.block.tone)
const icon = computed(() =>
  tone.value === 'warning'
    ? AlertTriangle
    : tone.value === 'error'
      ? AlertCircle
      : tone.value === 'notice'
        ? Info
        : null
)
</script>

<template>
  <div
    v-if="block.presentation === 'compaction'"
    role="separator"
    :aria-label="compactionLabel"
    class="nc-notice-separator"
  >
    <span class="nc-notice-rule" />
    <span>{{ compactionLabel }}</span>
    <span class="nc-notice-rule" />
  </div>

  <Card v-else-if="block.presentation === 'plan-document'" class="nc-notice-plan">
    <CardHeader class="nc-notice-plan-header">
      <CardTitle class="nc-notice-plan-title">{{ planTitle }}</CardTitle>
    </CardHeader>
    <CardContent class="nc-notice-plan-content">
      <ChatMarkdown
        :content="block.text"
        variant="document"
        class="nc-notice-markdown"
        :on-link-click="onLinkClick"
        :allow-file-uri-links="allowFileUriLinks"
        :linkify-file-paths="onLinkClick !== undefined"
      />
    </CardContent>
  </Card>

  <div
    v-else
    class="nc-notice"
    :class="[icon ? 'nc-notice-boxed' : null, tone ? `nc-tone-${tone}` : null]"
    data-test="nc-notice"
  >
    <div class="nc-notice-line">
      <component :is="icon" v-if="icon" aria-hidden="true" class="nc-notice-icon" />
      <p class="nc-notice-text">{{ block.text }}</p>
      <NativeChatCopyButton
        v-if="tone === 'error'"
        :text="block.text"
        :label="copyErrorLabel"
        class="nc-notice-copy"
        data-test="nc-copy-error"
      />
    </div>
    <div v-if="actionLabel && onAction" class="nc-notice-actions">
      <button type="button" class="exit-btn primary" data-test="nc-notice-action" @click="onAction(block.action)">{{ actionLabel }}</button>
    </div>
    <ProviderFrameRow v-if="block.providerFrame" :block="block" :summary="detailsLabel" />
  </div>
</template>

<style scoped>
.nc-notice-actions {
  margin-top: 8px;
}
.nc-notice-separator {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
.nc-notice-rule {
  height: 1px;
  flex: 1 1 0%;
  background: var(--nc-border);
}
.nc-notice-plan {
  gap: 12px;
  padding-top: 12px;
  padding-bottom: 12px;
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
}
.nc-notice-plan-header {
  padding-left: 16px;
  padding-right: 16px;
}
.nc-notice-plan-title {
  font-size: 14px;
  line-height: 20px;
}
.nc-notice-plan-content {
  padding-left: 16px;
  padding-right: 16px;
  font-size: 14px;
  line-height: 1.625;
  color: var(--nc-foreground);
}
.nc-notice-markdown {
  font-size: 14px;
}
.nc-notice {
  font-size: 14px;
  line-height: 20px;
  color: var(--nc-foreground);
}
.nc-notice > * + * {
  margin-top: 8px;
}
.nc-notice-boxed {
  border-radius: 6px;
  border: 1px solid var(--nc-border);
  background: color-mix(in srgb, var(--nc-muted) 20%, transparent);
  padding: 12px;
}
.nc-tone-warning {
  color: var(--nc-warning, #f59e0b);
}
.nc-tone-error {
  color: var(--nc-destructive);
}
.nc-tone-notice {
  color: var(--nc-muted-foreground);
}
.nc-notice-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.nc-notice-icon {
  margin-top: 2px;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.nc-notice-text {
  margin: 0;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  user-select: text;
}
.nc-notice-copy {
  margin-left: auto;
  margin-top: -2px;
}
</style>
