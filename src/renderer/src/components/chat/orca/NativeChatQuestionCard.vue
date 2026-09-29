<script setup>
// After Orca's NativeChatQuestionCard.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// An agent's AskUserQuestion prompt: a numbered pick-list with a header and
// a close button, a highlighted row per option, and an optional free-text
// row for a custom answer. Single-select holds one answer (an option or the
// typed text, whichever was chosen last); multi-select toggles options, adds
// any typed text, and confirms with the trailing action. Several questions
// step through tabs across the top.
// Props: prompt ({ questions: [{ question, header?, multiSelect, options:
//   [{ label, description? }] }] }), isSubmitting, allowOther (Boolean or one
//   per question).
// Emits: answer(selections: [{ indices, other }]) (option indices, never
//   labels: labels need not be unique), cancel.
// Exposed: answerInput (the free-text field, for the pane's Paste).
// Tessel's engine has no answer path for questions yet: the lead shows it
// only when the session has question prompts.
import { computed, ref } from 'vue'
import { Check, Pencil, X } from 'lucide-vue-next'
import { t } from '../../../i18n'

const props = defineProps({
  prompt: { type: Object, required: true },
  isSubmitting: { type: Boolean, default: false },
  allowOther: { type: [Boolean, Array], default: true }
})
const emit = defineEmits(['answer', 'cancel'])

// Selection entry for the typed answer (never a real option index), so a
// single-select question holds exactly one choice: an option or the typed answer.
const TYPED_ANSWER = -1

const index = ref(0)
// Option identity by index: labels are display text and are not guaranteed
// unique, while Claude's selector commits the numbered row.
const selections = ref(props.prompt.questions.map(() => []))
const otherText = ref(props.prompt.questions.map(() => ''))
const answerInput = ref(null)

const total = computed(() => props.prompt.questions.length)
const isLast = computed(() => index.value === total.value - 1)
const q = computed(() => props.prompt.questions[index.value])
const questionAllowsOther = computed(() => (Array.isArray(props.allowOther) ? (props.allowOther[index.value] ?? false) : props.allowOther))

// Picking an option replaces a chosen typed answer on single-select; the
// text stays in the field, unsent, until the user types or clicks there again.
function typedAnswerChosen(qi, sel = selections.value, oth = otherText.value) {
  return (sel[qi] ?? []).includes(TYPED_ANSWER) && (oth[qi] ?? '').trim().length > 0
}

function chooseTypedAnswer(qi) {
  const cur = selections.value[qi] ?? []
  if (cur.includes(TYPED_ANSWER)) return
  const chosen = props.prompt.questions[qi]?.multiSelect ? [...cur, TYPED_ANSWER] : [TYPED_ANSWER]
  selections.value = selections.value.map((s, i) => (i === qi ? chosen : s))
}

function pickedOptions(qi, sel = selections.value) {
  return (sel[qi] ?? []).filter((choice) => choice !== TYPED_ANSWER)
}

function setOther(qi, value) {
  const next = [...otherText.value]
  next[qi] = value
  otherText.value = next
  if (value.trim().length > 0) chooseTypedAnswer(qi)
}

// The resolved answer for a question: picked labels plus the typed answer when chosen.
function answerFor(qi, sel = selections.value, oth = otherText.value) {
  const question = props.prompt.questions[qi]
  const picked = pickedOptions(qi, sel)
    .map((optionIndex) => question?.options[optionIndex]?.label ?? '')
    .filter((label) => label.length > 0)
  const other = typedAnswerChosen(qi, sel, oth) ? (oth[qi] ?? '').trim() : ''
  return [...picked, ...(other ? [other] : [])].join(', ')
}

const currentAnswered = computed(() => answerFor(index.value).length > 0)
const currentTypedAnswerChosen = computed(() => typedAnswerChosen(index.value))

function submitAll(sel, oth) {
  const resolved = props.prompt.questions.map((_, i) => ({
    indices: pickedOptions(i, sel),
    other: typedAnswerChosen(i, sel, oth) ? (oth[i] ?? '').trim() : ''
  }))
  const anyAnswered = resolved.some((s) => s.indices.length > 0 || (s.other ?? '').length > 0)
  if (anyAnswered) emit('answer', resolved)
}

// Advance to the next question, or submit on the last one.
function advanceOrSubmit(sel, oth) {
  if (isLast.value) submitAll(sel, oth)
  else index.value = Math.min(index.value + 1, total.value - 1)
}

// Selecting only highlights the row; submitting is an explicit step via the
// trailing Send/Next button (auto-submitting on the first click dismissed
// the card before the user saw any feedback).
function pickOption(optionIndex) {
  const next = selections.value.map((s) => [...s])
  const cur = next[index.value] ?? []
  if (q.value.multiSelect) {
    next[index.value] = cur.includes(optionIndex) ? cur.filter((pickedIndex) => pickedIndex !== optionIndex) : [...cur, optionIndex].sort((a, b) => a - b)
  } else {
    next[index.value] = cur.includes(optionIndex) ? [] : [optionIndex]
  }
  selections.value = next
}

