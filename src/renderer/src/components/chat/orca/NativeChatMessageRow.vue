<script setup>
// After Orca's NativeChatMessageRow.tsx, MessageRow (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * One message: its prose first, then a collapsible run folding all of the
 * turn's tool activity. Monochrome per STYLEGUIDE: user prompts read as a
 * lifted card, assistant prose as body copy, reasoning de-emphasized.
 * Renders nothing for a message with nothing to show, or behind a folded turn.
 *
 * Props: message (NativeChatMessage), previousTodoWrite, previousUpdatePlan,
 *   revealedDiff, expandSignal, activeTurnIsWorking, trailingRun (this row's
 *   tool run is the turn's last, the one still live), onScrollMessageToTop
 *   ((element) => void: align this message's top to the viewport's; also
 *   @scroll-message-to-top), onLinkClick ((event, href); also @link-click),
 *   allowFileUriLinks, deliveryFailed, structuredActivityUi (default true),
 *   folded, runtimeContext (worktree context for image previews; unset = none).
 *
 * Tessel: a teammate's message (sentAs 'team', from) is set apart with its
 * sender; a message that was not delivered says "Not sent" — a teammate's says
 * it will be sent again (not an error). Agent text reaches the page only
 * through ChatMarkdown.
 */
import { computed, shallowRef } from 'vue'
import { Goal, Users } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { deriveNativeChatRowContent } from '../../../chat/orca/shared/native-chat-row-content.js'
import ChatMarkdown from './ChatMarkdown.vue'
import NativeChatToolRun from './NativeChatToolRun.vue'
import NativeChatCodeBlock from './NativeChatCodeBlock.vue'
import NativeChatNoticeRow from './NativeChatNoticeRow.vue'
import NativeChatCopyButton from './NativeChatCopyButton.vue'
import NativeChatMessageTimestamp from './NativeChatMessageTimestamp.vue'
import NativeChatAgentControls from './NativeChatAgentControls.vue'
import NativeChatImageAttachments from './NativeChatImageAttachments.vue'
import ProviderFrameRow from './ProviderFrameRow.vue'

const props = defineProps({
  message: { type: Object, required: true },
  previousTodoWrite: { type: Object, default: undefined },
  previousUpdatePlan: { type: Object, default: undefined },
  revealedDiff: { type: Object, default: undefined },
  expandSignal: { type: Boolean, default: false },
  activeTurnIsWorking: { type: Boolean, default: undefined },
  trailingRun: { type: Boolean, default: undefined },
  onScrollMessageToTop: { type: Function, default: undefined },
  onLinkClick: { type: Function, default: undefined },
  allowFileUriLinks: { type: Boolean, default: false },
  deliveryFailed: { type: Boolean, default: false },
  structuredActivityUi: { type: Boolean, default: true },
  folded: { type: Boolean, default: false },
  runtimeContext: { type: Object, default: undefined }
})

const rowRef = shallowRef(null)

// One pass per block set, shared with the list that decides whether this row
// occupies a slot — so "draws nothing" means the same thing to both.
const content = computed(() => deriveNativeChatRowContent(props.message.blocks))
const isUser = computed(() => props.message.role === 'user')
const isReasoning = computed(() => props.message.role === 'reasoning')
const isSystem = computed(() => props.message.role === 'system')
const timestamp = computed(() => props.message.timestamp ?? null)

const renders = computed(() => {
  const c = content.value
  const hasContent =
    c.markdown.length > 0 ||
    c.hasImages ||
    c.tools.length > 0 ||
    c.subagentGroups.length > 0 ||
    c.backgroundTasks.length > 0
  // Behind a folded turn this row is the work, not the answer.
  return hasContent && !props.folded
})

const notice = computed(() => {
  if (!isSystem.value) return undefined
  const block = props.message.blocks.find(
    (b) => b.type === 'text' && (b.presentation !== undefined || b.tone !== undefined)
  )
  return block?.type === 'text' ? block : undefined
})
const providerFrame = computed(() =>
  props.message.blocks.find((block) => block.type === 'text' && block.providerFrame)
)
const hasToolRun = computed(
  () =>
    content.value.tools.length > 0 ||
    content.value.subagentGroups.length > 0 ||
    content.value.backgroundTasks.length > 0
)
// Plain assistant prose is the copyable unit; reasoning/system asides stay
// chrome-free. Controls reveal on hover/keyboard focus and stay visible on touch.
const showControls = computed(
  () => !isReasoning.value && !isSystem.value && content.value.markdown.length > 0
)
const imagePreview = computed(() => props.runtimeContext !== undefined)

// Tessel: a teammate's message.
const isTeam = computed(() => props.message.sentAs === 'team')
const teamFromLabel = computed(() => {
  const from = String(props.message.from || '').trim()
  const who = /^\d+$/.test(from) ? `#${from}` : from
  return who
    ? t('chat.user.fromTeammate', 'From {{from}} (teammate)', { from: who })
    : t('chat.user.fromTeam', 'From a teammate')
})
const deliveryText = computed(() =>
  isTeam.value
    ? t('chat.user.teamFailed', 'Not delivered yet: will be sent again')
    : t('chat.user.failed', 'Not sent')
)
const sentAsGoalText = computed(() => t('chat.orca.goal.sentAsGoal', 'Sent as goal'))

function scrollToTop() {
  if (rowRef.value) props.onScrollMessageToTop?.(rowRef.value)
}
</script>

<template>
  <template v-if="renders">
    <div v-if="notice" ref="rowRef">
      <NativeChatNoticeRow
        :block="notice"
        :on-link-click="onLinkClick"
        :allow-file-uri-links="allowFileUriLinks"
      />
    </div>

    <div v-else-if="providerFrame" ref="rowRef">
      <ProviderFrameRow :block="providerFrame" />
    </div>

    <div
      v-else-if="isUser"
      ref="rowRef"
      class="nc-row nc-row-user"
      :class="{ 'is-team': isTeam }"
      data-test="nc-user-row"
    >
      <div v-if="isTeam" class="nc-team-from" data-test="nc-team-from">
        <Users class="nc-team-from-icon" aria-hidden="true" />
        <span>{{ teamFromLabel }}</span>
      </div>
      <!-- User turns get a distinct muted fill (not the card/canvas color) so
           the prompt reads apart from the assistant's body copy. -->
      <div class="nc-user-bubble">
        <NativeChatImageAttachments
          :blocks="content.prose"
          :runtime-context="runtimeContext"
          :enable-preview="imagePreview"
        />
        <ChatMarkdown
          v-if="content.markdown"
          :content="content.markdown"
          variant="document"
          class="nc-row-markdown"
          :render-code-block="NativeChatCodeBlock"
          :on-link-click="onLinkClick"
          :allow-file-uri-links="allowFileUriLinks"
        />
      </div>
      <div v-if="message.sentAs === 'goal'" class="nc-user-goal">
        <Goal class="nc-user-goal-icon" aria-hidden="true" />
        <span>{{ sentAsGoalText }}</span>
      </div>
      <!-- Copy + timestamp reveal together, mirroring the agent controls row.
           Image-only prompts have no text to copy, so the button is omitted. -->
      <div v-if="content.markdown || timestamp !== null" class="nc-row-controls nc-user-controls">
        <NativeChatCopyButton v-if="content.markdown" :text="content.markdown" />
        <NativeChatMessageTimestamp :timestamp="timestamp" focusable />
      </div>
      <div
        v-if="deliveryFailed"
        class="nc-user-delivery"
        :class="{ 'is-error': !isTeam }"
        data-test="nc-user-delivery"
      >
        {{ deliveryText }}
      </div>
    </div>

    <div
      v-else
      ref="rowRef"
      class="nc-row nc-row-agent"
      :class="{ 'is-reasoning': isReasoning, 'is-system': isSystem }"
      data-test="nc-agent-row"
    >
      <NativeChatImageAttachments
        :blocks="content.prose"
        :runtime-context="runtimeContext"
        :enable-preview="imagePreview"
      />
      <ChatMarkdown
        v-if="content.markdown"
        :content="content.markdown"
        variant="document"
        class="nc-row-markdown"
        :render-code-block="NativeChatCodeBlock"
        :on-link-click="onLinkClick"
        :allow-file-uri-links="allowFileUriLinks"
        :linkify-file-paths="onLinkClick !== undefined"
      />
      <NativeChatToolRun
        v-if="hasToolRun"
        :blocks="content.tools"
        :previous-todo-write="previousTodoWrite"
        :previous-update-plan="previousUpdatePlan"
        :revealed-diff="revealedDiff"
        :on-reveal-diff="onScrollMessageToTop"
        :on-link-click="onLinkClick"
        :subagent-groups="content.subagentGroups"
        :background-tasks="content.backgroundTasks"
        :expand-signal="expandSignal"
        :active-turn-is-working="activeTurnIsWorking"
        :trailing="trailingRun"
        :structured-activity-ui="structuredActivityUi"
        :disclosure-id="message.id"
      />
      <NativeChatAgentControls
        v-if="showControls"
        :markdown="content.markdown"
        :timestamp="timestamp"
        class="nc-row-controls nc-agent-row-controls"
        @scroll-to-top="scrollToTop"
      />
    </div>
  </template>
</template>

<style scoped>
.nc-row {
  position: relative;
}
.nc-row-user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}
.nc-user-bubble {
  max-width: 85%;
  border-radius: 8px 4px 8px 8px;
  background: var(--nc-muted);
  padding: 10px 14px;
  font-size: 14px;
  line-height: 20px;
  color: var(--nc-foreground);
}
/* Tessel: a teammate's message sits on the other side, dashed, with its sender. */
.nc-row-user.is-team {
  align-items: flex-start;
}
.nc-row-user.is-team .nc-user-bubble {
  border: 1px dashed var(--nc-input);
  border-radius: 4px 8px 8px 8px;
  background: var(--nc-card);
}
.nc-team-from {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent, var(--nc-foreground));
}
.nc-team-from-icon {
  width: 12px;
  height: 12px;
}
.nc-row-markdown {
  font-size: 14px;
}
.nc-user-goal {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
.nc-user-goal-icon {
  width: 12px;
  height: 12px;
}
.nc-user-controls {
  display: flex;
  user-select: none;
  align-items: center;
  gap: 4px;
}
.nc-user-delivery {
  max-width: 85%;
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
.nc-user-delivery.is-error {
  color: color-mix(in srgb, var(--nc-destructive) 80%, transparent);
}

.nc-row-agent {
  max-width: 100%;
  user-select: text;
  font-size: 14px;
  line-height: 1.625;
  color: var(--nc-foreground);
}
/* Reasoning is the agent thinking aloud — quieter, italic, like an aside. */
.nc-row-agent.is-reasoning {
  border-left: 2px solid color-mix(in srgb, var(--nc-border) 60%, transparent);
  padding-left: 12px;
  font-style: italic;
  color: var(--nc-muted-foreground);
}
.nc-row-agent.is-system {
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
.nc-agent-row-controls {
  margin-top: 4px;
  margin-bottom: -20px;
  width: fit-content;
  user-select: none;
}

/* Revealed on hover or keyboard focus; always shown where nothing hovers. */
.nc-row-controls {
  transition-property: opacity;
  transition-duration: 150ms;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
}
@media (hover: hover) {
  .nc-row-controls {
    pointer-events: none;
    opacity: 0;
  }
  .nc-row:hover .nc-row-controls,
  .nc-row:has(:focus-visible) .nc-row-controls {
    pointer-events: auto;
    opacity: 1;
  }
}
</style>
