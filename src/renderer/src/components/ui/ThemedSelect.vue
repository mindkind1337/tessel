<script setup>
// Theme-owned listbox, following the trigger/portal/checked-item structure of
// Orca's Select (MIT, Copyright (c) 2026 Lovecast Inc.). Option slots remain
// declarative data: their native option nodes are never mounted in the DOM.
import {
  computed,
  ref,
  useAttrs,
  useId,
  useSlots,
  nextTick,
  onMounted,
  onBeforeUnmount,
  watch
} from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'
defineOptions({ inheritAttrs: false })
const props = defineProps({
  modelValue: { default: undefined },
  value: { default: undefined },
  modelModifiers: { default: () => ({}) },
  disabled: Boolean
})
const emit = defineEmits(['update:modelValue', 'change'])
const attrs = useAttrs(),
  slots = useSlots(),
  id = useId() // i18n-ignore
const trigger = ref(null),
  popup = ref(null),
  open = ref(false),
  active = ref(-1),
  placement = ref({}),
  labelId = ref(null)
let search = '',
  searchTimer
const textOf = (node) =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join('')
      : node?.children
        ? textOf(node.children)
        : ''
const yes = (value) => value === '' || value === true
const groups = computed(() => {
  const result = [],
    flat = []
  function walk(nodes, group = null, disabled = false) {
    for (const node of nodes || []) {
      if (!node || typeof node !== 'object') continue
      if (node.type === 'optgroup') {
        const entry = { label: node.props?.label || '', options: [] }
        result.push(entry)
        walk(node.children, entry, disabled || yes(node.props?.disabled))
      } else if (node.type === 'option') {
        let entry = group
        if (!entry) {
          entry = result.at(-1)
          if (!entry || entry.label) {
            entry = { label: '', options: [] }
            result.push(entry)
          }
        }
        const label = textOf(node.children).trim()
        const option = {
          value: node.props?.value ?? label,
          label,
          disabled: disabled || yes(node.props?.disabled),
          selected: yes(node.props?.selected),
          title: node.props?.title,
          index: flat.length
        }
        entry.options.push(option)
        flat.push(option)
      } else if (Array.isArray(node.children)) walk(node.children, group, disabled)
    }
  }
  walk(slots.default?.())
  return { groups: result, options: flat }
})
const options = computed(() => groups.value.options)
const selected = computed(() => {
  const value = props.modelValue !== undefined ? props.modelValue : props.value
  return value !== undefined
    ? options.value.find((o) => String(o.value) === String(value))
    : options.value.find((o) => o.selected) || options.value[0]
})
const optionId = (index) => `${id}-option-${index}` // i18n-ignore
function close() {
  open.value = false
  search = ''
  clearTimeout(searchTimer)
}
function reveal() {
  nextTick(() =>
    document.getElementById(optionId(active.value))?.scrollIntoView?.({ block: 'nearest' })
  )
}
async function show(edge) {
  if (props.disabled || open.value) return
  active.value =
    edge === 'first'
      ? options.value.findIndex((o) => !o.disabled)
      : edge === 'last'
        ? options.value.findLastIndex((o) => !o.disabled)
        : selected.value && !selected.value.disabled
          ? selected.value.index
          : options.value.findIndex((o) => !o.disabled)
  const r = trigger.value.getBoundingClientRect(),
    below = innerHeight - r.bottom - 8,
    above = r.top - 8
  const up = below < 240 && above > below,
    space = Math.max(0, up ? above : below)
  placement.value = {
    left: `${Math.max(8, Math.min(r.left, innerWidth - Math.min(Math.max(r.width, 240), innerWidth - 16) - 8))}px`,
    width: `${Math.min(Math.max(r.width, 240), innerWidth - 16)}px`,
    minWidth: `${Math.min(r.width, innerWidth - 16)}px`,
    maxWidth: `${innerWidth - 16}px`,
    maxHeight: `${Math.min(320, space)}px`,
    ...(up ? { bottom: `${innerHeight - r.top + 4}px` } : { top: `${r.bottom + 4}px` })
  }
  open.value = true
  await nextTick()
  reveal()
}
function choose(option) {
  if (!option || option.disabled || props.disabled) return
  let value = option.value
  if (props.modelModifiers.number && value !== '' && !Number.isNaN(Number(value)))
    value = Number(value)
  emit('update:modelValue', value)
  emit('change', { target: { value: String(value) } })
  close()
  trigger.value?.focus()
}
function move(direction) {
  for (let i = active.value + direction; i >= 0 && i < options.value.length; i += direction) {
    if (!options.value[i].disabled) {
      active.value = i
      reveal()
      return
    }
  }
}
function onKey(event) {
  if (props.disabled) return
  const key = event.key
  if (key === 'Tab') {
    close()
    return
  }
  if (key === 'Escape') {
    if (open.value) {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    return
  }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
    event.preventDefault()
    event.stopPropagation()
    if (!open.value) {
      show(key === 'ArrowUp' || key === 'End' ? 'last' : key === 'Home' ? 'first' : undefined)
      return
    }
    if (key === 'Enter' || key === ' ') {
      choose(options.value[active.value])
      return
    }
    if (key === 'Home' || key === 'End') {
      active.value =
        key === 'Home'
          ? options.value.findIndex((o) => !o.disabled)
          : options.value.findLastIndex((o) => !o.disabled)
      reveal()
    } else move(key === 'ArrowDown' ? 1 : -1)
  } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    event.stopPropagation()
    show()
    search += key.toLocaleLowerCase()
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      search = ''
    }, 700)
    const needle = [...search].every((c) => c === search[0]) ? search[0] : search
    const start = needle.length === 1 ? active.value + 1 : active.value
    for (let n = 0; n < options.value.length; n++) {
      const i = (Math.max(start, 0) + n) % options.value.length
      const option = options.value[i]
      if (!option.disabled && option.label.toLocaleLowerCase().startsWith(needle)) {
        active.value = i
        reveal()
        break
      }
    }
  }
}
function outside(e) {
  if (!trigger.value?.contains(e.target) && !popup.value?.contains(e.target)) close()
}
function scroll(e) {
  if (!popup.value?.contains(e.target)) close()
}
watch(
  () => props.disabled,
  (value) => {
    if (value) close()
  }
)
watch(options, (list) => {
  if (open.value && (!list[active.value] || list[active.value].disabled))
    active.value = list.findIndex((o) => !o.disabled)
})
onMounted(() => {
  const label =
    trigger.value.closest('label') ||
    (attrs.id &&
      Array.from(document.querySelectorAll('label[for]')).find(
        (label) => label.htmlFor === attrs.id
      ))
  if (label) {
    if (!label.id) label.id = `${id}-label` // i18n-ignore
    labelId.value = label.id
  } // i18n-ignore
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('scroll', scroll, true)
  window.addEventListener('resize', close)
})
onBeforeUnmount(() => {
  close()
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('scroll', scroll, true)
  window.removeEventListener('resize', close)
})
</script>
<template>
  <button
    ref="trigger"
    v-bind="attrs"
    :id="attrs.id || `${id}-trigger`"
    type="button"
    :value="selected?.value"
    class="ts-select"
    role="combobox"
    :disabled="disabled"
    :aria-label="attrs['aria-label'] || (!labelId ? attrs.title : undefined)"
    :aria-labelledby="attrs['aria-labelledby'] || (!attrs['aria-label'] ? labelId : undefined)"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="open ? id : undefined"
    :aria-activedescendant="open && active >= 0 ? optionId(active) : undefined"
    @click="open ? close() : show()"
    @keydown="onKey"
  >
    <span class="ts-select-value">{{ selected?.label || '\u00a0' }}</span
    ><ChevronDown :size="14" aria-hidden="true" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      :id="id"
      :data-select-owner="attrs.id || `${id}-trigger`"
      ref="popup"
      class="ts-select-popup"
      :style="placement"
      role="listbox"
      :aria-labelledby="attrs.id || `${id}-trigger`"
      @pointerdown.prevent
      @keydown="onKey"
    >
      <div
        v-for="(group, index) in groups.groups"
        :key="index"
        :role="group.label ? 'group' : 'presentation'"
        :aria-label="group.label || undefined"
      >
        <div v-if="group.label" class="ts-select-group" aria-hidden="true">{{ group.label }}</div>
        <div
          v-for="option in group.options"
          :id="optionId(option.index)"
          :key="option.index"
          role="option"
          :aria-selected="option === selected"
          :aria-disabled="option.disabled"
          :data-value="String(option.value)"
          :title="option.title"
          class="ts-select-option"
          :class="{ active: active === option.index, disabled: option.disabled }"
          @pointermove="!option.disabled && (active = option.index)"
          @click.stop="choose(option)"
        >
          <span>{{ option.label }}</span
          ><Check v-if="option === selected" :size="14" aria-hidden="true" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
<style>
.ts-select {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 6px;
  padding: 5px 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ts-select-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.ts-select > svg {
  flex-shrink: 0;
  color: var(--text-dim);
}
.ts-select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.ts-select:disabled {
  opacity: 0.5;
  cursor: default;
}
.ts-select-popup {
  position: fixed;
  z-index: 2147483000;
  box-sizing: border-box;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 4px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 8px;
  background: var(--surface-2, var(--surface));
  color: var(--text);
  box-shadow: 0 12px 30px #0005;
  font: 12px/1.4 var(--font-ui, 'Segoe UI', sans-serif);
}
.ts-select-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.ts-select-option > span {
  overflow-wrap: anywhere;
  min-width: 0;
}
.ts-select-option > svg {
  flex-shrink: 0;
}
.ts-select-option.active:not(.disabled) {
  background: var(--surface-3, var(--surface));
}
.ts-select-option.disabled {
  opacity: 0.45;
  cursor: default;
}
.ts-select-group {
  padding: 6px 8px;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 600;
}
</style>
