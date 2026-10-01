<script setup>
import { computed, ref } from 'vue'
import { Dumbbell } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { nativeChatSessionChoiceLabel } from '../../../chat/orca/native-chat-session-option-labels.js'

const props = defineProps({ descriptor: { type: Object, required: true }, disabled: Boolean, icon: Boolean })
const emit = defineEmits(['change'])
const dragIndex = ref(null)
const choices = computed(() => props.descriptor.kind.choices)
const current = computed(() => choices.value.findIndex(c => c.value === props.descriptor.kind.currentValue))
const index = computed(() => dragIndex.value ?? Math.max(0, current.value))
const valueText = computed(() => current.value < 0 && dragIndex.value === null
  ? t('chat.orca.composer.valueNotReported', 'Not reported')
  : nativeChatSessionChoiceLabel(choices.value[index.value]))
const label = computed(() => t('chat.orca.composer.effortValue', 'Effort ({{value}})', { value: valueText.value }))
const percent = i => choices.value.length < 2 ? 50 : i * 100 / (choices.value.length - 1)
function commit(i) {
  if (!props.disabled && choices.value[i] && !choices.value[i].disabled) emit('change', choices.value[i].value)
}
function keydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  if (props.disabled) return
  const enabled = choices.value.map((c, i) => c.disabled ? -1 : i).filter(i => i >= 0)
  const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1)
    : event.key === 'ArrowRight' ? enabled.find(i => i > index.value) : enabled.findLast(i => i < index.value)
  if (next !== undefined) commit(next)
}
function point(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - 9) / Math.max(1, rect.width - 18)))
  const i = Math.round(ratio * (choices.value.length - 1))
  if (!choices.value[i]?.disabled) dragIndex.value = i
}
function start(event) {
  if (props.disabled || event.button !== 0) return
  event.preventDefault()
  event.currentTarget.focus()
  event.currentTarget.setPointerCapture?.(event.pointerId)
  point(event)
}
function finish(event) {
  if (dragIndex.value === null) return
  point(event)
  commit(dragIndex.value)
  dragIndex.value = null
}
</script>

<template>
  <div class="nc-effort-footer">
    <div class="nc-effort-label">
      <Dumbbell v-if="icon" :size="16" aria-hidden="true" />
      <span>{{ label }}</span>
    </div>
    <div
      class="nc-effort-slider" role="slider" tabindex="-1" data-nc-menu-item
      :data-disabled="disabled ? '' : undefined" :aria-disabled="disabled"
      :aria-label="t('chat.orca.composer.effort', 'Effort')" aria-orientation="horizontal"
      :aria-valuemin="0" :aria-valuemax="choices.length - 1" :aria-valuenow="index" :aria-valuetext="valueText"
      @keydown="keydown" @pointerdown="start" @pointermove="dragIndex !== null && point($event)"
      @pointerup="finish" @pointercancel="dragIndex = null" @lostpointercapture="dragIndex = null"
    >
      <div class="nc-effort-track" aria-hidden="true">
        <span v-if="current >= 0 || dragIndex !== null" class="nc-effort-fill" :style="{ width: `min(calc(${percent(index)}% + 19px), calc(100% + 18px))` }" />
        <span v-for="(choice, i) in choices" :key="choice.value" class="nc-effort-tick"
          :class="{ 'nc-effort-filled-tick': i <= index, 'nc-effort-last': i === choices.length - 1, 'nc-effort-unavailable': choice.disabled }" :style="{ left: percent(i) + '%' }" />
        <span v-if="current >= 0 || dragIndex !== null" class="nc-effort-thumb" :style="{ left: percent(index) + '%' }" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Sizes in CSS pixels (the reference was a 2x screenshot). The fill runs
   from the track's left end to just past the thumb (9px pad + 7px radius +
   3px of blue after it). The last step's dot is violet. */
.nc-effort-footer { flex: none; display: flex; align-items: center; gap: 16px; padding: 12px 10px 8px; border-top: 1px solid var(--nc-border); }
.nc-effort-label { display: flex; align-items: center; gap: 8px; font-size: 12px; white-space: nowrap; }
.nc-effort-slider { box-sizing: border-box; width: 76px; flex: none; margin-left: auto; height: 18px; padding: 0 9px; display: flex; align-items: center; cursor: pointer; touch-action: none; border-radius: 9px; outline: none; }
.nc-effort-slider:focus-visible { box-shadow: 0 0 0 2px var(--nc-ring, var(--nc-foreground)); }
.nc-effort-slider[aria-disabled='true'] { opacity: .45; cursor: default; }
.nc-effort-track { position: relative; width: 100%; height: 18px; pointer-events: none; }
.nc-effort-track::before { content: ''; position: absolute; inset: 0 -9px; border-radius: 9px; background: #3a3f4b; }
.nc-effort-fill { box-sizing: border-box; position: absolute; left: -9px; height: 18px; border-radius: 9px; background: #007acc; }
.nc-effort-tick, .nc-effort-thumb { position: absolute; top: 50%; transform: translate(-50%, -50%); border-radius: 50%; background: var(--nc-muted-foreground); }
.nc-effort-tick { width: 4px; height: 4px; background: #63666f; }
.nc-effort-filled-tick { background: #479bd5; }
.nc-effort-last:not(.nc-effort-filled-tick) { background: #a77be8; }
.nc-effort-thumb { width: 14px; height: 14px; background: #ccc; transition: left .1s ease; }
.nc-effort-unavailable { opacity: .3; }
@media (prefers-reduced-motion: reduce) { .nc-effort-thumb { transition: none; } }
</style>
