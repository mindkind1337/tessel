<script setup>
// After Orca's NativeChatAutocompleteMenus.tsx, NativeChatPickerMenu (MIT, Copyright (c) 2026 Lovecast Inc.)
// The "/" picker above the composer: commands, then skills (with loading /
// error / empty states and a polite live summary). The textarea keeps the
// focus: options are chosen on pointer down.
// Props: autocomplete (the slash state from native-chat-composer-state),
//   activeIndex, listboxId. Emits: choose(item), retry().
import { computed, onMounted, shallowRef, watch } from 'vue'
import { Loader2, Package, RotateCcw } from 'lucide-vue-next'
import { t } from '../../../i18n'

const props = defineProps({
  autocomplete: { type: Object, required: true },
  activeIndex: { type: Number, default: 0 },
  listboxId: { type: String, required: true }
})
const emit = defineEmits(['choose', 'retry'])

const rootRef = shallowRef(null)
const commands = computed(() => props.autocomplete.items.filter((item) => item.kind === 'command'))
const skills = computed(() => props.autocomplete.items.filter((item) => item.kind === 'skill'))

function scrollActiveIntoView() {
  const active = rootRef.value?.querySelector('[aria-selected="true"]')
  active?.scrollIntoView?.({ block: 'nearest' })
}
onMounted(scrollActiveIntoView)
watch([() => props.activeIndex, () => props.autocomplete.items], scrollActiveIntoView, { flush: 'post' })

const hasSkillStatus = computed(
  () => props.autocomplete.skillStatus === 'loading' || props.autocomplete.skillStatus === 'error'
)
const showCommandsHeading = computed(() => props.autocomplete.grouped && commands.value.length > 0)
const showSkillsHeading = computed(
  () => props.autocomplete.grouped && (skills.value.length > 0 || hasSkillStatus.value)
)
const noMatches = computed(
  () => props.autocomplete.skillStatus === 'ready' && commands.value.length === 0 && skills.value.length === 0
)
const emptyText = computed(() => (noMatches.value ? getPickerEmptyText(props.autocomplete) : null))
const collision = computed(() => commands.value.find((item) => item.skillCollision))
const duplicate = computed(() => skills.value.find((item) => item.sources.length > 1))

const liveText = computed(() => {
  const a = props.autocomplete
  if (a.skillStatus === 'loading') return t('chat.orca.composer.loadingSkills', 'Loading skills...')
  if (a.skillStatus === 'error') return t('chat.orca.composer.skillsLoadFailed', 'Could not load skills from this host')
  if (emptyText.value) return emptyText.value
  if (!a.skillsEnabled) return ''
  return [
    t('chat.orca.composer.skillsLoaded', 'Skills loaded'),
    collision.value
      ? getPickerAnnotation(collision.value)
      : duplicate.value
        ? getPickerAnnotation(duplicate.value)
        : null
  ]
    .filter(Boolean)
    .join('. ')
})

function getPickerEmptyText(autocomplete) {
  if (!autocomplete.commandsEnabled) return t('chat.orca.composer.noSkills', 'No matching skills')
  if (autocomplete.skillsEnabled) {
    return t('chat.orca.composer.noCommandsOrSkills', 'No matching commands or skills')
  }
  return t('chat.orca.composer.noCommands', 'No matching commands')
}

function getPickerAnnotation(item) {
  if (item.kind === 'command' && item.skillCollision) {
    return t('chat.orca.composer.skillCommandCollision', 'Also a skill name - agent decides')
  }
  if (item.kind === 'skill' && item.sources.length > 1) {
    // Why: `sourceCount`, not `count` — a `count` option would look up plural keys.
    return t('chat.orca.composer.skillMultipleSources', '{{sourceCount}} sources - agent resolves', {
      sourceCount: item.sources.length
    })
  }
  return null
}

function scopeLabel(sourceKind) {
  const labels = {
    repo: t('chat.orca.composer.skillScopeProject', 'Project'),
    home: t('chat.orca.composer.skillScopePersonal', 'Personal'),
    bundled: t('chat.orca.composer.skillScopeBuiltIn', 'Built-in'),
    plugin: t('chat.orca.composer.skillScopePlugin', 'Plugin')
  }
  return sourceKind ? (labels[sourceKind] ?? '') : ''
}

// Commands come first, so a skill's option index follows them.
const rows = computed(() => [
  ...commands.value.map((item, index) => ({ item, index })),
  ...skills.value.map((item, index) => ({ item, index: commands.value.length + index }))
])
const commandRows = computed(() => rows.value.filter((row) => row.item.kind === 'command'))
const skillRows = computed(() => rows.value.filter((row) => row.item.kind === 'skill'))

function choose(event, item) {
  // Why: the textarea owns query and caret state, so pointer acceptance
  // must run before the browser transfers focus to this row.
  event.preventDefault()
  emit('choose', item)
}
</script>

