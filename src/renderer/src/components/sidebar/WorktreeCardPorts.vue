<script setup>
// The plug on a workspace card and its hover card listing the live ports,
// ported from Orca's WorktreeCardPortsTrigger / WorktreeCardPortsDetails
// inside WorktreeCardDetailsHover (sidebar/WorktreeCardPorts.tsx,
// WorktreeCardMeta.tsx; MIT, Copyright (c) 2026 Lovecast Inc.): opens on
// hover after 250 ms (closes 120 ms after leaving), to the right of the card.
import { ref, nextTick, onBeforeUnmount } from 'vue'
import { Plug } from 'lucide-vue-next'
import PortRow from './PortRow.vue'
import { closeOpenHoverCard } from './useHoverCard'
import { t } from '../../i18n'

const props = defineProps({
  ports: { type: Array, required: true }
})
const emit = defineEmits(['open', 'copy', 'stop'])

const open = ref(false)
const trigger = ref(null)
const card = ref(null)
const pos = ref({ left: 0, top: 0 })
let openTimer = null
let closeTimer = null

function place() {
  const el = trigger.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const w = 320
  let left = r.right + 8
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - 8)
  const h = card.value ? card.value.offsetHeight : 120
  const top = Math.min(Math.max(8, r.top - 12), Math.max(8, window.innerHeight - h - 8))
  pos.value = { left, top }
}

function show(delay = 250) {
  clearTimeout(closeTimer)
  clearTimeout(openTimer)
  openTimer = setTimeout(() => {
    // One hover card at a time: the workspace's details card gives way.
    closeOpenHoverCard()
    open.value = true
    nextTick(place)
  }, delay)
}
function hide(delay = 120) {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => (open.value = false), delay)
}
function toggle(e) {
  e.stopPropagation()
  if (open.value) hide(0)
  else show(0)
}
onBeforeUnmount(() => {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
})
</script>

<template>
  <span v-if="ports.length" class="wcp" @mouseenter="show()" @mouseleave="hide()" @click.stop @dblclick.stop>
    <button
      ref="trigger"
      type="button"
      class="wcp-trigger"
      :aria-label="
        ports.length === 1
          ? t('sidebar.ports.liveCount', '{{count}} live port', { count: ports.length })
          : t('sidebar.ports.liveCount', '{{count}} live ports', { count: ports.length })
      "
      :aria-expanded="open"
      @click="toggle"
      @focus="show(0)"
      @blur="hide()"
      @keydown.escape.stop="hide(0)"
    >
      <Plug :size="14" aria-hidden="true" />
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="card"
        class="wcp-card"
        role="dialog"
        :aria-label="t('sidebar.ports.live', 'Live Ports')"
        :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
        @mouseenter="show(0)"
        @mouseleave="hide()"
        @click.stop
        @dblclick.stop
      >
        <section class="wcp-section">
          <div class="wcp-title">
            <Plug :size="12" aria-hidden="true" />
            <span>{{ t('sidebar.ports.live', 'Live Ports') }} <span class="wcp-count">({{ ports.length }})</span></span>
          </div>
          <div class="wcp-content">
            <PortRow
              v-for="p in ports"
              :key="p.id"
              :port="p"
              @open="emit('open', $event)"
              @copy="emit('copy', $event)"
              @stop="emit('stop', $event)"
            />
          </div>
        </section>
      </div>
    </Teleport>
  </span>
</template>
