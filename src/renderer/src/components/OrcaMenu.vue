<script setup>
// A dropdown / context menu drawn like Orca's (its shadcn DropdownMenu:
// src/renderer/src/components/ui/dropdown-menu.tsx; Orca is MIT, Copyright
// (c) 2026 Lovecast Inc.): labels, items with a lucide icon, separators,
// radio and checkbox items, switch rows (Orca's FilterToggleRow), a
// segmented toggle (SidebarGroupByToggle) and sub-menus that open on hover.
//
// items: [{ type: 'label' | 'separator' | 'item' | 'radio' | 'checkbox' |
//   'switch' | 'segmented' | 'header' | 'sub', label, hint, icon, danger,
//   disabled, checked, indented, description, title, options, value,
//   children, onSelect, keepOpen }]
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { Check, ChevronRight } from 'lucide-vue-next'

defineOptions({ name: 'OrcaMenu' })

const props = defineProps({
  open: { type: Boolean, default: false },
  // Where it opens: a point { x, y } or a rect { left, top, right, bottom }.
  anchor: { type: Object, default: null },
  side: { type: String, default: 'bottom' }, // 'bottom' | 'top' | 'right'
  align: { type: String, default: 'start' }, // 'start' | 'end'
  offset: { type: Number, default: 6 },
  width: { type: [Number, String], default: null },
  items: { type: Array, default: () => [] },
  label: { type: String, default: 'Menu' },
  nested: { type: Boolean, default: false }
})
const emit = defineEmits(['close'])

const el = ref(null)
const pos = ref({ left: -9999, top: -9999 })
const sub = ref(null) // { index, rect }
let subTimer = null

const style = computed(() => {
  const s = { left: pos.value.left + 'px', top: pos.value.top + 'px' }
  if (props.width) s.width = typeof props.width === 'number' ? props.width + 'px' : props.width
  return s
})

function rectOf(a) {
  if (!a) return { left: 0, top: 0, right: 0, bottom: 0 }
  if (typeof a.x === 'number' && a.left === undefined) return { left: a.x, top: a.y, right: a.x, bottom: a.y }
  return a
}

function place() {
  const menu = el.value
  if (!menu) return
  const r = rectOf(props.anchor)
  const w = menu.offsetWidth
  const h = menu.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left
  let top
  if (props.side === 'right') {
    left = r.right + props.offset
    top = props.align === 'end' ? r.bottom - h : r.top - 4
    if (left + w > vw - 8) left = Math.max(8, r.left - w - props.offset)
  } else {
    left = props.align === 'end' ? r.right - w : r.left
    top = props.side === 'top' ? r.top - h - props.offset : r.bottom + props.offset
    if (props.side !== 'top' && top + h > vh - 8) top = Math.max(8, r.top - h - props.offset)
    if (props.side === 'top' && top < 8) top = r.bottom + props.offset
  }
  left = Math.min(Math.max(8, left), Math.max(8, vw - w - 8))
  top = Math.min(Math.max(8, top), Math.max(8, vh - h - 8))
  pos.value = { left, top }
}

watch(
  () => [props.open, props.anchor, props.items],
  () => {
    if (props.open) nextTick(place)
    else sub.value = null
  },
  { immediate: true, deep: false }
)

function close() {
  sub.value = null
  emit('close')
}

function select(item) {
  if (item.disabled) return
  if (item.type === 'sub') return
  if (item.onSelect) item.onSelect(item)
  if (!item.keepOpen && !['radio', 'checkbox', 'switch', 'segmented'].includes(item.type)) close()
}

function openSub(index, e) {
  clearTimeout(subTimer)
  const rect = e.currentTarget.getBoundingClientRect()
  sub.value = { index, rect }
}
function hoverItem(index, item, e) {
  clearTimeout(subTimer)
  if (item.type === 'sub') {
    const rect = e.currentTarget.getBoundingClientRect()
    subTimer = setTimeout(() => (sub.value = { index, rect }), 80)
  } else if (sub.value) {
    subTimer = setTimeout(() => (sub.value = null), 150)
  }
}