// Trailing action (also fired by Enter). On any non-final question this only
// advances ("Next" when answered, "Skip" when not), so skipping one question
// never discards answers given on the others. Only the final question
// submits; an explicit Skip click there with nothing answered anywhere
// dismisses, but a reflexive Enter in the empty field does nothing.
function confirm(fromKeyboard = false) {
  if (!isLast.value) {
    advanceOrSubmit(selections.value, otherText.value)
    return
  }
  const anyAnswered = props.prompt.questions.some((_, i) => answerFor(i).length > 0)
  if (anyAnswered) submitAll(selections.value, otherText.value)
  else if (!fromKeyboard) emit('cancel')
}

// Click, not focus: tabbing through the field toward Submit must not
// replace the option the user just picked. Chromium still delivers pointer
// events to a disabled input: ignored while sending.
function onAnswerClick() {
  if (props.isSubmitting) return
  if ((otherText.value[index.value] ?? '').trim().length > 0) chooseTypedAnswer(index.value)
}

function onAnswerKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault()
    confirm(true)
  }
}

const stepText = (i) => t('chat.orca.question.step', 'Step {{value0}}', { value0: i + 1 })
const actionText = computed(() => {
  if (props.isSubmitting) return t('chat.orca.question.sending', 'Sending…')
  if (!currentAnswered.value) return t('chat.orca.question.skip', 'Skip')
  return isLast.value ? t('chat.orca.question.send', 'Submit') : t('chat.orca.question.next', 'Next')
})

defineExpose({ answerInput })
</script>

<template>
  <!-- Part of the composer: docked in the bottom input region, matching the
       composer's width and padding. Its free-text row is the answer input. -->
  <div class="nc-question" :aria-busy="isSubmitting ? 'true' : 'false'">
    <div class="nc-question-frame">
      <div v-if="total > 1" class="nc-question-tabs nc-scrollbar-sleek">
        <button
          v-for="(qq, i) in prompt.questions"
          :key="i"
          type="button"
          class="nc-question-tab"
          :class="{ 'nc-question-tab--active': i === index }"
          :disabled="isSubmitting"
          @click="index = i"
        >
          <span class="nc-question-tab-label">{{ qq.header || stepText(i) }}</span>
          <Check v-if="answerFor(i).length > 0" class="nc-question-tab-check" :stroke-width="3" aria-hidden="true" />
        </button>
      </div>

      <div class="nc-question-card">
        <div class="nc-question-head">
          <p data-testid="native-chat-question-card-title" class="nc-question-title">{{ q.question }}</p>
          <button type="button" class="nc-question-cancel" :aria-label="t('chat.orca.question.cancel', 'Cancel')" @click="emit('cancel')">
            <X class="nc-question-cancel-icon" aria-hidden="true" />
          </button>
        </div>

        <!-- Scroll only on long option lists; the sleek scrollbar rides the card's edge. -->
        <div class="nc-question-list nc-scrollbar-sleek">
          <button
            v-for="(opt, i) in q.options"
            :key="`${i}:${opt.label}`"
            type="button"
            class="nc-question-option"
            :class="{ 'nc-question-option--selected': (selections[index] ?? []).includes(i) }"
            :disabled="isSubmitting"
            :aria-pressed="(selections[index] ?? []).includes(i) ? 'true' : 'false'"
            @click="pickOption(i)"
          >
            <span class="nc-question-badge" :class="{ 'nc-question-badge--on': (selections[index] ?? []).includes(i) }">
              <Check v-if="(selections[index] ?? []).includes(i)" class="nc-question-badge-icon" :stroke-width="3" aria-hidden="true" />
              <template v-else>{{ String(i + 1) }}</template>
            </span>
            <span class="nc-question-option-body">
              <span class="nc-question-option-label">{{ opt.label }}</span>
              <span v-if="opt.description" class="nc-question-option-desc">{{ opt.description }}</span>
            </span>
          </button>
          <div class="nc-question-other">
            <template v-if="questionAllowsOther">
              <span class="nc-question-badge" :class="{ 'nc-question-badge--on': currentTypedAnswerChosen }">
                <Check v-if="currentTypedAnswerChosen" class="nc-question-badge-icon" :stroke-width="3" aria-hidden="true" />
                <Pencil v-else class="nc-question-badge-icon" aria-hidden="true" />
              </span>
              <!-- No / or @ picker here: that autocomplete belongs to the composer,
                   which this card replaces. What is typed goes verbatim as the
                   tool result. -->
              <input
                ref="answerInput"
                class="nc-question-input"
                :class="{ 'nc-question-input--muted': !(currentTypedAnswerChosen || !otherText[index]) }"
                :disabled="isSubmitting"
                :value="otherText[index]"
                :placeholder="t('chat.orca.question.otherPlaceholder', 'Type your answer')"
                @input="(e) => setOther(index, e.target.value)"
                @click="onAnswerClick"
                @keydown="onAnswerKeydown"
              />
            </template>
            <span v-else class="nc-question-spacer" />
            <button
              type="button"
              class="nc-question-action"
              :class="currentAnswered ? 'nc-question-action--primary' : 'nc-question-action--quiet'"
              :disabled="isSubmitting"
              @click="confirm()"
            >
              {{ actionText }}
            </button>
          </div>
        </div>
      </div>

      <p v-if="total > 1" class="nc-question-count">{{ index + 1 }}/{{ total }}</p>
    </div>
  </div>
