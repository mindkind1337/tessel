<script setup>
// After Orca's use-native-chat-context-menu.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// The chat's right-click menu, opened where the pointer is: Copy (the text
// selected in the chat, or the last selection made there), Paste (into the
// composer), then the pane's own actions as Tessel has them (split right or
// down, maximize or restore, continue in a terminal, close).
// Props: rootEl (the chat's root, whose selection counts), enabled (a
//   hidden pane shows no menu), actions { onPaste, onSplitRight, onSplitDown,
//   isPaneExpanded, onToggleExpand, onSwitchToTerminal?, onClosePane? }.
// Exposed: onContextMenu(event) (bind it on the root, capture phase),
//   rememberSelection() (on mouseup/keyup: the selection a right-click would
//   otherwise clear).
import { computed, onBeforeUnmount, onMounted, reactive, watch } from 'vue'
import PaneContextMenu from '../../PaneContextMenu.vue'
import { isMacPlatform } from '../../../chat/orca/native-chat-shortcut.js'
import { t } from '../../../i18n'

const props = defineProps({
  rootEl: { type: Object, default: null },
  enabled: { type: Boolean, default: true },
  actions: { type: Object, default: () => ({}) }
})

const state = reactive({ open: false, x: 0, y: 0, selectedText: '' })
let lastSelectedText = ''

const copyShortcut = computed(() => (isMacPlatform() ? '⌘C' : 'Ctrl+C')) // i18n-ignore key names
const canCopy = computed(() => state.selectedText.trim().length > 0)
const triggerStyle = computed(() => ({ left: `${state.x}px`, top: `${state.y}px` }))

function selectedIn(root) {
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed) return ''
  if (!selection.anchorNode || !selection.focusNode) return ''
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return ''
  return selection.toString()
}
function rememberSelection() {
  const text = selectedIn(props.rootEl)
  if (text.trim().length > 0) lastSelectedText = text
}

function onContextMenu(event) {
  if (!props.enabled) return
  event.preventDefault()
  event.stopPropagation()
  state.selectedText = selectedIn(props.rootEl) || lastSelectedText
  state.x = event.clientX
  state.y = event.clientY
  state.open = true
}
watch(
  () => props.enabled,
  (enabled) => {
    if (!enabled) state.open = false
  }
)

function copy() {
  state.open = false
  const text = state.selectedText
  if (!text.trim()) return
  if (window.shellApi && typeof window.shellApi.writeClipboard === 'function') window.shellApi.writeClipboard(text)
  else if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {})
}
function run(name) {
  state.open = false
  const action = props.actions && props.actions[name]
  if (typeof action === 'function') action({ left: state.x, bottom: state.y })
}

onMounted(() => document.addEventListener('selectionchange', rememberSelection))
onBeforeUnmount(() => document.removeEventListener('selectionchange', rememberSelection))

defineExpose({ onContextMenu, rememberSelection })
</script>

<template>
  <Teleport to="body">
    <PaneContextMenu v-if="enabled && state.open" :title="actions.title" :style="triggerStyle" data-test="chat-context-menu" @close="state.open = false">
      <div v-if="actions.title" class="ctx-menu-header"><span class="ctx-menu-title">{{ actions.title }}</span></div>
      <div v-if="actions.facts?.length" class="ctx-menu-facts" data-test="pane-menu-facts">
        <div v-for="fact in actions.facts" :key="fact.label" class="ctx-menu-fact"><span class="ctx-fact-label">{{ fact.label }}</span><span class="ctx-fact-value">{{ fact.value }}</span></div>
      </div>
      <div class="ctx-menu-sep" />
      <button class="ctx-menu-item" :disabled="!canCopy" @click="copy">{{ t('pane.menu.copy', 'Copy') }}<span class="ctx-menu-shortcut">{{ copyShortcut }}</span></button>
      <button class="ctx-menu-item" @click="run('onPaste')">{{ t('pane.menu.paste', 'Paste') }}</button>
      <button v-if="actions.onCopySession" class="ctx-menu-item" @click="run('onCopySession')">{{ t('pane.menu.copySession', 'Copy session ID') }}</button>
      <button v-if="actions.onModel" class="ctx-menu-item" data-test="pane-model" @click="run('onModel')">{{ t('pane.menu.model', 'Model…') }}<span class="ctx-menu-shortcut ctx-menu-model">{{ actions.model }}</span></button>
      <div class="ctx-menu-sep" />
      <template v-if="actions.onToggleLead || actions.onLeaveTeam">
        <button v-if="actions.onToggleLead" class="ctx-menu-item" @click="run('onToggleLead')">{{ actions.leadLabel }}</button>
        <button v-if="actions.onLeaveTeam" class="ctx-menu-item" @click="run('onLeaveTeam')">{{ actions.leaveLabel }}</button>
        <div class="ctx-menu-sep" />
      </template>
      <button v-if="actions.onRename" class="ctx-menu-item" @click="run('onRename')">{{ t('pane.menu.rename', 'Rename') }}</button>
      <button v-if="actions.onToggleExpand" class="ctx-menu-item" @click="run('onToggleExpand')">{{ actions.isPaneExpanded ? t('pane.restore', 'Restore pane') : t('pane.maximize', 'Maximize pane') }}</button>
      <button v-if="actions.onOpenHere" class="ctx-menu-item" @click="run('onOpenHere')">{{ t('pane.menu.openHere', 'Open terminal or agent here…') }}</button>
      <button class="ctx-menu-item" @click="run('onSplitRight')">{{ t('pane.menu.splitRight', 'Split right') }}</button>
      <button class="ctx-menu-item" @click="run('onSplitDown')">{{ t('pane.menu.splitDown', 'Split down') }}</button>
      <div class="ctx-menu-sep" />
      <button v-if="actions.onRestart" class="ctx-menu-item" @click="run('onRestart')">{{ t('pane.restart', 'Restart') }}</button>
      <button v-if="actions.onSwitchToTerminal" class="ctx-menu-item" @click="run('onSwitchToTerminal')">{{ t('chat.orca.contextMenu.switchToTerminal', 'Continue in a terminal') }}</button>
      <button v-if="actions.onClosePane" class="ctx-menu-item danger" @click="run('onClosePane')">{{ t('pane.close', 'Close pane') }}</button>
    </PaneContextMenu>
  </Teleport>
</template>