function onDocDown(e) {
  if (!props.open || props.nested) return
  if (e.target && e.target.closest && e.target.closest('.orca-menu')) return
  close()
}
function onDocKey(e) {
  if (!props.open || props.nested) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const buttons = [...(el.value?.querySelectorAll('[data-orca-menu-item]:not([disabled])') || [])]
    if (!buttons.length) return
    e.preventDefault()
    const at = buttons.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length
    buttons[next].focus()
  }
}
onMounted(() => {
  window.addEventListener('pointerdown', onDocDown, true)
  window.addEventListener('keydown', onDocKey, true)
  window.addEventListener('resize', close)
})
onBeforeUnmount(() => {
  clearTimeout(subTimer)
  window.removeEventListener('pointerdown', onDocDown, true)
  window.removeEventListener('keydown', onDocKey, true)
  window.removeEventListener('resize', close)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="el"
      class="orca-menu"
      role="menu"
      :aria-label="label"
      :style="style"
      @contextmenu.prevent
    >
      <template v-for="(item, i) in items" :key="i">
        <div v-if="item.type === 'label'" class="orca-menu-label" :class="item.className">
          {{ item.label }}
        </div>
        <div v-else-if="item.type === 'header'" class="orca-menu-label orca-menu-header">
          <span>{{ item.label }}</span>
          <span class="orca-menu-header-hint">{{ item.hint }}</span>
        </div>
        <div v-else-if="item.type === 'separator'" class="orca-menu-sep" role="separator"></div>
        <div v-else-if="item.type === 'segmented'" class="orca-menu-seg-wrap">
          <div class="orca-seg" role="group" :aria-label="item.label">
            <button
              v-for="o in item.options"
              :key="o.id"
              type="button"
              class="orca-seg-item"
              :class="{ on: item.value === o.id }"
              :aria-pressed="item.value === o.id"
              @click="item.onChange && item.onChange(o.id)"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
        <button
          v-else-if="item.type === 'switch'"
          type="button"
          role="switch"
          class="orca-filter-row"
          :class="{ indented: item.indented }"
          :aria-checked="!!item.checked"
          :aria-label="item.ariaLabel || item.label"
          data-orca-menu-item
          @click="item.onChange && item.onChange(!item.checked)"
        >
          <span class="orca-filter-row-label" :class="{ dim: item.indented }">
            <component :is="item.icon" v-if="item.icon" class="orca-filter-row-icon" :size="14" aria-hidden="true" />
            {{ item.label }}
          </span>
          <span class="orca-switch" :class="{ on: item.checked }" aria-hidden="true"><span></span></span>
        </button>
        <button
          v-else
          type="button"
          class="orca-menu-item"
          :class="{
            danger: item.danger,
            indicator: item.type === 'radio' || item.type === 'checkbox',
            open: sub && sub.index === i,
            tall: !!item.description
          }"
          :role="item.type === 'radio' ? 'menuitemradio' : item.type === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'"
          :aria-checked="item.type === 'radio' || item.type === 'checkbox' ? !!item.checked : undefined"
          :aria-haspopup="item.type === 'sub' ? 'menu' : undefined"
          :disabled="item.disabled"
          :title="item.title || undefined"
          data-orca-menu-item
          @click="item.type === 'sub' ? openSub(i, $event) : select(item)"
          @mouseenter="hoverItem(i, item, $event)"
        >
          <span v-if="item.type === 'radio'" class="orca-menu-indicator" aria-hidden="true">
            <span v-if="item.checked" class="orca-menu-radio-dot"></span>
          </span>
          <span v-else-if="item.type === 'checkbox'" class="orca-menu-indicator" aria-hidden="true">
            <Check v-if="item.checked" :size="14" />
          </span>
          <component :is="item.icon" v-if="item.icon" class="orca-menu-icon" :size="14" aria-hidden="true" />
          <span v-if="item.description" class="orca-menu-two-line">
            <span>{{ item.label }}</span>
            <span class="orca-menu-desc">{{ item.description }}</span>
          </span>
          <span v-else class="orca-menu-text">{{ item.label }}</span>
          <span v-if="item.hint" class="orca-menu-hint">{{ item.hint }}</span>
          <ChevronRight v-if="item.type === 'sub'" class="orca-menu-chevron" :size="14" aria-hidden="true" />
        </button>
      </template>
      <OrcaMenu
        v-if="sub && items[sub.index] && items[sub.index].children"
        :open="true"
        nested
        side="right"
        :offset="2"
        :anchor="sub.rect"
        :width="items[sub.index].width || null"
        :items="items[sub.index].children"
        :label="items[sub.index].label"
        @close="close"
      />
    </div>
  </Teleport>
</template>