<template>
  <div :id="listboxId" ref="rootRef" role="listbox" class="nc-picker nc-ui-scrollbar-sleek">
    <div v-if="showCommandsHeading" class="nc-picker-heading">
      {{ t('chat.orca.composer.commands', 'Commands') }}
    </div>
    <template v-for="row in commandRows" :key="row.item.id">
      <button
        :id="`${listboxId}-option-${row.index}`"
        role="option"
        :aria-selected="row.index === activeIndex"
        type="button"
        :class="['nc-picker-option', { 'nc-picker-option--selected': row.index === activeIndex }]"
        @pointerdown="choose($event, row.item)"
      >
        <span class="nc-picker-option-body">
          <span class="nc-picker-option-line">
            <span class="nc-picker-token">{{ row.item.token }}</span>
            <span v-if="row.item.argumentHint" class="nc-picker-hint">{{ row.item.argumentHint }}</span>
          </span>
          <span v-if="row.item.description" class="nc-picker-description">{{ row.item.description }}</span>
          <span v-if="getPickerAnnotation(row.item)" class="nc-picker-annotation">{{ getPickerAnnotation(row.item) }}</span>
        </span>
      </button>
    </template>
    <div v-if="showSkillsHeading" class="nc-picker-heading">
      {{ t('chat.orca.composer.skills', 'Skills') }}
    </div>
    <div v-if="autocomplete.skillStatus === 'loading'" class="nc-picker-status">
      <Loader2 class="nc-picker-status-spinner nc-animate-spin" />
      {{ t('chat.orca.composer.loadingSkills', 'Loading skills...') }}
    </div>
    <div v-if="autocomplete.skillStatus === 'error'" class="nc-picker-status">
      <span class="nc-picker-status-text">
        {{
          autocomplete.skillErrorKind === 'unavailable'
            ? t('chat.orca.composer.skillsUnavailableHost', 'Skills are unavailable for this host')
            : t('chat.orca.composer.skillsLoadFailed', 'Could not load skills from this host')
        }}
      </span>
      <button
        v-if="autocomplete.skillErrorKind !== 'unavailable'"
        type="button"
        class="nc-picker-retry"
        @pointerdown.prevent
        @click="emit('retry')"
      >
        <RotateCcw class="nc-picker-retry-icon" />
        {{ t('chat.orca.composer.retrySkills', 'Retry') }}
      </button>
    </div>
    <template v-for="row in skillRows" :key="row.item.id">
      <button
        :id="`${listboxId}-option-${row.index}`"
        role="option"
        :aria-selected="row.index === activeIndex"
        type="button"
        :class="['nc-picker-option', { 'nc-picker-option--selected': row.index === activeIndex }]"
        @pointerdown="choose($event, row.item)"
      >
        <Package class="nc-picker-skill-icon" />
        <span class="nc-picker-option-body">
          <span class="nc-picker-option-line">
            <span class="nc-picker-token">{{ row.item.token }}</span>
          </span>
          <span v-if="row.item.description" class="nc-picker-description">{{ row.item.description }}</span>
          <span v-if="getPickerAnnotation(row.item)" class="nc-picker-annotation">{{ getPickerAnnotation(row.item) }}</span>
        </span>
        <span class="nc-picker-scope">{{ scopeLabel(row.item.sources[0]?.sourceKind) }}</span>
      </button>
    </template>
    <div v-if="noMatches" class="nc-picker-status">{{ emptyText }}</div>
    <div aria-live="polite" class="nc-ui-sr-only">{{ liveText }}</div>
  </div>
</template>

<style scoped>
/* scrollbar-sleek absolute bottom-full left-0 right-0 z-20 mb-1 max-h-72 overflow-y-auto
   rounded-lg border border-border bg-popover p-1 text-popover-foreground
   shadow-[0_10px_24px_rgba(0,0,0,0.18)] */
.nc-picker {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  z-index: 20;
  margin-bottom: 4px;
  max-height: 288px;
  overflow-y: auto;
  box-sizing: border-box;
  border: 1px solid var(--nc-border);
  border-radius: 8px;
  background: var(--nc-popover);
  padding: 4px;
  color: var(--nc-popover-foreground);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
}
/* px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground */
.nc-picker-heading {
  padding: 6px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--nc-muted-foreground);
}
/* flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground */
.nc-picker-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
.nc-picker-status-spinner {
  width: 14px;
  height: 14px;
}
.nc-picker-status-text {
  min-width: 0;
  flex: 1 1 0%;
}
/* flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-foreground
   hover:bg-accent hover:text-accent-foreground */
.nc-picker-retry {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  padding: 2px 6px;
  font: inherit;
  color: var(--nc-foreground);
  cursor: pointer;
}
.nc-picker-retry:hover {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-picker-retry-icon {
  width: 12px;
  height: 12px;
}
/* flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-1.5
   text-left text-[13px] hover:bg-accent hover:text-accent-foreground
   (selected: border-border bg-accent text-accent-foreground) */
.nc-picker-option {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 8px;
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  padding: 6px 8px;
  text-align: left;
  font: inherit;
  font-size: 13px;
  color: inherit;
  cursor: pointer;
}
.nc-picker-option:hover {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-picker-option--selected {
  border-color: var(--nc-border);
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
/* mt-0.5 size-3.5 shrink-0 text-muted-foreground */
.nc-picker-skill-icon {
  margin-top: 2px;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--nc-muted-foreground);
}
.nc-picker-option-body {
  min-width: 0;
  flex: 1 1 0%;
}
/* flex min-w-0 items-baseline gap-1.5 */
.nc-picker-option-line {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 6px;
}
/* min-w-0 truncate font-mono font-medium */
.nc-picker-token {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-weight: 500;
}
/* min-w-0 truncate font-mono text-[11px] text-muted-foreground */
.nc-picker-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
/* block truncate text-xs text-muted-foreground */
.nc-picker-description {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
/* block truncate text-[11px] text-muted-foreground */
.nc-picker-annotation {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
/* shrink-0 pt-0.5 text-[11px] text-muted-foreground */
.nc-picker-scope {
  flex-shrink: 0;
  padding-top: 2px;
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
</style>
