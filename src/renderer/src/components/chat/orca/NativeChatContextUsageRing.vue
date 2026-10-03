<script setup>
// After Orca's NativeChatContextUsageRing.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// The composer's ring for the context window's use; hover, click, tap or
// Enter shows the provider's breakdown. A read-only readout: it never takes
// the focus from the composer (not on click, not when the card closes).
// Props: usage ({ usedTokens, windowTokens, percentage, estimated, rows:
//   [{ name, tokens, percentage }] }: useNativeChatContextUsageSummary's value).
import { computed, onBeforeUnmount, ref } from 'vue'
import { Popover, PopoverContent, PopoverTrigger, Progress } from './ui/index.js'
import { t } from '../../../i18n'
import { formatContextTokenCount } from '../../../chat/orca/native-chat-context-usage-summary.js'

const props = defineProps({
  usage: { type: Object, required: true }
})

const RING_SIZE = 16
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
// Past this the window is nearly spent; the ring turns destructive to say so.
const CRITICAL_PERCENTAGE = 90
// Long enough that a pointer crossing the ring toward dictation doesn't flash the card.
const HOVER_OPEN_DELAY_MS = 150
// Long enough for the pointer to cross the gap between the ring and the card.
const HOVER_CLOSE_DELAY_MS = 100

const filled = computed(() => Math.min(Math.max(props.usage.percentage, 0), 100))
const critical = computed(() => props.usage.percentage >= CRITICAL_PERCENTAGE)
const used = computed(() => formatContextTokenCount(props.usage.usedTokens))
const windowText = computed(() => formatContextTokenCount(props.usage.windowTokens))
const label = computed(() =>
  t('chat.orca.contextUsage.label', 'Context {{used}} of {{window}} tokens, {{percent}}% used', {
    used: used.value,
    window: windowText.value,
    percent: String(props.usage.percentage)
  })
)
// The CLI can repeat a category name, so a row's key counts which repeat it is.
const rows = computed(() => {
  const seen = new Map()
  return (props.usage.rows || []).map((row) => {
    const repeat = seen.get(row.name) ?? 0
    seen.set(row.name, repeat + 1)
    return { key: `${repeat}:${row.name}`, row }
  })
})
const dashOffset = computed(() => RING_CIRCUMFERENCE * (1 - filled.value / 100))

// Card open state where only mouse hover waits, to open and to close; any
// explicit change drops a pending hover.
const open = ref(false)
let cancelPendingHover = null
function dropPendingHover() {
  if (cancelPendingHover) cancelPendingHover()
  cancelPendingHover = null
}
function setOpen(next) {
  dropPendingHover()
  open.value = next
}
function setOpenAfterHover(next) {
  dropPendingHover()
  // The card isn't mounted yet, so its own Escape handling can't cancel a pending open.
  const onKeyDown = (event) => {
    if (event.key === 'Escape') dropPendingHover()
  }
  const timer = setTimeout(() => setOpen(next), next ? HOVER_OPEN_DELAY_MS : HOVER_CLOSE_DELAY_MS)
  document.addEventListener('keydown', onKeyDown, true)
  cancelPendingHover = () => {
    clearTimeout(timer)
    document.removeEventListener('keydown', onKeyDown, true)
  }
}
onBeforeUnmount(dropPendingHover)

// Touch fires pointerleave before its click, so only a mouse drives hover.
// The card is teleported out of this element: it forwards its own
// enter/leave, so entering it cancels a pending close (the reference's
// portal stays inside its React tree).
function onPointerEnter(event) {
  if (event.pointerType === 'mouse') setOpenAfterHover(true)
}
function onPointerLeave(event) {
  if (event.pointerType === 'mouse') setOpenAfterHover(false)
}
// A read-only readout: clicking it must not pull focus out of the composer.
function onMouseDown(event) {
  event.preventDefault()
}
// Open, never toggle: a hover already opened it, and a click must not close it.
function onClick(event) {
  event.preventDefault()
  setOpen(true)
}
const preventDefault = (event) => event.preventDefault()
</script>