</template>

<style scoped>
/* shrink-0 bg-background */
.nc-question {
  flex-shrink: 0;
  background: var(--nc-background);
}
/* mx-auto w-full max-w-4xl px-3 pt-2 pb-4 sm:px-4 */
.nc-question-frame {
  box-sizing: border-box;
  width: 100%;
  max-width: 56rem;
  margin: 0 auto;
  padding: 8px 12px 16px;
}
@media (min-width: 640px) {
  .nc-question-frame {
    padding-right: 16px;
    padding-left: 16px;
  }
}
/* mb-2 flex gap-1 overflow-x-auto pb-1 */
.nc-question-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
  padding-bottom: 4px;
  overflow-x: auto;
}
/* flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium */
.nc-question-tab {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--nc-muted-foreground);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  cursor: pointer;
}
.nc-question-tab:hover {
  color: var(--nc-foreground);
}
.nc-question-tab:disabled {
  pointer-events: none;
}
.nc-question-tab--active,
.nc-question-tab--active:hover {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-question-tab-label {
  max-width: 10rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-question-tab-check {
  width: 12px;
  height: 12px;
  color: var(--nc-primary);
}
/* overflow-hidden rounded-lg border border-input bg-card shadow-xs */
.nc-question-card {
  overflow: hidden;
  border: 1px solid var(--nc-input);
  border-radius: 8px;
  background: var(--nc-card);
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
}
/* flex items-start justify-between gap-2 px-3.5 py-2.5 */
.nc-question-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
}
.nc-question-title {
  min-width: 0;
  margin: 0;
  color: var(--nc-foreground);
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  overflow-wrap: break-word;
}
.nc-question-cancel {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--nc-muted-foreground);
  cursor: pointer;
  transition: color 150ms, background-color 150ms;
}
.nc-question-cancel:hover {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-question-cancel:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-question-cancel-icon {
  width: 16px;
  height: 16px;
}
/* max-h-[50vh] divide-y divide-border/60 overflow-y-auto border-t border-border */
.nc-question-list {
  max-height: 50vh;
  overflow-y: auto;
  border-top: 1px solid var(--nc-border);
}
.nc-question-list > * + * {
  border-top: 1px solid color-mix(in srgb, var(--nc-border) 60%, transparent);
}
/* flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors */
.nc-question-option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  padding: 10px 14px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 150ms;
}
.nc-question-option:hover,
.nc-question-option--selected {
  background: var(--nc-accent);
}
.nc-question-option:disabled {
  pointer-events: none;
}
.nc-question-option:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--nc-ring);
}
/* flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-medium */
.nc-question-badge {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--nc-muted);
  color: var(--nc-muted-foreground);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
}
.nc-question-badge--on {
  background: var(--nc-primary);
  color: var(--nc-primary-foreground);
}
.nc-question-badge-icon {
  width: 14px;
  height: 14px;
}
.nc-question-option-body {
  min-width: 0;
}
.nc-question-option-label {
  display: block;
  color: var(--nc-foreground);
  font-size: 14px;
  line-height: 20px;
  overflow-wrap: break-word;
}
.nc-question-option-desc {
  display: block;
  color: var(--nc-muted-foreground);
  font-size: 12px;
  line-height: 16px;
  overflow-wrap: break-word;
}
/* flex items-center gap-3 px-3.5 py-2.5 */
.nc-question-other {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
}
.nc-question-spacer {
  flex: 1 1 0%;
}
/* min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 */
.nc-question-input {
  flex: 1 1 0%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--nc-foreground);
  font: inherit;
  font-size: 14px;
  line-height: 20px;
  outline: none;
}
.nc-question-input::placeholder {
  color: color-mix(in srgb, var(--nc-muted-foreground) 60%, transparent);
}
.nc-question-input--muted {
  color: var(--nc-muted-foreground);
}
.nc-question-input:disabled {
  opacity: 0.5;
  cursor: default;
}
/* shrink-0 whitespace-nowrap rounded-md px-3 py-1 text-xs font-semibold */
.nc-question-action {
  flex-shrink: 0;
  padding: 4px 12px;
  border: 0;
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  white-space: nowrap;
  cursor: pointer;
  transition: color 150ms, background-color 150ms;
}
.nc-question-action:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-question-action:disabled {
  opacity: 0.5;
  cursor: default;
}
.nc-question-action--primary {
  background: var(--nc-primary);
  color: var(--nc-primary-foreground);
}
.nc-question-action--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--nc-primary) 90%, transparent);
}
.nc-question-action--quiet {
  background: transparent;
  color: var(--nc-muted-foreground);
}
.nc-question-action--quiet:hover:not(:disabled) {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
/* mt-2 text-right text-xs text-muted-foreground */
.nc-question-count {
  margin: 8px 0 0;
  color: var(--nc-muted-foreground);
  font-size: 12px;
  line-height: 16px;
  text-align: right;
}
</style>
