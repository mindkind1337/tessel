<script setup>
// After Orca's NativeChatSessionOptionPickers.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// The composer's session pickers: the model pill, then one pill for the
// other options (effort, fast mode, Tessel's permission mode…), each a menu
// that opens upward.
// Props: surface ({ setOption(id, value), invokeAction(id) } -> Promise),
//   snapshot (option descriptors, see chat/orca/shared/native-chat-session-
//   options.js), isWorking (the pills wait for the turn's end), pickerRequest
//   ({ id, sequence }: a slash command asked to open this option's menu).
// Tessel additions (native-chat-session-option-pickers.js builds them):
// - a choice may be `disabled` with a `disabledReason` (a permission mode
//   the pane's rules forbid now);
// - a descriptor `settableWhileWorking` stays settable during a turn;
// - a setOption / invokeAction result { ok: false, error } is a failure like
//   a rejection: the pane's toast says "Could not update option" (and
//   @error gets the text). The value shown is always the snapshot's: the
//   pane rebuilds it from the confirmed values only.
import { computed, inject, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SwitchIndicator,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from './ui/index.js'
import { t } from '../../../i18n'
import { sortNativeChatSessionOptions } from '../../../chat/orca/shared/native-chat-session-option-snapshot.js'
import { sessionOptionDispatchUnconfirmed, sessionOptionValueMarker } from '../../../chat/orca/shared/native-chat-session-options.js'
import {
  nativeChatModelPillLabel,
  nativeChatOptionsPillLabel,
  nativeChatOptionsPillTitle,
  nativeChatSessionChoiceLabel,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from '../../../chat/orca/native-chat-session-option-labels.js'

const props = defineProps({
  surface: { type: Object, default: null },
  snapshot: { type: Array, default: () => [] },
  isWorking: { type: Boolean, default: false },
  pickerRequest: { type: Object, default: null }
})
const emit = defineEmits(['error'])

// Tessel's toasts (the pane's context), like the reference's sonner toast.
const panelCtx = inject('panelCtx', null)

const pendingId = ref(null)
const model = computed(() => props.snapshot.find((descriptor) => descriptor.category === 'model') || null)
const options = computed(() => sortNativeChatSessionOptions(props.snapshot))
const requestedModelSequence = computed(() => (model.value && props.pickerRequest?.id === model.value.id ? props.pickerRequest.sequence : null))
const requestedOptionsSequence = computed(() =>
  options.value.some((descriptor) => descriptor.id === props.pickerRequest?.id) ? (props.pickerRequest?.sequence ?? null) : null
)

function runSurfaceCall(pendingKey, call) {
  pendingId.value = pendingKey
  let result
  try {
    result = Promise.resolve(call())
  } catch (error) {
    result = Promise.reject(error)
  }
  result
    .then((value) => {
      // Tessel: a refusal comes back as { ok: false }, not only as a throw.
      if (value && typeof value === 'object' && value.ok === false) throw new Error(value.error || '')
    })
    .catch((error) => {
      const title = t('chat.orca.composer.optionUpdateFailed', 'Could not update option')
      const description = error instanceof Error ? error.message : String(error)
      emit('error', description ? `${title}: ${description}` : title)
      if (panelCtx && typeof panelCtx.toast === 'function') panelCtx.toast(description ? `${title}: ${description}` : title, { timeout: 6000 })
    })
    .finally(() => {
      pendingId.value = null
    })
}
function setOption(descriptor, value) {
  if (!props.surface) return
  runSurfaceCall(descriptor.id, () => props.surface.setOption(descriptor.id, value))
}
function invokeAction(descriptor) {
  if (!props.surface) return
  runSurfaceCall(descriptor.id, () => props.surface.invokeAction(descriptor.id))
}

// A row waits for a write in flight, and for the turn's end unless its
// option may change during one.
function rowDisabled(descriptor) {
  return !descriptor.settable || pendingId.value !== null || (props.isWorking && !descriptor.settableWhileWorking)
}
function choiceDisabled(descriptor, choice) {
  return rowDisabled(descriptor) || choice.disabled === true
}
// A radio pick: only a change, and only a choice that may be picked now.
function onRadioChange(descriptor, value) {
  if (value === descriptor.kind.currentValue) return
  const choice = descriptor.kind.choices.find((c) => c.value === value)
  if (!choice || choiceDisabled(descriptor, choice)) return
  setOption(descriptor, value)
}
function onSwitchSelect(event, descriptor) {
  // Keep the menu open: the write is async and its result lands in this row.
  event.preventDefault()
  setOption(descriptor, !descriptor.kind.currentValue)
}

const modelReason = computed(() => (model.value ? nativeChatSessionOptionDisabledReason(model.value.disabledReason) : null))
const modelTooltip = computed(() => t('chat.orca.composer.model', 'Model'))
const modelLabel = computed(() => (model.value ? nativeChatModelPillLabel(model.value) : ''))
const optionsTooltip = computed(() => nativeChatOptionsPillTitle(options.value))
const optionsLabel = computed(() => nativeChatOptionsPillLabel(options.value))
const optionsReason = computed(() =>
  options.value.length > 0 && options.value.every((descriptor) => !descriptor.settable)
    ? nativeChatSessionOptionDisabledReason(options.value[0]?.disabledReason)
    : null
)
// The reference also disables the pills while a write is on its way; Tessel
// keeps them enabled then (their rows still wait), so the focus can go back
// to the pill when a choice closes its menu.
const modelDisabled = computed(() => props.isWorking)
const optionsDisabled = computed(() => props.isWorking && !options.value.some((descriptor) => descriptor.settableWhileWorking && descriptor.settable))

// Value-only visible text must still include the category in the accessible
// name (WCAG 2.5.3 Label in Name / voice control).
function accessibleName(label, tooltipLabel) {
  return label === tooltipLabel ? tooltipLabel : t('chat.orca.composer.pillAccessibleName', '{{value0}} {{value1}}', { value0: tooltipLabel, value1: label })
}
const markerText = (marker) =>
  marker === 'default' ? t('chat.orca.composer.valueIsDefault', 'Default') : t('chat.orca.composer.valueNotReported', 'Not reported')
const toggleText = (descriptor) =>
  t('chat.orca.composer.toggleOption', 'Toggle {{value0}}', { value0: nativeChatSessionOptionLabel(descriptor).toLowerCase() })
const sentNotConfirmed = () => t('chat.orca.composer.sentNotConfirmed', 'Sent to the agent — not confirmed')
// The descriptors of a menu, each with what its rows need.
function rowsOf(list) {
  return list.map((descriptor) => ({
    descriptor,
    label: nativeChatSessionOptionLabel(descriptor),
    reason: nativeChatSessionOptionDisabledReason(descriptor.disabledReason),
    marker: descriptor.kind.type === 'boolean' ? sessionOptionValueMarker(descriptor) : null,
    markerId: `session-option-marker-${descriptor.id}` // i18n-ignore
  }))
}
const modelRows = computed(() => (model.value ? rowsOf([model.value]) : []))
const optionRows = computed(() => rowsOf(options.value))
const pills = computed(() => {
  if (!model.value) return []
  const list = [
    {
      key: `model:${requestedModelSequence.value ?? 'idle'}`, // i18n-ignore
      defaultOpen: requestedModelSequence.value !== null,
      label: modelLabel.value,
      tooltipLabel: modelTooltip.value,
      disabled: modelDisabled.value,
      disabledReason: modelReason.value,
      dispatched: sessionOptionDispatchUnconfirmed(model.value),
      contentClass: 'nc-picker-menu nc-picker-menu--model',
      rows: modelRows.value,
      modelMenu: true
    }
  ]
  if (options.value.length > 0) {
    list.push({
      key: `options:${requestedOptionsSequence.value ?? 'idle'}`, // i18n-ignore
      defaultOpen: requestedOptionsSequence.value !== null,
      label: optionsLabel.value,
      tooltipLabel: optionsTooltip.value,
      disabled: optionsDisabled.value,
      disabledReason: optionsReason.value,
      dispatched: options.value.some(sessionOptionDispatchUnconfirmed),
      contentClass: 'nc-picker-menu nc-picker-menu--options',
      rows: optionRows.value,
      modelMenu: false
    })
  }
  return list
})
// Escape closes the menu (the primitive), and goes no further: not an
// interrupt, not the app's Escape.
function stopEscape(event) {
  event.stopPropagation()
}
</script>

<template>
  <div v-if="surface && model" class="nc-pickers">
    <DropdownMenu v-for="pill in pills" :key="pill.key" :default-open="pill.defaultOpen">
      <Tooltip>
        <TooltipTrigger as-child>
          <DropdownMenuTrigger as-child :disabled="pill.disabled">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              :aria-label="accessibleName(pill.label, pill.tooltipLabel)"
              :data-native-chat-picker="pill.modelMenu ? 'model' : 'options'"
              class="nc-picker-trigger"
            >
              <span class="nc-picker-trigger-label">{{ pill.label }}</span>
              <ChevronDown class="nc-size-3" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" :side-offset="4">
          <div class="nc-picker-tip">
            <div>{{ pill.disabledReason ?? pill.tooltipLabel }}</div>
            <div v-if="pill.dispatched">{{ sentNotConfirmed() }}</div>
          </div>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" :collision-padding="8" :class="pill.contentClass" @escape-key-down="stopEscape">
        <div v-for="(r, index) in pill.rows" :key="r.descriptor.id">
          <template v-if="!pill.modelMenu">
            <DropdownMenuSeparator v-if="index > 0" />
            <DropdownMenuLabel v-if="!(r.descriptor.kind.type === 'boolean' && !r.descriptor.action)">{{ r.label }}</DropdownMenuLabel>
          </template>
          <DropdownMenuLabel v-if="r.reason && !r.descriptor.settable" class="nc-picker-reason">{{ r.reason }}</DropdownMenuLabel>
          <!-- Flip-only without a baseline is an action: never claim On/Off. -->
          <DropdownMenuItem
            v-if="r.descriptor.action?.type === 'toggle-command'"
            :disabled="rowDisabled(r.descriptor)"
            @select="invokeAction(r.descriptor)"
          >
            {{ toggleText(r.descriptor) }}
          </DropdownMenuItem>
          <!-- agent-picker opens the agent's own picker; it is not a set of radio choices. -->
          <DropdownMenuItem v-else-if="r.descriptor.action?.type === 'agent-picker'" :disabled="rowDisabled(r.descriptor)" @select="invokeAction(r.descriptor)">
            {{ t('chat.orca.composer.chooseInAgentPicker', 'Choose in agent picker…') }}
          </DropdownMenuItem>
          <!-- A binary option is one switch row that carries its own label; the
               marker keeps an unpicked value from reading as confirmed. -->
          <DropdownMenuItem
            v-else-if="r.descriptor.kind.type === 'boolean'"
            role="switch"
            :aria-checked="r.descriptor.kind.currentValue ? 'true' : 'false'"
            :aria-label="r.label"
            :aria-describedby="r.marker ? r.markerId : undefined"
            :disabled="rowDisabled(r.descriptor)"
            class="nc-picker-switch"
            @select="(e) => onSwitchSelect(e, r.descriptor)"
          >
            <span>{{ r.label }}</span>
            <span class="nc-picker-switch-end">
              <span v-if="r.marker" :id="r.markerId" class="nc-picker-marker">{{ markerText(r.marker) }}</span>
              <SwitchIndicator :checked="!!r.descriptor.kind.currentValue" />
            </span>
          </DropdownMenuItem>
          <DropdownMenuRadioGroup
            v-else
            :aria-label="r.label"
            :model-value="r.descriptor.kind.currentValue"
            @update:model-value="(value) => onRadioChange(r.descriptor, value)"
          >
            <DropdownMenuRadioItem
              v-for="choice in r.descriptor.kind.choices"
              :key="choice.value"
              :value="choice.value"
              :disabled="choiceDisabled(r.descriptor, choice)"
              :title="choice.disabledReason || undefined"
              :data-choice="choice.value"
            >
              <div class="nc-picker-choice">
                <div>{{ nativeChatSessionChoiceLabel(choice) }}</div>
                <div v-if="choice.description" class="nc-picker-choice-desc">{{ choice.description }}</div>
                <div v-if="choice.disabledReason" class="nc-picker-choice-desc nc-picker-choice-why">{{ choice.disabledReason }}</div>
              </div>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>

<style scoped>
/* flex min-w-0 items-center gap-0.5 */
.nc-pickers {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
/* max-w-48 text-muted-foreground */
.nc-picker-trigger {
  max-width: 12rem;
  color: var(--nc-muted-foreground);
}
.nc-picker-trigger-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-size-3 {
  width: 12px;
  height: 12px;
}
/* space-y-0.5 */
.nc-picker-tip > * + * {
  margin-top: 2px;
}
/* w-64 / w-60 */
.nc-picker-menu--model {
  width: 16rem;
}
.nc-picker-menu--options {
  width: 15rem;
}
.nc-picker-reason {
  font-weight: 400;
}
/* justify-between gap-2 */
.nc-picker-switch {
  justify-content: space-between;
  gap: 8px;
}
.nc-picker-switch-end {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* text-[11px] text-muted-foreground */
.nc-picker-marker {
  color: var(--nc-muted-foreground);
  font-size: 11px;
}
/* min-w-0 py-0.5 */
.nc-picker-choice {
  min-width: 0;
  padding: 2px 0;
}
/* text-xs font-normal text-muted-foreground */
.nc-picker-choice-desc {
  color: var(--nc-muted-foreground);
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
}
.nc-picker-choice-why {
  color: var(--nc-warning);
}
</style>