<template>
  <div class="nc-context-ring" @pointerenter="onPointerEnter" @pointerleave="onPointerLeave">
    <Popover :open="open" @update:open="setOpen">
      <PopoverTrigger as-child>
        <button
          type="button"
          class="nc-context-ring-button"
          :class="{ 'nc-context-ring-button--critical': critical }"
          :aria-label="label"
          :aria-expanded="open ? 'true' : 'false'"
          :data-native-chat-context-usage="usage.percentage"
          :data-native-chat-context-usage-estimated="usage.estimated ? 'true' : undefined"
          @mousedown="onMouseDown"
          @click="onClick"
        >
          <svg :width="RING_SIZE" :height="RING_SIZE" :viewBox="`0 0 ${RING_SIZE} ${RING_SIZE}`" aria-hidden="true" class="nc-context-ring-svg">
            <circle :cx="RING_SIZE / 2" :cy="RING_SIZE / 2" :r="RING_RADIUS" fill="none" stroke="currentColor" :stroke-width="RING_STROKE" class="nc-context-ring-track" />
            <circle
              :cx="RING_SIZE / 2"
              :cy="RING_SIZE / 2"
              :r="RING_RADIUS"
              fill="none"
              stroke="currentColor"
              :stroke-width="RING_STROKE"
              stroke-linecap="butt"
              :stroke-dasharray="RING_CIRCUMFERENCE"
              :stroke-dashoffset="dashOffset"
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent
        :aria-label="label"
        side="top"
        align="start"
        :side-offset="8"
        class="nc-context-card"
        @open-auto-focus="preventDefault"
        @close-auto-focus="preventDefault"
        @pointerenter="onPointerEnter"
        @pointerleave="onPointerLeave"
      >
        <div class="nc-context-card-body">
          <div class="nc-context-card-head">
            <span class="nc-context-card-title">{{ t('chat.orca.contextUsage.title', 'Context') }}</span>
            <span class="nc-context-card-count">{{ used }}/{{ windowText }}</span>
          </div>
          <Progress :value="filled" :aria-label="label" class="nc-context-card-progress" />
          <ul v-if="rows.length > 0" class="nc-context-card-rows">
            <li v-for="{ key, row } in rows" :key="key" class="nc-context-card-row">
              <span class="nc-context-card-name">{{ row.name }}</span>
              <span class="nc-context-card-pct">{{ row.percentage }}%</span>
            </li>
          </ul>
          <p v-if="usage.estimated" class="nc-context-card-note">
            {{ t('chat.orca.contextUsage.estimated', 'Estimated from the last response.') }}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  </div>
</template>

<style scoped>
.nc-context-ring {
  display: flex;
}
/* flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none
   hover:bg-accent hover:text-foreground focus-visible:ring-2 pointer-coarse:size-11 */
.nc-context-ring-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--nc-muted-foreground);
  outline: none;
  cursor: pointer;
}
.nc-context-ring-button:hover {
  background: var(--nc-accent);
  color: var(--nc-foreground);
}
.nc-context-ring-button:focus-visible {
  box-shadow: 0 0 0 2px var(--nc-ring);
}
@media (pointer: coarse) {
  .nc-context-ring-button {
    width: 44px;
    height: 44px;
  }
}
.nc-context-ring-button--critical,
.nc-context-ring-button--critical:hover {
  color: var(--nc-destructive);
}
.nc-context-ring-svg {
  transform: rotate(-90deg);
}
/* Tessel: the empty part in a neutral grey (not the arc's colour) and square
   ends, so 91 % reads as 91 %, not as a full red ring. */
.nc-context-ring-track {
  color: var(--nc-muted-foreground);
  opacity: 0.35;
}
/* w-72 */
.nc-context-card {
  width: 18rem;
}
/* p-4 */
.nc-context-card-body {
  padding: 16px;
}
/* flex items-baseline justify-between gap-3 text-sm */
.nc-context-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 14px;
  line-height: 20px;
}
.nc-context-card-title {
  color: var(--nc-foreground);
  font-weight: 500;
}
.nc-context-card-count,
.nc-context-card-pct {
  color: var(--nc-muted-foreground);
  font-variant-numeric: tabular-nums;
}
/* mt-2 h-1.5 */
.nc-context-card-progress {
  height: 6px;
  margin-top: 8px;
}
/* mt-3 space-y-1 text-xs */
.nc-context-card-rows {
  margin: 12px 0 0;
  padding: 0;
  font-size: 12px;
  line-height: 16px;
  list-style: none;
}
.nc-context-card-rows > li + li {
  margin-top: 4px;
}
.nc-context-card-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.nc-context-card-name {
  min-width: 0;
  overflow: hidden;
  color: var(--nc-foreground);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-context-card-pct {
  flex-shrink: 0;
}
/* mt-3 text-[11px] text-muted-foreground */
.nc-context-card-note {
  margin: 12px 0 0;
  color: var(--nc-muted-foreground);
  font-size: 11px;
}
</style>
