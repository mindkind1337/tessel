<script setup>
// After Orca's NativeChatAwaitingInputRow.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * The row a question tool call draws in place of its raw input. The agent is
 * blocked on the reader, so the row says that in plain words and names what was
 * asked, rather than printing the tool's name and a clipped JSON payload.
 *
 * Only the label breathes: the question is the part worth reading, and animating
 * it would make the one line the reader has to act on the hardest one to read.
 *
 * A question too long for the line becomes a disclosure. Once answered, this row
 * is the only place the question is still shown, so the full text opens below the
 * toggle, outside it, where it can be selected and copied like any other prose.
 *
 * Props: subject ({ kind: 'question', text } | { kind: 'count', count } | null),
 *   pending (still waiting on an answer), disclosureKey.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { NATIVE_CHAT_ASK_ROW_COPY } from '../../../chat/orca/shared/native-chat-ask-row.js'
import { useNativeChatDisclosure } from '../../../chat/orca/composables/native-chat-disclosure-store.js'
import NativeChatToolRunIcon from './NativeChatToolRunIcon.vue'

const props = defineProps({
  subject: { type: Object, default: null },
  pending: { type: Boolean, required: true },
  disclosureKey: { type: String, default: undefined }
})

const { open, setOpen } = useNativeChatDisclosure(() => props.disclosureKey, false)
// Seeded from `open`: a row remounted open was clipped when the reader opened
// it, and dropping the toggle as it folds would drop keyboard focus with it.
const clipped = ref(open.value)
let observer = null
// Attached to the question only while it sits on the line; an open row keeps its verdict.
function measureLine(line) {
  observer?.disconnect()
  observer = null
  if (!line) return
  const measure = () => {
    clipped.value = line.scrollWidth > line.clientWidth
  }
  measure()
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(measure)
  observer.observe(line)
}
onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

const question = computed(() => (props.subject?.kind === 'question' ? props.subject.text : null))
const toggles = computed(() => question.value !== null && (open.value || clipped.value))
const label = computed(() =>
  props.pending
    ? t('chat.orca.ask.awaiting', NATIVE_CHAT_ASK_ROW_COPY.awaiting)
    : t('chat.orca.ask.asked', NATIVE_CHAT_ASK_ROW_COPY.asked)
)
const text = computed(() => {
  const subject = props.subject
  if (subject === null) return null
  if (subject.kind === 'question') return subject.text
  return t('chat.orca.ask.questionCount', NATIVE_CHAT_ASK_ROW_COPY.questionCount, { value0: subject.count })
})
const showsLine = computed(() => !(toggles.value && open.value))
</script>

<template>
  <div :data-native-chat-ask-row="pending ? 'awaiting' : 'asked'" :aria-live="pending ? 'polite' : undefined">
    <component
      :is="toggles ? 'button' : 'div'"
      :type="toggles ? 'button' : undefined"
      :class="['nc-ask-row', { 'nc-ask-row--toggle': toggles }]"
      :aria-expanded="toggles ? (open ? 'true' : 'false') : undefined"
      @click="toggles && setOpen(!open)"
    >
      <NativeChatToolRunIcon icon-name="message-square-more" class="nc-ask-row__icon" />
      <span :class="['nc-ask-row__label', { 'nc-animate-pulse': pending }]">{{ label }}</span>
      <span v-if="showsLine" :ref="question === null ? undefined : measureLine" class="nc-ask-row__text nc-truncate">{{ text }}</span>
      <ChevronRight
        v-if="toggles"
        aria-hidden="true"
        :class="['nc-ask-row__chevron', open ? 'nc-ask-row__chevron--open' : 'nc-ask-row__chevron--hover-reveal']"
      />
    </component>
    <!-- Indented to the label, past the icon slot and its gap. -->
    <p v-if="toggles && open" class="nc-ask-row__question">{{ question }}</p>
  </div>
</template>

<style scoped>
/* flex min-h-6 w-full items-center gap-1.5 py-0.5 text-left text-sm leading-relaxed text-muted-foreground */
.nc-ask-row {
  box-sizing: border-box;
  display: flex;
  min-height: 24px;
  width: 100%;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 2px 0;
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.625;
  text-align: left;
  color: var(--nc-muted-foreground);
}
/* group/ask-row rounded-md focus-visible:ring-2 ring-inset ring-ring/70 */
.nc-ask-row--toggle {
  border-radius: 6px;
  cursor: pointer;
}
.nc-ask-row--toggle:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--nc-ring) 70%, transparent);
}
.nc-ask-row__icon {
  color: var(--nc-muted-foreground);
}
.nc-ask-row__label {
  flex-shrink: 0;
}
.nc-ask-row__text {
  min-width: 0;
  color: color-mix(in srgb, var(--nc-foreground) 85%, transparent);
}
.nc-truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-ask-row__chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
  transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.nc-ask-row__chevron--open {
  transform: rotate(90deg);
}
/* can-hover:opacity-0, shown on this row's own hover or keyboard focus */
@media (hover: hover) {
  .nc-ask-row__chevron--hover-reveal {
    opacity: 0;
  }
  .nc-ask-row--toggle:hover .nc-ask-row__chevron--hover-reveal,
  .nc-ask-row--toggle:focus-visible .nc-ask-row__chevron--hover-reveal {
    opacity: 1;
  }
}
/* whitespace-pre-wrap break-words pl-5.5 text-sm leading-relaxed text-foreground/85 */
.nc-ask-row__question {
  margin: 0;
  padding-left: 22px;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  font-size: 14px;
  line-height: 1.625;
  color: color-mix(in srgb, var(--nc-foreground) 85%, transparent);
}
/* animate-pulse motion-reduce:animate-none: .nc-animate-pulse in orca-tokens.css */
</style>
